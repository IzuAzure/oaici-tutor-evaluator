// ==============================================================================
// OAICI AI TUTOR EVALUATOR - BACKEND CORE ENGINE
// ==============================================================================

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

app.use(cors()); 
app.use(express.json({ limit: '15mb' })); // Expanded to accommodate large text payloads

const PORT = process.env.PORT || 5000;

// --- Google Cloud Infrastructure ---
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ==============================================================================
// 🚦 DATA MANAGEMENT ROUTES
// ==============================================================================

app.get('/api/evaluations', async (req, res) => {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'evaluations!A:K', 
    });

    const rows = response.data.values || [];
    if (rows.length === 0) return res.status(200).json({ success: true, data: [] });

    const headers = rows[0];
    const dataRows = rows.slice(1);

    const formattedData = dataRows.map(row => {
      let obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] || ''; 
      });
      return obj;
    });

    res.status(200).json({ success: true, data: formattedData });
  } catch (error) {
    console.error('❌ GET Fetch Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/evaluations', async (req, res) => {
  try {
    const { evaluations } = req.body; 
    const sheets = google.sheets({ version: 'v4', auth });

    // Helper function to generate a strict 9-character ID (e.g., 'EV-8X4B9Q')
    const generate9CharId = () => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let id = 'EV-'; 
      for (let i = 0; i < 6; i++) { 
        id += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return id;
    };

    const rowsToAppend = evaluations.map(item => [
      generate9CharId(),                                      // Column A: eval_id
      item.student_email || 'anonymous@mapua.edu.ph',         // Column B: student_email
      item.course_code || 'CSV_IMPORT',                       // Column C: course_code
      item.student_prompt || '',                              // Column D: student_prompt
      item.walter_response || '',                             // Column E: walter_response
      '0', '0', '0', '0', 'No', ''                            // Columns F-K
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'evaluations!A:K',
      valueInputOption: 'USER_ENTERED',
      resource: { values: rowsToAppend },
    });

    res.status(200).json({ success: true, message: `Successfully logged ${rowsToAppend.length} entries.` });
  } catch (error) {
    console.error('❌ POST Append Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================================================================
// 🤖 ARTIFICIAL INTELLIGENCE & EVALUATION ROUTES
// ==============================================================================

app.post('/api/evaluations/ai-judge', async (req, res) => {
  try {
    const { student_prompt, walter_response, reference_material } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) throw new Error("Missing GEMINI_API_KEY in .env file.");

    const baseSystemInstruction = `You are an expert academic AI auditor evaluating a course-specific AI tutor response against a student's question.
    
Evaluate the response based on these 4 strict criteria, giving either a "1" (Yes/Pass) or "0" (No/Fail):
1. Accuracy: Is the response factually correct and accurate?
2. Curriculum Alignment: Is the response completely relevant to academic course content?
3. Hallucination: Did the AI invent fake facts or information outside standard learning boundaries? (1 if it hallucinated, 0 if it stayed safe and grounded).
4. Pedagogical Quality: Does the response guide learning effectively (proactively prompting thoughts, breaking down concepts), rather than just handing out a lazy, direct answer?

You must output your answer inside a single, clean JSON object matching this exact shape structure:
{
  "accuracy": "1",
  "alignment": "1",
  "hallucination": "0",
  "pedagogy": "1",
  "reason": "Provide a concise single-sentence justification of your evaluation."
}`;

    let masterPromptPayload = baseSystemInstruction;
    if (reference_material && reference_material.trim() !== "") {
      masterPromptPayload += `\n\n⚠️ CRITICAL GROUND-TRUTH MATERIAL FOCUS:\nYou must use the following compiled course reference documentation as your absolute truth baseline. If the tutor response contains engineering configurations, historical assertions, formulas, or concepts that diverge from, contradict, or are entirely unsupported by this reference material, you MUST rate it as a '0' for accuracy and a '1' for hallucination:
=========================================
${reference_material}
=========================================`;
    }

    masterPromptPayload += `\n\n--- TARGET TRANSCRIPT TO AUDIT ---\nStudent Question: "${student_prompt}"\nAI Tutor Response: "${walter_response}"`;

    const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const requestPayload = {
      contents: [{ parts: [{ text: masterPromptPayload }] }],
      generationConfig: { responseMimeType: "application/json" }
    };

    const apiCall = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload)
    });

    const rawResponse = await apiCall.json();
    if (!apiCall.ok) throw new Error(rawResponse.error?.message || "Failed inferencing via Gemini.");

    const inferenceOutputText = rawResponse.candidates[0].content.parts[0].text;
    const structuredMetrics = JSON.parse(inferenceOutputText.trim());

    res.status(200).json({ success: true, evaluation: structuredMetrics });
  } catch (error) {
    console.error('❌ LLM Judge API Failure:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/evaluations/submit-grade', async (req, res) => {
  try {
    const { eval_id, accuracy, alignment, hallucination, pedagogy, graded_by } = req.body;
    const sheets = google.sheets({ version: 'v4', auth });

    const tableLookup = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'evaluations!A:A',
    });

    const idMatrix = tableLookup.data.values || [];
    const traceIndex = idMatrix.findIndex(row => row[0] === eval_id);

    if (traceIndex === -1) return res.status(404).json({ success: false, message: `Evaluation item not found.` });

    const targetSheetRow = traceIndex + 1;
    const metricsPayload = [accuracy, alignment, hallucination, pedagogy, 'Yes', graded_by]; 

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `evaluations!F${targetSheetRow}:K${targetSheetRow}`, 
      valueInputOption: 'USER_ENTERED',
      resource: { values: [metricsPayload] },
    });

    res.status(200).json({ success: true, message: `Row ${targetSheetRow} updated successfully.` });
  } catch (error) {
    console.error('❌ PUT Overwrite Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================================================================
// 🛠️ EDIT AND DELETE ROUTES
// ==============================================================================

app.put('/api/evaluations/edit-transcript', async (req, res) => {
  try {
    const { eval_id, student_email, course_code, student_prompt, walter_response } = req.body;
    const sheets = google.sheets({ version: 'v4', auth });

    const tableLookup = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'evaluations!A:A',
    });

    const idMatrix = tableLookup.data.values || [];
    const traceIndex = idMatrix.findIndex(row => row[0] === eval_id);

    if (traceIndex === -1) return res.status(404).json({ success: false, message: `Evaluation item not found.` });

    const targetSheetRow = traceIndex + 1;
    const transcriptPayload = [student_email, course_code, student_prompt, walter_response];

    // Updates Columns B through E
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `evaluations!B${targetSheetRow}:E${targetSheetRow}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [transcriptPayload] },
    });

    res.status(200).json({ success: true, message: `Transcript for ${eval_id} updated successfully.` });
  } catch (error) {
    console.error('❌ PUT Edit Transcript Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/evaluations/:id', async (req, res) => {
  try {
    const eval_id = req.params.id;
    const sheets = google.sheets({ version: 'v4', auth });

    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: process.env.SPREADSHEET_ID });
    const targetSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'evaluations');
    
    if (!targetSheet) throw new Error("Could not locate 'evaluations' tab inside spreadsheet.");
    const sheetId = targetSheet.properties.sheetId;

    const tableLookup = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'evaluations!A:A',
    });

    const idMatrix = tableLookup.data.values || [];
    const traceIndex = idMatrix.findIndex(row => row[0] === eval_id);

    if (traceIndex === -1) return res.status(404).json({ success: false, message: `Evaluation record not found.` });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.SPREADSHEET_ID,
      resource: {
        requests: [{
          deleteDimension: {
            range: { sheetId: sheetId, dimension: 'ROWS', startIndex: traceIndex, endIndex: traceIndex + 1 }
          }
        }]
      }
    });

    res.status(200).json({ success: true, message: `Record ${eval_id} successfully deleted.` });
  } catch (error) {
    console.error('❌ DELETE Row Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const sheets = google.sheets({ version: 'v4', auth });
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'users!A:B', 
    });

    const rows = response.data.values || [];
    const validUser = rows.find(row => row[0] === email && row[1] === password);

    if (validUser) {
      res.status(200).json({ success: true, message: 'Login successful', user: validUser[0] });
    } else {
      res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }
  } catch (error) {
    console.error('❌ Login API Error:', error.message);
    res.status(500).json({ success: false, message: 'Database connection failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`\n=========================================`);
  console.log(`🚀 OAICI Framework active on port ${PORT}`);
  console.log(`=========================================\n`);
});