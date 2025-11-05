// --- Dependencies ---
require('dotenv').config(); 
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const jwt = require('jsonwebtoken');
const path = require('path');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
// (stray/invalid code removed)

// --- Server Setup ---
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    },
    tls: {
        rejectUnauthorized: false
    }
});
const app = express();
const port = 3000;
app.use(cors());
app.use(express.json());
// session (required by passport for the OAuth handshake)
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

app.use(passport.initialize());
app.use(passport.session());

// Serve static frontend files from project root (so http://localhost:3000 serves index.html)
app.use(express.static(path.join(__dirname)));

// Passport serialize/deserialize (we keep minimal user object)
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        if (!dbAvailable) {
            // Try to find in-memory OAuth users
            for (const u of oauthUsers.values()) {
                if (u.id === id) return done(null, { id: u.id, email: u.email });
            }
            return done(null, false);
        }
        const [rows] = await pool.execute('SELECT id, email FROM users WHERE id = ?', [id]);
        if (rows.length === 0) return done(null, false);
        return done(null, rows[0]);
    } catch (err) {
        return done(err);
    }
});

// Utility: find or create user by email
async function findOrCreateUserByEmail(email, displayName) {
    if (!dbAvailable) {
        if (oauthUsers.has(email)) return oauthUsers.get(email);
        const id = nextOauthId++;
        const u = { id, email, displayName };
        oauthUsers.set(email, u);
        return u;
    }
    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length) return rows[0];
    // create a new user with no password (OAuth user)
    const [result] = await pool.execute('INSERT INTO users (email) VALUES (?)', [email]);
    const id = result.insertId;
    const [newRows] = await pool.execute('SELECT id, email FROM users WHERE id = ?', [id]);
    return newRows[0];
}

// Configure Google Strategy
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${process.env.APP_BASE_URL || 'http://localhost:3000'}/api/auth/google/callback`
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            const email = profile.emails && profile.emails[0] && profile.emails[0].value;
            if (!email) return done(new Error('No email from Google'));
            const user = await findOrCreateUserByEmail(email, profile.displayName);
            user.displayName = profile.displayName;
            return done(null, user);
        } catch (err) {
            return done(err);
        }
    }));
}

// --- OpenRouter AI Configuration ---
// Trim surrounding quotes and whitespace in case the key was wrapped in quotes in the .env file
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || '').replace(/^\s*"|"\s*$|^\s*'|'\s*$/g, '').trim();
const API_URL = "https://openrouter.ai/api/v1/chat/completions";
if (!OPENROUTER_API_KEY) {
    console.warn("⚠️ OPENROUTER_API_KEY not found in environment. AI features will be disabled, but the server will continue running for auth and basic endpoints.");
} else {
    // Log a masked version so it's obvious the key loaded without exposing it in logs
    const masked = OPENROUTER_API_KEY.length > 8 ? OPENROUTER_API_KEY.slice(0,4) + '...' + OPENROUTER_API_KEY.slice(-4) : '***';
    console.log(`✅ OPENROUTER_API_KEY present (masked: ${masked})`);
}


// --- MySQL Database Connection ---
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '2005',
    database: process.env.DB_DATABASE || 'resume_architect',
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
    queueLimit: 0
});

// Flag to indicate whether DB is available; if false we'll use an in-memory fallback for OAuth users
let dbAvailable = true;

// In-memory fallback store for OAuth-created users when DB is not available
const oauthUsers = new Map(); // email -> { id, email, displayName }
let nextOauthId = 100000;

// --- Helper function for making AI calls ---
async function callAI(systemMessage, userMessage, enforceJson = false) {
    // (original behavior) send to configured AI provider(s)
    // Prefer OpenRouter when configured
    if (OPENROUTER_API_KEY) {
        const headers = {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": `http://localhost:${port}`,
            "X-Title": `Resume Architect`
        };

        // Available free models from OpenRouter
        const models = [
            "mistralai/mistral-7b-instruct",  // Base model name without ":free"
            "anthropic/claude-2",              // More reliable for JSON responses
            "meta-llama/codellama-34b-instruct"// Good technical analysis
        ];

        for (const model of models) {
            try {
                const body = {
                    model,
                    messages: [
                        { role: "system", content: systemMessage },
                        { role: "user", content: userMessage }
                    ]
                };
                if (enforceJson) {
                    body.response_format = { type: "json_object" };
                }

                const response = await fetch(API_URL, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                    // Add timeout to prevent hanging on slow responses
                    signal: AbortSignal.timeout(15000) // 15 second timeout
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const errMsg = errorData?.error?.message || `HTTP ${response.status}`;
                    // Don't retry rate limits or invalid model errors
                    if (errMsg.includes('rate limit') || errMsg.includes('No endpoints found')) {
                        console.warn(`⚠️ Skipping remaining OpenRouter models due to: ${errMsg}`);
                        break;
                    }
                    throw new Error(errMsg);
                }

                const data = await response.json();
                console.log(`✅ Using OpenRouter model: ${model}`);
                return data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : JSON.stringify(data);
            } catch (error) {
                console.warn(`⚠️ OpenRouter model ${model} failed: ${error.message}. Trying next model...`);
            }
        }
        console.warn('⚠️ OpenRouter models unavailable or rate limited. Falling back to OpenAI if configured.');
    }

    // Fallback to OpenAI API if OPENAI_API_KEY is present and not empty
    const openaiKey = (process.env.OPENAI_API_KEY || '').trim();
    if (process.env.OPENAI_API_KEY) {
        try {
            const oaHeaders = {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            };
            const oaBody = {
                model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
                messages: [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content: userMessage }
                ],
                temperature: 0.2
            };

            const resp = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: oaHeaders,
                body: JSON.stringify(oaBody)
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error?.message || `OpenAI HTTP ${resp.status}`);
            }
            const json = await resp.json();
            const content = json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : (json.choices && json.choices[0] ? json.choices[0].text : JSON.stringify(json));
            console.log('✅ Using OpenAI chat.completions');
            return content;
        } catch (err) {
            console.error('❌ OpenAI fallback failed:', err.message);
            throw new Error('All AI providers failed. Check OPENROUTER_API_KEY or OPENAI_API_KEY.');
        }
    }

    // If the app is configured to allow a local scoring fallback, perform a simple keyword overlap score
    if (ALLOW_LOCAL_SCORING) {
        try {
            console.warn('⚠️ No remote AI providers available — using local fallback scorer (ALLOW_LOCAL_SCORING=true).');
            const { jobDesc, resume } = extractSectionsFromUserMessage(userMessage);
            const result = simpleKeywordScore(resume, jobDesc);
            // When enforceJson is true, callers expect a JSON string response
            return enforceJson ? JSON.stringify(result) : JSON.stringify(result);
        } catch (err) {
            console.error('Local fallback scorer failed:', err && err.message ? err.message : err);
            throw new Error('No AI provider configured (OPENROUTER_API_KEY or OPENAI_API_KEY).');
        }
    }

    throw new Error('No AI provider configured (OPENROUTER_API_KEY or OPENAI_API_KEY).');
}

// --- Local fallback scorer (useful for development/test when no AI provider is configured) ---
function extractSectionsFromUserMessage(userMessage) {
    // Attempt to extract JOB DESCRIPTION and RESUME TEXT blocks from the standard payload
    const jobMatch = userMessage.match(/JOB DESCRIPTION:\s*([\s\S]*?)\n\nRESUME TEXT:/i);
    const resumeMatch = userMessage.match(/RESUME TEXT:\s*([\s\S]*)$/i);
    const jobDesc = jobMatch ? jobMatch[1].trim() : '';
    const resume = resumeMatch ? resumeMatch[1].trim() : '';
    return { jobDesc, resume };
}

function simpleKeywordScore(resume, jobDesc) {
    const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const jd = normalize(jobDesc).split(/\s+/).filter(w => w.length > 3);
    const uniqueJd = Array.from(new Set(jd));
    const resText = normalize(resume);

    if (uniqueJd.length === 0) {
        return { score: 0, strengths: [], weaknesses: [] };
    }

    const matched = uniqueJd.filter(k => resText.includes(k));
    const score = Math.round((matched.length / uniqueJd.length) * 100);
    const strengths = matched.slice(0, 3).map(s => s);
    const weaknesses = uniqueJd.filter(k => !matched.includes(k)).slice(0, 3).map(s => s);
    return { score: Math.max(0, Math.min(100, score)), strengths, weaknesses };
}

// If no AI provider is configured, allow a simple local scoring fallback when explicitly enabled
// Set ALLOW_LOCAL_SCORING=true in your .env to enable this during development/testing.
const ALLOW_LOCAL_SCORING = String(process.env.ALLOW_LOCAL_SCORING || '').toLowerCase() === 'true';



// --- AI-POWERED KEYWORD CATEGORIZATION ---
async function categorizeJobRequirements(jobDescription) {
    console.log("Sending job description to AI for categorization...");
    const systemMessage = `You are an expert recruitment data analyst. Analyze the following job description and extract the key requirements. Your entire response must be ONLY a single valid JSON object with the following keys: "technical_skills", "soft_skills", "experience_years", "education", "certifications". Each key's value must be an array of strings. For "experience_years", provide one string like ["3+ years"]. If a category has no requirements, provide an empty array.`;
    const userMessage = `Job Description: ${jobDescription}`;

    try {
        const jsonResponse = await callAI(systemMessage, userMessage, true);
        console.log("✅ AI categorization successful.");
        return JSON.parse(jsonResponse);
    } catch (error) {
        console.error("❌ AI Error during categorization:", error.message);
        return { technical_skills: [], soft_skills: [], experience_years: [], education: [], certifications: [] };
    }
}

// (debug variables removed as part of undoing temporary inspection endpoints)



// --- API Endpoints ---

app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password are required." });
    if (!dbAvailable) return res.status(503).json({ message: 'Registration is unavailable while the database is down.' });
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.execute('INSERT INTO users (email, password) VALUES (?, ?)', [email, hashedPassword]);
        res.status(201).json({ message: "User registered successfully!" });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') res.status(409).json({ message: "This email is already registered." });
        else res.status(500).json({ message: "Server error during registration." });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password are required." });
    if (!dbAvailable) return res.status(503).json({ message: 'Login is unavailable while the database is down.' });
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) return res.status(401).json({ message: "Invalid credentials." });
        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (isMatch) res.status(200).json({ message: "Login successful!", user: { id: user.id, email: user.email } });
        else res.status(401).json({ message: "Invalid credentials." });
    } catch (error) {
        res.status(500).json({ message: "Server error during login." });
    }
});

app.get('/api/jobs', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM job_postings ORDER BY createdAt DESC');
        const jobs = rows.map(job => {
            let parsedKeywords = {
                technical_skills: [],
                soft_skills: [],
                experience_years: [],
                education: [],
                certifications: []
            };
            try {
                if (job.keywords) {
                    const parsed = JSON.parse(job.keywords);
                    if (typeof parsed === 'object' && parsed !== null) {
                        parsedKeywords = {
                            ...parsedKeywords,
                            ...parsed
                        };
                    }
                }
            } catch (e) { 
                console.warn(`Could not parse keywords for job ID ${job.id}, using default empty structure`);
            }
            return { ...job, keywords: parsedKeywords };
        });
        res.status(200).json(jobs);
    } catch (error) {
        console.error("❌ Error fetching jobs:", error.message);
        res.status(500).json({ message: "Failed to fetch jobs from the database." });
    }
});


app.post('/api/jobs', async (req, res) => {
    const { job_title, company, full_description } = req.body;
    if (!job_title || !full_description) return res.status(400).json({ message: "Job title and description are required." });
    try {
        const categorizedKeywords = await categorizeJobRequirements(full_description);
        await pool.execute(
            'INSERT INTO job_postings (job_title, company, full_description, keywords) VALUES (?, ?, ?, ?)',
            [job_title, company, full_description, JSON.stringify(categorizedKeywords)]
        );
        res.status(201).json({ message: "Job posting added successfully with categorized keywords!" });
    } catch (error) {
        console.error("❌ Error adding job:", error.message);
        res.status(500).json({ message: "Server error while adding job." });
    }
});

app.post('/api/score', async (req, res) => {
    const { resume, jobDesc } = req.body;
    if (!resume || !jobDesc) {
        return res.status(400).json({ message: "Resume and Job Description are required." });
    }
    console.log("Sending data to AI for ATS scoring...");
    const systemMessage = `You are an advanced Applicant Tracking System (ATS). Your task is to analyze the provided resume against the job description and return a detailed analysis as a single, valid JSON object. The JSON object must have three keys: "score" (a number from 0 to 100 representing the match percentage), "strengths" (an array of 2-3 strings highlighting what the resume does well), and "weaknesses" (an array of 2-3 strings suggesting areas for improvement).`;
    const userMessage = `JOB DESCRIPTION:\n${jobDesc}\n\nRESUME TEXT:\n${resume}`;
    try {
        const jsonResponse = await callAI(systemMessage, userMessage, true);
        console.log("✅ AI scoring successful.");
        const parsedResponse = JSON.parse(jsonResponse);
        
        // Validate the response structure
        if (typeof parsedResponse.score !== 'number' || 
            !Array.isArray(parsedResponse.strengths) || 
            !Array.isArray(parsedResponse.weaknesses)) {
            throw new Error("Invalid response format from AI");
        }
        
        // Ensure score is between 0 and 100
        parsedResponse.score = Math.max(0, Math.min(100, parsedResponse.score));
        
        // Ensure strengths and weaknesses are strings and not empty
        parsedResponse.strengths = parsedResponse.strengths
            .filter(s => typeof s === 'string' && s.trim())
            .slice(0, 3);
        parsedResponse.weaknesses = parsedResponse.weaknesses
            .filter(w => typeof w === 'string' && w.trim())
            .slice(0, 3);
            
        res.status(200).json(parsedResponse);
    } catch (error) {
        console.error("❌ AI Error during scoring:", error && error.message ? error.message : error);
        res.status(500).json({ 
            message: "Unable to generate ATS score. Please try again.", 
            error: error && error.message ? error.message : String(error),
            score: 0,
            strengths: [],
            weaknesses: []
        });
    }
});

app.post('/api/analyze', async (req, res) => {
    const { type, resume, jobDesc, missingKeywords = [] } = req.body;
    if (!type || !resume || !jobDesc) return res.status(400).json({ message: "Missing required fields." });
    let userMessage;
    if (type === "interview_questions") {
        userMessage = `Generate 5 likely interview questions based on this job and resume.\n\nJOB:\n${jobDesc}\n\nRESUME:\n${resume}`;
    } else if (type === "suggestions") {
        userMessage = `Rewrite this resume to better match the job description, incorporating missing keywords: "${missingKeywords.join(', ')}".\n\nJOB:\n${jobDesc}\n\nRESUME:\n${resume}`;
    } else {
        return res.status(400).json({ message: "Invalid analysis type." });
    }
    try {
        const aiResponse = await callAI("You are an expert resume coach.", userMessage, false);
        let text;
        let parsed = null;
        if (typeof aiResponse === 'string') {
            try { parsed = JSON.parse(aiResponse); } catch (e) { parsed = null; }
            if (!parsed || typeof parsed !== 'object') {
                text = aiResponse;
            }
        } else if (typeof aiResponse === 'object' && aiResponse !== null) {
            parsed = aiResponse;
        } else {
            text = String(aiResponse);
        }
        // If parsed looks like the scorer object, synthesize a rewritten resume or questions if appropriate
        if (parsed && (parsed.score !== undefined || parsed.weaknesses !== undefined)) {
            if (type === 'suggestions') {
                // Fallback: generate a rewritten resume by inserting missing keywords into the resume
                const missing = Array.isArray(parsed.weaknesses) ? parsed.weaknesses.slice(0, 8) : [];
                let rewrittenResume = resume;
                if (missing.length > 0) {
                    if (!/skills/i.test(resume)) {
                        rewrittenResume += `\n\nSkills:\n- ${missing.join('\n- ')}`;
                    } else {
                        rewrittenResume += `\n\n// Add these keywords to your Skills or Experience section:\n- ${missing.join('\n- ')}`;
                    }
                }
                text = `Here is a rewritten version of your resume with missing keywords added for better job match:\n\n${rewrittenResume}`;
            } else if (type === 'interview_questions') {
                const questions = generateLocalInterviewQuestions(jobDesc);
                text = questions.join('\n');
            } else {
                text = JSON.stringify(parsed, null, 2);
            }
        }
        if (typeof text !== 'string') text = JSON.stringify(text || parsed || {}, null, 2);
        // Defensive fallback: if we're returning interview questions but the AI produced an empty/insufficient response,
        // generate local questions so the frontend always gets useful output.
        if (type === 'interview_questions') {
            const cleaned = (text || '').trim();
            const numberedMatches = (cleaned.match(/\d+\./g) || []).length;
            const lineCount = cleaned.split(/\n/).filter(l => l.trim()).length;
            const looksInsufficient = !cleaned || cleaned.length < 10 || (numberedMatches < 2 && lineCount < 2);
            if (looksInsufficient) {
                const questions = generateLocalInterviewQuestions(jobDesc);
                text = questions.join('\n');
            }
        }
        try { console.log('[ANALYZE] returning text preview:', (text || '').slice(0,200).replace(/\n/g,' ')); } catch(e){}
        res.status(200).json({ text });
    } catch (err) {
        console.error("❌ AI API Error:", err && err.message ? err.message : err);
        // If AI providers are not configured, provide a local, human-friendly fallback
        if (ALLOW_LOCAL_SCORING) {
            try {
                if (type === 'suggestions') {
                    const result = simpleKeywordScore(resume, jobDesc);
                    const missing = Array.isArray(result.weaknesses) ? result.weaknesses.slice(0, 8) : [];
                    let rewrittenResume = resume;
                    if (missing.length > 0) {
                        if (!/skills/i.test(resume)) {
                            rewrittenResume += `\n\nSkills:\n- ${missing.join('\n- ')}`;
                        } else {
                            rewrittenResume += `\n\n// Add these keywords to your Skills or Experience section:\n- ${missing.join('\n- ')}`;
                        }
                    }
                    const text = `Here is a rewritten version of your resume with missing keywords added for better job match:\n\n${rewrittenResume}`;
                    return res.status(200).json({ text });
                } else if (type === 'interview_questions') {
                    const questions = generateLocalInterviewQuestions(jobDesc);
                    const text = questions.join('\n');
                    return res.status(200).json({ text });
                }
            } catch (e) {
                console.error('Local fallback for suggestions/interview questions failed:', e && e.message ? e.message : e);
                return res.status(500).json({ message: 'Could not generate suggestions or interview questions.' });
            }
        }
        return res.status(500).json({ message: 'AI provider error.' });
    }
});
// Local fallback: generate generic interview questions from job description
function generateLocalInterviewQuestions(jobDesc) {
    // Extract some keywords from the job description
    const keywords = (jobDesc.match(/\b([A-Za-z][A-Za-z0-9\-\+]{2,})\b/g) || []).slice(0, 5);
    const questions = [
        `Can you describe your experience related to this job?`,
        `What interests you about this position?`,
        `How have you demonstrated skills relevant to this job?`,
        `What challenges do you expect in this role?`,
        `How do you stay updated with industry trends?`
    ];
    // Add keyword-based questions
    keywords.forEach(kw => {
        questions.push(`Can you discuss your experience with ${kw}?`);
    });
    // Number the questions so the frontend's splitting regex recognizes them reliably.
    return questions.slice(0, 5).map((q, i) => `${i+1}. ${q}`);
}
// (removed stray closing braces from previous endpoint)

app.get('/api/auth/google/callback', (req, res, next) => {
    if (!passport._strategy('google')) {
        const frontend = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
        console.warn('Google OAuth strategy not configured at callback.');
        return res.redirect(`${frontend}/?error=oauth_not_configured`);
    }
    passport.authenticate('google', { failureRedirect: '/' }, async (err, user) => {
        if (err || !user) {
            console.error('OAuth callback error:', err && err.message ? err.message : err);
            return res.redirect(`${process.env.FRONTEND_BASE_URL || 'http://localhost:3000'}/?error=google`);
        }
        try {
            // create a JWT that frontend can decode
            const token = jwt.sign({ id: user.id, email: user.email, name: user.displayName || '' }, process.env.JWT_SECRET || (process.env.SESSION_SECRET || 'dev-session-secret'), { expiresIn: '7d' });
            const redirectUrl = `${process.env.FRONTEND_BASE_URL || 'http://localhost:3000'}/?google_token=${token}`;
            console.log(`OAuth success for user ${user.email || user.id}, redirecting to frontend.`);
            return res.redirect(redirectUrl);
        } catch (e) {
            console.error('Error issuing JWT after OAuth:', e && e.message ? e.message : e);
            return res.redirect(`${process.env.FRONTEND_BASE_URL || 'http://localhost:3000'}/?error=google`);
        }
    })(req, res, next);
});

// Debug endpoint: returns server status (no secrets)
app.get('/api/debug/status', (req, res) => {
    const hasGoogle = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    res.json({
        googleConfigured: hasGoogle,
        dbAvailable,
        oauthFallbackCount: oauthUsers.size,
        frontendBase: process.env.FRONTEND_BASE_URL || 'http://localhost:3000',
        appBase: process.env.APP_BASE_URL || 'http://localhost:3000'
    });
});

// Direct password reset endpoint
app.post('/api/reset-password', async (req, res) => {
    const { email, newPassword } = req.body;
    
    if (!email || !newPassword) {
        return res.status(400).json({
            message: 'Email and new password are required.',
            success: false
        });
    }

    try {
        // Hash the new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update password directly
        const [result] = await pool.execute(
            'UPDATE users SET password = ? WHERE email = ?',
            [hashedPassword, email]
        );

        if (result.affectedRows > 0) {
            return res.json({
                message: 'Password has been reset successfully.',
                success: true
            });
        } else {
            return res.status(404).json({
                message: 'No account found with that email address.',
                success: false
            });
        }
    } catch (err) {
        console.error('Password reset error:', err);
        return res.status(500).json({
            message: 'Could not reset password. Please try again later.',
            success: false
        });
    }
});

// Helper route: verify token and return user payload
app.get('/api/auth/me', (req, res) => {
    const auth = req.headers.authorization;
    const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token || req.query.google_token;
    if (!token) return res.status(401).json({ message: 'No token provided.' });
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET || (process.env.SESSION_SECRET || 'dev-session-secret'));
        return res.json({ user: payload });
    } catch (err) {
        return res.status(401).json({ message: 'Invalid token.' });
    }
});

// --- Start Server ---
app.listen(port, async () => {
    try {
        await pool.query('SELECT 1');
        console.log("✅ Successfully connected to MySQL database.");
        dbAvailable = true;
    } catch (err) {
        console.warn("⚠️ Could not connect to MySQL. Continuing without DB - OAuth logins will use an in-memory store.");
        console.warn(err.message || err);
        dbAvailable = false;
    }
    console.log(`🚀 Server running at http://localhost:${port}`);
});

