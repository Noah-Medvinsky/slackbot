const express = require('express');
const bodyParser = require('body-parser');
const AWS = require('aws-sdk');
const OpenAI = require('openai');
const uuid = require('uuid');
const axios = require('axios');
const cheerio = require('cheerio');
const { App } = require('@slack/bolt');
const fs = require('fs');
const toml = require('toml');

// Load and parse TOML configuration file
const config = toml.parse(fs.readFileSync('./secrets.toml', 'utf-8'));

// Debug: Log the loaded configuration
console.log('Loaded configuration:', config);

// Initialize Express app
const app = express();
app.use(bodyParser.json());

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
});

// Initialize DynamoDB
AWS.config.update({
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    region: config.AWS_REGION,
});

const dynamoDB = new AWS.DynamoDB.DocumentClient();
const tableName = 'BotTrainingData';

// Set up Slack Bolt App
const slackApp = new App({
    token: config.SLACK_BOT_TOKEN,
    signingSecret: config.SLACK_SIGNING_SECRET
});

// Function to post a message to Slack
const postMessageToSlack = async (channel, text, blocks = null) => {
    try {
        await slackApp.client.chat.postMessage({
            token: config.SLACK_BOT_TOKEN,
            channel: channel,
            text: text,
            blocks: blocks
        });
    } catch (error) {
        console.error('Error posting message to Slack:', error);
    }
};

// Slack event listener for messages
slackApp.message(async ({ message, say }) => {
    if (message.subtype && message.subtype === 'bot_message') {
        return;
    }

    const question = message.text;

    try {
        const scanParams = {
            TableName: tableName,
        };

        const data = await dynamoDB.scan(scanParams).promise();
        const items = data.Items;

        let context = "You are a bot trained to answer questions about the FailSafe product. Here is the training data:\n\n";
        items.forEach(item => {
            context += `Q: ${item.question}\nA: ${item.answer}\n\n`;
        });
        context += `\nUser's Question: ${question}\nAnswer:`;

        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: context },
                { role: "user", content: question }
            ]
        });

        const botAnswer = response.choices[0].message.content.trim();

        await say(botAnswer);
    } catch (error) {
        console.error('Error in Slack message event:', error);
        await say('Sorry, I encountered an error while processing your request.');
    }
});

// Express routes
app.post('/train', async (req, res) => {
    try {
        const { article, url } = req.body;
        const userId = uuid.v4();
        const questionId = uuid.v4();

        let content;

        if (url) {
            const response = await axios.get(url);
            const html = response.data;
            const $ = cheerio.load(html);

            content = '';
            $('p').each((i, elem) => {
                content += $(elem).text() + '\n';
            });

            if (!content) {
                return res.status(400).json({ error: 'Failed to extract article content from the URL.' });
            }
        } else if (article) {
            content = article;
        } else {
            return res.status(400).json({ error: 'No article or URL provided.' });
        }

        const articleSummary = `Summary of article: ${content.substring(0, 500)}...`;

        const params = {
            TableName: tableName,
            Item: {
                userId,
                questionId,
                question: 'Article',
                answer: content,
            },
        };

        await dynamoDB.put(params).promise();

        res.json({ message: 'Article added successfully!', userId, articleSummary });
    } catch (error) {
        console.error('Error in /train route:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/query', async (req, res) => {
    try {
        const { question } = req.body;

        const scanParams = {
            TableName: tableName,
        };

        const data = await dynamoDB.scan(scanParams).promise();
        const items = data.Items;

        let context = "You are a bot trained to answer questions about the FailSafe product. Here is the training data:\n\n";
        items.forEach(item => {
            context += `Q: ${item.question}\nA: ${item.answer}\n\n`;
        });
        context += `\nUser's Question: ${question}\nAnswer:`;

        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: context },
                { role: "user", content: question }
            ]
        });

        const botAnswer = response.choices[0].message.content.trim();

        res.json({ answer: botAnswer });
    } catch (error) {
        console.error('Error in  /query route:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start Express server
app.listen(5000, () => {
    console.log('Server is running on http://localhost:5000');

    // Start Slack app
    (async () => {
        await slackApp.start(process.env.PORT || 3000);
        console.log('⚡️ Slack bot is running!');
        console.log('api'+config.SLACK_BOT_TOKEN)
    })();
});
