import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { OpenAI } from 'openai';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { jwt } from 'twilio';
import { twiml } from 'twilio';

// Load environment variables
dotenv.config();

// Initialize Express and Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000', //Get frontend URL from .env
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware setup
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI as string;
if (!MONGO_URI) {
  console.error('MongoDB URI is missing in .env');
  process.exit(1);
}

mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((error) => console.error('MongoDB connection error:', error));

// Twilio Credentials from .env
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID as string;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN as string;
const TWILIO_API_KEY = process.env.TWILIO_API_KEY as string;
const TWILIO_API_SECRET = process.env.TWILIO_API_SECRET as string;
const TWILIO_APP_SID = process.env.TWILIO_APP_SID as string;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER as string;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error('Missing Twilio credentials in .env');
  process.exit(1);
}

// OpenAI API Key from .env
const OPENAI_API_KEY = process.env.OPENAI_API_KEY as string;
if (!OPENAI_API_KEY) {
  console.error('OpenAI API key is missing in .env');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

//MongoDB Models
const callLogSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  status: { type: String, required: true },
  duration: { type: Number, required: false },
  timestamp: { type: Date, default: Date.now },
});

const objectionSchema = new mongoose.Schema({
  message: { type: String, required: true },
  response: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});

const CallLog = mongoose.model('CallLog', callLogSchema);
const Objection = mongoose.model('Objection', objectionSchema);

//Twilio Token for WebRTC Calls
app.get('/token', (req, res) => {
  const identity = 'caller';

  const AccessToken = jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  // Create a voice grant for the capability token
  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: TWILIO_APP_SID,
    incomingAllow: true,
  });

  // Generate the capability token
  const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, {
    identity,
    ttl: 3600,
  });

  token.addGrant(voiceGrant);

  res.send({ token: token.toJwt() });
});

// TwiML Call Routing for WebRTC & Regular Calls
app.post('/voice', (req, res) => {
  const response = new twiml.VoiceResponse();
  const { To, CallSid } = req.body;

  if (!To || To.startsWith('client:')) {
    console.error("Invalid 'To' number.");
  }

  console.log(`New Call Request: From ${TWILIO_PHONE_NUMBER} to ${To}`);

  //Store Call Log in MongoDB
  const callLog = new CallLog({
    _id: CallSid,
    phoneNumber: To,
    status: 'initiated',
  });

  callLog.save()
    .then(() => console.log(`Inserted data in MongoDB for ${To}`))
    .catch((error) => console.error(' Failed to save call log:', error));

  // Route Call to the Correct Mobile Number
  response.dial({ callerId: TWILIO_PHONE_NUMBER }, To);

  res.type('text/xml');
  res.send(response.toString());
});

// WebSocket Handling for Objection Responses
io.on('connection', (socket) => {
  console.log('A user connected');

  // ChatGPT OpenAI Objection Handling
  socket.on('objection', async (message: string) => {
    try {
      console.log(`Processing Objection: ${message}`);

      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: "You are an expert sales assistant. Provide concise, persuasive responses to sales objections." },
          { role: 'user', content: `How should I handle this objection? ${message}` },
        ],
      });

      const suggestion = response.choices[0].message.content;
      console.log(` AI Suggestion: ${suggestion}`);

      // Save objection and response to MongoDB
      const objection = new Objection({ message, response: suggestion });
      await objection.save();

      // Send AI-generated response to frontend
      socket.emit('suggestion', suggestion);
    } catch (error) {
      console.error('Failed to generate AI suggestion:', error);
      socket.emit('suggestion', 'Failed to generate suggestion.');
    }
  });

  socket.on('disconnect', () => {
    console.log('A user disconnected');
  });
});



// Start the Server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
