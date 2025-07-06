import "dotenv/config"; // MUST BE FIRST IMPORT
import express from "express";
import cors from "cors";
import job from "./lib/cron.js";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/authRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import { connectDB } from "./lib/db.js";
import { errorMiddleware } from "./middleware/error.js";
import { removeUnverifiedAccounts } from "./automation/removeUnverifiedAccounts.js";

const app = express();
app.set('trust proxy', 1); // Trust reverse proxy

const PORT = process.env.PORT || 3000;

// Security and configuration
app.use(express.json({ limit: '10mb' }));

// Enable CORS
app.use(cors());

app.use(cookieParser()); // Parse cookies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Error handling middleware
app.use((err, req, res, next) => {
  res.setHeader('Content-Type', 'application/json');

  if (err instanceof SyntaxError && err.status === 413) {
    return res.status(413).json({
      error: "Payload too large",
      suggestion: "Compress images before uploading"
    });
  }

  console.error('Server Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Rate limiter for report creation
const reportLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // Limit to 5 report submissions per minute
  message: JSON.stringify({
    error: 'Too many report submissions',
    message: 'Please try again later'
  })
});

// Routes
app.get('/health', async (req, res) => {
  try {
    const status = {
      db: 'connected', // Assuming DB is always connected
      ai: 'operational'
    };
    
    // Simple AI health check
    const sampleBase64 = "data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await classifyImage(sampleBase64);
    
    res.status(200).json(status);
  } catch (error) {
    res.status(500).json({
      error: 'AI service unavailable',
      details: error.message
    });
  }
});
app.use("/api/auth", authRoutes);
app.use("/api/report", reportLimiter, reportRoutes); // Rate limiter applied
app.use("/api/users", userRoutes);

// Start server
app.listen(PORT, () => {
  console.log(`Server is listening on port: ${PORT}`);
  connectDB(); // Connect to MongoDB
  
  // Start cron job AFTER server starts and env vars are loaded
  job.start();
  removeUnverifiedAccounts(); // Schedule task to remove unverified accounts
});

app.use(errorMiddleware); // Error handling middleware