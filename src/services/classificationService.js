import fetch from 'node-fetch';
import { Buffer } from 'buffer';
import FormData from 'form-data';
import { createHash } from 'crypto';

// Thresholds
const MIN_CONFIDENCE = 0.65;
const HIGH_CONFIDENCE_THRESHOLD = 0.85;

// Cache setup (stores results for 5 minutes)
const imageCache = new Map();

export default async function classifyImage(imageBase64) {
  // Create MD5 hash of image for caching
  const hash = createHash('md5').update(imageBase64).digest('hex');
  
  // Return cached result if available
  if (imageCache.has(hash)) {
    return { ...imageCache.get(hash), cacheHit: true };
  }

  const rawBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const ULTRALYTICS_API_KEY = process.env.ULTRALYTICS_API_KEY;

  // TEMPORARY DEBUG LOG - REMOVE AFTER TESTING
  console.log('Ultralytics API Key:', ULTRALYTICS_API_KEY ? '***' + ULTRALYTICS_API_KEY.slice(-4) : 'MISSING');

  try {
    const form = new FormData();
    // Create buffer from base64 and append to form with content type
    form.append('file', Buffer.from(rawBase64, 'base64'), {
      filename: 'image.jpg',
      contentType: 'image/jpeg',
      knownLength: Buffer.byteLength(rawBase64, 'base64')
    });

    // Payload parameters
    const payload = {
      "model": "https://hub.ultralytics.com/models/ZVb5acmIVTVJsvn2CfpO",
      imgsz: 640,
      conf: 0.25,
      iou: 0.45
    };
    
    // Append payload parameters to form
    Object.entries(payload).forEach(([key, value]) => {
      form.append(key, value.toString());
    });

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    console.log('Sending request to Ultralytics API...');
    
    const response = await fetch("https://predict.ultralytics.com", {
      method: "POST",
      headers: {
        "x-api-key": ULTRALYTICS_API_KEY,
        ...form.getHeaders()
      },
      body: form,
      signal: controller.signal
    });
    clearTimeout(timeout);

    console.log('Received response:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('API Error Details:', errorText);
      throw new Error(`API_ERROR: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // DEBUG: Log the full API response
    console.log('Full API Response:', JSON.stringify(data, null, 2));
    
    // Extract detections - handle different response formats
    let detections = [];
    if (data.images && data.images[0] && data.images[0].results) {
      detections = data.images[0].results;
    } else if (data.predictions && data.predictions[0] && data.predictions[0].detections) {
      detections = data.predictions[0].detections;
    } else {
      console.warn('Unexpected response format:', Object.keys(data));
    }

    // TEMPORARY: Log all detected classes
    console.log('All detected classes:', detections.map(d => ({
      class: d.class, 
      name: d.name, 
      confidence: d.confidence
    })));

    // Check for waste detections (class 0)
    const wasteDetections = detections.filter(det => det.class === 0);
    const maxConfidence = wasteDetections.length > 0 
      ? Math.max(...wasteDetections.map(det => det.confidence)) 
      : 0;

    const isWaste = maxConfidence >= 0.25;
    let verification = "unverified";
    
    if (isWaste) {
      if (maxConfidence >= HIGH_CONFIDENCE_THRESHOLD) {
        verification = "high_confidence";
      } else if (maxConfidence >= MIN_CONFIDENCE) {
        verification = "medium_confidence";
      }
    }

    const result = {
      isWaste,
      label: isWaste ? "waste" : "non-waste",
      confidence: maxConfidence,
      verification,
      isHighConfidence: maxConfidence >= HIGH_CONFIDENCE_THRESHOLD,
      isVerifiedWaste: isWaste && maxConfidence >= HIGH_CONFIDENCE_THRESHOLD,
      modelVersion: "YOLOv8",
      needsImprovement: isWaste && maxConfidence > 0.7 && maxConfidence < 0.85,
      cacheHit: false
    };

    // Cache result for 5 minutes
    imageCache.set(hash, result);
    setTimeout(() => imageCache.delete(hash), 300000);

    return result;

  } catch (error) {
    console.error('Ultralytics API Error:', error);
    
    // Handle specific error cases
    if (error.name === 'AbortError') {
      throw new Error('SERVICE_TIMEOUT: Request timed out after 30 seconds');
    } else if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
      throw new Error('SERVICE_DOWN: API server is unreachable');
    } else if (error.message.includes('SERVICE_TIMEOUT')) {
      throw new Error('SERVICE_TIMEOUT: Request timed out');
    } else {
      throw new Error(`SERVICE_ERROR: ${error.message}`);
    }
  }
}