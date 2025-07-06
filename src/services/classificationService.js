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
    return imageCache.get(hash);
  }

  const rawBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const ULTRALYTICS_API_KEY = process.env.ULTRALYTICS_API_KEY;

  try {
    const form = new FormData();
    form.append('file', Buffer.from(rawBase64, 'base64'), 'image.jpg');
    
    // Payload parameters
    const payload = {
      // model: "https://hub.ultralytics.com/models/TsKHX94hZt3SDDcHARis",
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
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

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

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API_ERROR: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const detections = data.images?.[0]?.results || [];
    
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
      throw new Error('SERVICE_TIMEOUT: Request timed out after 10 seconds');
    } else if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
      throw new Error('SERVICE_DOWN: API server is unreachable');
    } else if (error.message.includes('SERVICE_TIMEOUT')) {
      throw new Error('SERVICE_TIMEOUT: Request timed out');
    } else {
      throw new Error(`SERVICE_ERROR: ${error.message}`);
    }
  }
}