import fetch from 'node-fetch';
import { Buffer } from 'buffer';
import FormData from 'form-data';
import { createHash } from 'crypto';

const MIN_CONFIDENCE = 0.65;
const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const imageCache = new Map();

export default async function classifyImage(imageBase64) {
  const hash = createHash('md5').update(imageBase64).digest('hex');
  
  if (imageCache.has(hash)) {
    return imageCache.get(hash);
  }

  const rawBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const ULTRALYTICS_API_KEY = process.env.ULTRALYTICS_API_KEY;

  try {
    const form = new FormData();
    form.append('file', Buffer.from(rawBase64, 'base64'), {
      filename: 'image.jpg',
      contentType: 'image/jpeg',
      knownLength: Buffer.byteLength(rawBase64, 'base64')
    });

    const payload = {
      "model": "https://hub.ultralytics.com/models/ZVb5acmIVTVJsvn2CfpO",
      imgsz: 640,
      conf: 0.25,
      iou: 0.45
    };
    
    Object.entries(payload).forEach(([key, value]) => {
      form.append(key, value.toString());
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

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
    
    // Extract detections
    let detections = [];
    if (data.images?.[0]?.results) {
      detections = data.images[0].results;
    } else if (data.predictions?.[0]?.detections) {
      detections = data.predictions[0].detections;
    }

    // CORRECTED: Class 1 is waste, class 0 is non-waste
    const wasteDetections = detections.filter(det => det.class === 1);
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
      modelVersion: "YOLOv8"
    };

    imageCache.set(hash, result);
    setTimeout(() => imageCache.delete(hash), 300000);

    return result;

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('SERVICE_TIMEOUT');
    } else if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
      throw new Error('SERVICE_DOWN');
    } else {
      throw new Error(`SERVICE_ERROR: ${error.message}`);
    }
  }
}