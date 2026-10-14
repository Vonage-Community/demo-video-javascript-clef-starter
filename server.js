import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Vonage } from '@vonage/server-sdk';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Reconstruct __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json({ limit: '25mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });


// Check for required env vars
if (!process.env.VONAGE_APPLICATION_ID || !process.env.VONAGE_PRIVATE_KEY || !process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_AUTH_TOKEN) {
  console.error("Missing required environment variables. Please check your .env file.");
  process.exit(1);
}

// Initialize Vonage SDK
const vonage = new Vonage({
  applicationId: process.env.VONAGE_APPLICATION_ID,
  privateKey: process.env.VONAGE_PRIVATE_KEY
});

// In-memory store for room sessions
const incidentStore = new Map();
const roomToSessionIdDictionary = {};

// Helper to ensure the dispatch session always exists
async function getDispatchSessionId() {
  if (roomToSessionIdDictionary['dispatch']) {
    return roomToSessionIdDictionary['dispatch'];
  }

  // Create it on the fly if it doesn't exist yet
  const session = await vonage.video.createSession({ mediaMode: 'routed' });
  roomToSessionIdDictionary['dispatch'] = session.sessionId;
  console.log('Created new Dispatch Session:', session.sessionId);

  return session.sessionId;
}

// Employee Dashboard Route & Auth
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/auth/dispatch', async (req, res) => {
  const dispatchSessionId = await getDispatchSessionId();
  const token = vonage.video.generateClientToken(dispatchSessionId, {
    role: 'subscriber' // Employees only listen in the dispatch session
  });

  res.json({
    applicationId: process.env.VONAGE_APPLICATION_ID,
    dispatchSessionId: dispatchSessionId,
    dispatchToken: token
  });
});

// Customer Auth (Generates a unique session per customer)
app.get('/api/auth/customer', async (req, res) => {
  try {
    const session = await vonage.video.createSession({ mediaMode: 'routed' });
    const token = vonage.video.generateClientToken(session.sessionId, {
      role: 'publisher'
    });

    res.json({
      applicationId: process.env.VONAGE_APPLICATION_ID,
      sessionId: session.sessionId,
      token: token
    });
  } catch (error) {
    console.error('Error creating customer session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Trigger the signal only when the user clicks the opt-in button
app.post('/api/escalate/trigger', async (req, res) => {
  const { customerId, user, sessionId, triggerReason } = req.body;
  console.log('Escalation trigger received for customerId:', customerId);
  try {
    const incident = incidentStore.get(sessionId) || {
      user,
      evaluation: { severity: { choice: "total_loss" } },
      imageUrls: []
    };

    const dispatchSessionId = await getDispatchSessionId();
    await vonage.video.sendSignal({
      type: 'escalation',
      data: JSON.stringify({
        customerId,
        user: incident.user,
        sessionId,
        evaluation: incident.evaluation,
        imageUrls: incident.imageUrls,
        triggerReason: triggerReason
      })
    }, dispatchSessionId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// An Employee Claims the Call
app.post('/api/escalate/claim', async (req, res) => {
  const { customerId } = req.body;
  try {
    const dispatchSessionId = await getDispatchSessionId();
    // Tell other dashboard clients to remove the card
    await vonage.video.sendSignal({
      type: 'claimed',
      data: JSON.stringify({ customerId })
    }, dispatchSessionId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error sending claim signal:', error);
    res.status(500).json({ error: 'Failed to broadcast claim' });
  }
});

// Generate a token for the employee joining the customer's unique session
app.post('/api/auth/customer-token', (req, res) => {
  const { sessionId } = req.body;
  const token = vonage.video.generateClientToken(sessionId, {
    role: 'publisher'
  });
  res.json({ token });
});

app.post('/api/process-claim', async (req, res) => {
  const { images, sessionId, user } = req.body; // Array of up to 4 base64 strings

  console.log('Processing claim for session:', sessionId);

  // Save images to server for the Adjuster Dashboard
  const imageUrls = [];
  images.forEach((imgBase64, index) => {
    // Strip the data:image/png;base64, prefix before saving to disk
    const base64Data = imgBase64.replace(/^data:image\/png;base64,/, "");
    fs.mkdirSync(`${uploadsDir}/${sessionId}`, { recursive: true });
    fs.writeFileSync(`${uploadsDir}/${sessionId}/claim_img${index}.png`, base64Data, 'base64');
    imageUrls.push(`/uploads/${sessionId}/claim_img${index}.png`);
  });

  const clefPayload = {
    model: "clef",
    state: "Evaluate the vehicle damage in the provided 360-degree walkaround images.",
    images: images, // Pass the array directly (Clef accepts up to 4)
    questions: {
      severity: {
        type: "choice",
        instructions: "What is the severity of the damage present on the vehicle?",
        criteria: {
          minor_cosmetic: "Minor Cosmetic including scratches, dents and paint damage",
          moderate_drivable: "Moderate Drivable",
          severe_total_loss: "Severe Total Loss",
          none: "None"
        }
      },
      damage_front: {
        type: "noul",
        instructions: "Is there damage to the front of the vehicle including scratches, dents, or paint damage?",
      },
      damage_rear: {
        type: "noul",
        instructions: "Is there damage to the rear of the vehicle including scratches, dents, or paint damage?",
      },
      damage_side: {
        type: "noul",
        instructions: "Is there damage to any side of the vehicle including scratches, dents, or paint damage?",
      },
      glass_shattered: {
        type: "noul",
        instructions: "Is any glass shattered on the vehicle?",
      },
      airbags_deployed: {
        type: "noul",
        instructions: "Have the airbags been deployed?",
      },
      flat_tires: {
        type: "noul",
        instructions: "Does the vehicle have any flat tires?",
      },
      requires_tow: {
        type: "noul",
        instructions: "Does this vehicle require towing?",
      }
    }
  };

  try {
    const clefResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/clef`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(clefPayload)
    });

    const clefResult = await clefResponse.json();
    console.dir(clefResult, { depth: null });

    const evaluation = clefResult.result.answers || {
      severity: { choice: "minor_cosmetic" }, airbags_deployed: { noul: 0 }, flat_tires: { noul: 0 }, requires_tow: { noul: 0 }, damage_front: { noul: 0.9 }, damage_rear: { noul: 0 }
    };

    // Build an array of damaged parts for the UI message
    const damagedParts = [];
    if (evaluation.damage_front.noul > 0.7) damagedParts.push("Front");
    if (evaluation.damage_rear.noul > 0.7) damagedParts.push("Rear");
    if (evaluation.damage_side.noul > 0.7) damagedParts.push("Side Panels");
    if (evaluation.glass_shattered.noul > 0.7) damagedParts.push("Glass");

    // Server-Side Decision Engine
    const isSevere =
      evaluation.severity.choice === "severe_total_loss" ||
      evaluation.airbags_deployed.noul > 0.5 ||
      evaluation.flat_tires.noul > 0.5 ||
      evaluation.requires_tow.noul > 0.5;

    incidentStore.set(sessionId, { user, evaluation, imageUrls });

    if (isSevere) {
      const issues = [];
      if (evaluation.airbags_deployed.noul > 0.5) issues.push("Airbags Deployed");
      if (evaluation.flat_tires.noul > 0.5) issues.push("Flat Tire(s)");
      if (evaluation.requires_tow.noul > 0.5) issues.push("Tow Required");

      res.json({
        decision: 'escalate',
        ui_message: `Critical safety issues detected: ${issues.join(", ")}.\nDamaged zones: ${damagedParts.join(", ") || "Multiple"}.`
      });
    } else if (damagedParts.length === 0 && evaluation.severity.choice === "none") {
      res.json({
        decision: 'no_damage',
        ui_message: `No significant damage detected by the AI.\nVehicle appears drivable.`
      });
    } else {
      res.json({
        decision: 'approved',
        ui_message: `Cosmetic damage detected on: ${damagedParts.join(", ") || "Vehicle Body"}.\nVehicle remains drivable.`
      });
    }

  } catch (error) {
    console.error("Clef Evaluation Error:", error);
    res.status(500).json({ error: "Failed to evaluate claim" });
  }
});
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
