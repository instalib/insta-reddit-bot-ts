import { IgApiClient } from "instagram-private-api";
import { UserFeedResponseItemsItem } from "instagram-private-api/dist/responses";
import inquirer from "inquirer";
import Jimp from "jimp";
import snoowrap from "snoowrap";
import { createLogger, format, transports } from "winston";

const { splat, colorize, label, combine, timestamp, printf } = format;

const logFormat = printf(({ level, message, label, timestamp }) => {
	return `${timestamp} [${label}] ${level}: ${message}`;
});

function createLoggerConfiguration(loggerName): object {
	return {
		format: combine(
			colorize(),
			label({ label: loggerName }),
			timestamp(),
			splat(),
			logFormat
		),
		transports: [new transports.Console()]
	};
}

const botLogger = createLogger(createLoggerConfiguration("Bot"));

console.log("Instagram-Reddit-Bot created by Almog Hamdani ©\n");

botLogger.info("Reading settings..");

const igUsername = process.env.IG_USERNAME;
const igPassword = process.env.IG_PASSWORD;

const reddit_settings = {
	userAgent: process.env.RD_USER_AGENT,
	clientId: process.env.RD_CLIENT_ID,
	clientSecret: process.env.RD_CLIENT_SECRECT,
	refreshToken: process.env.RD_REFRESH_TOKEN
};

const subreddits = process.env.SUBREDDITS.split(" ");
const tags = process.env.TAGS.split(" ").map(tag => "#" + tag);

const fetchSubredditsPostsTime = Number.parseInt(
	process.env.FETCH_SUBREDDITS_TIME
);
const subredditPostFetch = Number.parseInt(process.env.SUBREDDIT_POST_FETCH);
const uploadPostsTime = Number.parseInt(process.env.UPLOAD_POSTS_TIME);
const postsAmountPerUpload = Number.parseInt(
	process.env.POSTS_AMOUNT_PER_UPLOAD
);
const cleanPostsCacheDays = Number.parseInt(process.env.CLEAN_CACHE_DAYS);

const followTagName = process.env.FOLLOW_TAG;
const followAmountOfLikes = followTagName
	? Number.parseInt(process.env.FOLLOW_AMOUNT_OF_LIKES)
	: 0;

botLogger.info("Instagram Username: %s.", igUsername);
botLogger.info("Reddit User Agent: %s.", reddit_settings.userAgent);
botLogger.info("Reddit Client ID: %s.", reddit_settings.clientId);
botLogger.info("Subreddits: %s.", subreddits.join(", "));
botLogger.info("Tags: %s.", tags.join(", "));
botLogger.info(
	"Fetching %d posts from each subreddit every %d minutes.",
	subredditPostFetch,
	fetchSubredditsPostsTime
);
botLogger.info(
	"Uploading %d posts every %d minutes.",
	postsAmountPerUpload,
	uploadPostsTime
);
botLogger.info("Cleaning cache every %d days.", cleanPostsCacheDays);
botLogger.info("Following Tag: #%s.", followTagName ? followTagName : "No");
if (followTagName) {
	botLogger.info(
		"Follower - Amount of likes per user: %d.",
		followAmountOfLikes
	);
}
botLogger.info("Reading settings done..\n");

const ig = new IgApiClient();
const r = new snoowrap(reddit_settings);

var submissionCache = new Array<String>();

var postsQueue = new Array<snoowrap.Submission>();

// Generate device
ig.state.generateDevice(igUsername);

async function fitImageToAspecRatio(img: string): Promise<Buffer> {
	const image = await Jimp.read(img);
	const newImageSize = Math.max(image.bitmap.height, image.bitmap.width);

	// Contain the image in a 4:3 image
	image.contain(newImageSize, newImageSize);

	// Convert to buffer
	var buf;
	await image
		.rgba(false)
		.background(0xffffffff)
		.getBuffer(Jimp.MIME_JPEG, (_, b) => {
			buf = b;
		});

	return buf;
}

async function fetchNewPosts() {
	const logger = createLogger(
		createLoggerConfiguration("Reddit Subreddit Fetcher")
	);

	var newPosts = new Array<snoowrap.Submission>();

	logger.info("Fetching posts..");

	for await (const subreddit of subreddits) {
		logger.info("Fetching subreddit r/" + subreddit + "..");

		// Get hot posts
		var hotPosts = await r.getSubreddit(subreddit).getHot();

		// Remove all used submissions
		var hotPostsList = hotPosts.filter(
			submission => !submissionCache.includes(submission.id)
		);

		// Sort the submissions by their upvotes
		hotPostsList = hotPostsList.sort((a, b) => (a.ups > b.ups ? -1 : 1));

		// Take only the top
		hotPostsList = hotPostsList.splice(0, subredditPostFetch);

		// Add all new submissions to the new posts array
		newPosts = newPosts.concat(hotPostsList);
	}

	// Shuffle the new posts
	newPosts.sort(() => Math.random() - 0.5);

	// Save all the new posts to the submission cache
	submissionCache = submissionCache.concat(newPosts.map(post => post.id));

	// Add the new submissions to the queue
	postsQueue = postsQueue.concat(newPosts);

	logger.info("Finished fetching posts..");
}

function createCaption(post: snoowrap.Submission) {
	return (
		(post.title ? post.title + " " : "Title goes here.. ") +
		"\n\u2063\n\u2063\n\u2063\nUploaded to " +
		post.subreddit_name_prefixed +
		" by u/" +
		post.author.name +
		"\n\u2063\n" +
		tags.join(" ")
	);
}

async function uploadPosts() {
	const logger = createLogger(
		createLoggerConfiguration("Instagram Post Uploader")
	);

	let newPosts;

	try {
		newPosts = [...Array(postsAmountPerUpload)].map(_ => postsQueue.shift());
	} catch {
		logger.info("Unable to get new posts to upload..");
		return;
	}

	// For each new post, upload it
	logger.info("Starting to upload..");
	for (const newPost of newPosts) {
		if (newPost.url && !newPost.is_video && !newPost.selftext) {
			try {
				await ig.publish.photo({
					file: await fitImageToAspecRatio(newPost.url),
					caption: createCaption(newPost)
				});

				logger.info(
					"[" +
						(newPosts.indexOf(newPost) + 1) +
						"/" +
						newPosts.length +
						"] Uploaded submission " +
						newPost.id
				);
			} catch (ex) {
				logger.error(
					"An error occurred during the upload of the submission " +
						newPost.id +
						". The error was: " +
						ex
				);
			}
		} else {
			logger.info(
				"[" +
					(newPosts.indexOf(newPost) + 1) +
					"/" +
					newPosts.length +
					"] Ignoring submission " +
					newPost.id
			);
		}
	}

	logger.info("Finished uploading posts..");
}

async function likePosts(username: string, userPk: number) {
	const logger = createLogger(
		createLoggerConfiguration("Instagram Post Liker")
	);

	const userFeed = ig.feed.user(userPk);

	let posts = new Array<UserFeedResponseItemsItem>();

	// If no likes wanted
	if (!followAmountOfLikes) {
		return;
	}

	try {
		logger.info("Fetching posts of %s..", username);

		// While there are more posts and we didn't reach the wanted amount of posts
		while (posts.length < followAmountOfLikes) {
			try {
				await userFeed.items().then(newPosts => {
					posts = posts.concat(newPosts);
				});
			} catch {
				break;
			}
		}

		// Get only the wanted amount of posts
		posts = posts.splice(0, followAmountOfLikes);

		logger.info("Got %d posts of %s..", posts.length, username);

		// For each post, like it
		for (const post of posts) {
			await ig.media.like({
				mediaId: post.id,
				moduleInfo: {
					module_name: "profile",
					user_id: post.user.pk,
					username: post.user.username
				},
				d: 0
			});

			logger.info(
				"[%d/%d] Liked post %s of %s.",
				posts.indexOf(post) + 1,
				posts.length,
				post.id,
				username
			);
		}
	} catch (ex) {
		logger.error(
			"An error occurred during liking the posts of %s:\n%s",
			username,
			ex
		);
	}
}

async function followTag() {
	const logger = createLogger(
		createLoggerConfiguration("Instagram Tag Follower")
	);

	// Get the feed of the tag
	const feed = ig.feed.tag(followTagName);

	logger.info("Started following tag: %s.", "#" + followTagName);

	while (true) {
		// Get the current page items
		await feed
			.items()
			.then(async items => {
				// For each item, follow it's user
				for (const item of items) {
					await ig.friendship.create(item.user.pk);
					logger.info("Followed user %s.", item.user.username);

					// Start liking the user's posts in the background
					likePosts(item.user.username, item.user.pk);

					// Wait half a minute before each follow
					await new Promise(resolve => setTimeout(resolve, 0.5 * 60 * 1000));
				}
			})
			.catch(async () => {
				logger.error("Following users errored. Waiting..");
				await new Promise(resolve => setTimeout(resolve, 10 * 60 * 1000));
			});
	}
}

function cleanCache() {
	submissionCache = new Array<String>();
}

(async () => {
	// Execute all requests prior to authorization in the real Android application
	// Not required but recommended
	await ig.simulate.preLoginFlow();
	const user = await ig.account.login(igUsername, igPassword);

	// Trying to get the feed to check for challange
	await ig.feed
		.user(user.pk)
		.items()
		.catch(async () => {
			botLogger.info(ig.state.checkpoint); // Checkpoint info here
			await ig.challenge.auto(true); // Requesting sms-code or click "It was me" button
			botLogger.info(ig.state.challenge); // Challenge info here
			const { code } = await inquirer.prompt([
				{
					type: "input",
					name: "code",
					message: "Enter code"
				}
			]);
			botLogger.info(await ig.challenge.sendSecurityCode(code));
		});

	// The same as preLoginFlow()
	// Optionally wrap it to process.nextTick so we dont need to wait ending of this bunch of requests
	process.nextTick(async () => await ig.simulate.postLoginFlow());

	botLogger.info("Authenticated to Instagram Successfully!");

	setInterval(fetchNewPosts, (fetchSubredditsPostsTime - 1) * 60 * 1000); // Fetch new posts interval
	setInterval(uploadPosts, uploadPostsTime * 60 * 1000); // Upload new posts interval
	setInterval(cleanCache, cleanPostsCacheDays * 24 * 60 * 60 * 1000); // Clean the cache every 2 days

	// If there is a tag to follow, start the follower in the background
	if (followTagName) {
		followTag();
	}

	// Initial fetch and upload
	await fetchNewPosts();
	await uploadPosts();
})();
