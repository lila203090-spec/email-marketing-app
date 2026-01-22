const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// File upload configuration
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit
});

// Store sender accounts
let senderAccounts = [];
let campaignStats = {
    totalSent: 0,
    totalFailed: 0,
    lastCampaignTime: null
};

// Add sender account endpoint
app.post('/api/add-account', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    senderAccounts.push({ email, password, sent: 0, dailySent: 0 });
    res.json({ success: true, message: 'Account added successfully' });
});

// Get accounts endpoint
app.get('/api/accounts', (req, res) => {
    res.json({ 
        accounts: senderAccounts.map(acc => ({ 
            email: acc.email, 
            sent: acc.sent,
            dailySent: acc.dailySent 
        })) 
    });
});

// Upload attachments endpoint
app.post('/api/upload-attachments', upload.array('files', 10), (req, res) => {
    try {
        const files = req.files.map(file => ({
            filename: file.filename,
            originalname: file.originalname,
            path: file.path,
            size: file.size
        }));
        
        res.json({ success: true, files: files });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Send single email with attachments
app.post('/api/send-email', async (req, res) => {
    const { to, subject, body, fromName, accountIndex, attachments, replyTo, cc, bcc, isHtml } = req.body;
    
    if (!to || !subject || !body) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (senderAccounts.length === 0) {
        return res.status(400).json({ error: 'No sender accounts configured' });
    }
    
    const account = senderAccounts[accountIndex || 0];
    
    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: account.email,
                pass: account.password
            }
        });
        
        // Prepare attachments
        let emailAttachments = [];
        if (attachments && attachments.length > 0) {
            emailAttachments = attachments.map(att => ({
                filename: att.originalname,
                path: att.path
            }));
        }
        
        const mailOptions = {
            from: fromName ? `"${fromName}" <${account.email}>` : account.email,
            to: to,
            subject: subject,
            replyTo: replyTo || account.email,
            attachments: emailAttachments
        };
        
        // Add CC/BCC if provided
        if (cc) mailOptions.cc = cc;
        if (bcc) mailOptions.bcc = bcc;
        
        // Set body as HTML or plain text
        if (isHtml) {
            mailOptions.html = body;
        } else {
            mailOptions.text = body;
            mailOptions.html = body.replace(/\n/g, '<br>');
        }
        
        await transporter.sendMail(mailOptions);
        
        account.sent++;
        account.dailySent++;
        campaignStats.totalSent++;
        
        res.json({ 
            success: true, 
            message: `Email sent to ${to}`,
            sentCount: account.sent
        });
        
    } catch (error) {
        console.error('Email send error:', error);
        campaignStats.totalFailed++;
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Bulk send endpoint with attachments
app.post('/api/send-campaign', async (req, res) => {
    const { recipients, subject, body, fromName, delay, attachments, replyTo, isHtml } = req.body;
    
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: 'Recipients array required' });
    }
    
    if (senderAccounts.length === 0) {
        return res.status(400).json({ error: 'No sender accounts configured' });
    }
    
    campaignStats.lastCampaignTime = new Date();
    
    // Start sending in background
    sendCampaignInBackground(recipients, subject, body, fromName, delay || 60, attachments, replyTo, isHtml);
    
    res.json({ 
        success: true, 
        message: 'Campaign started',
        totalRecipients: recipients.length
    });
});

// Background campaign sender
async function sendCampaignInBackground(recipients, subject, body, fromName, delay, attachments, replyTo, isHtml) {
    let sent = 0;
    let failed = 0;
    let accountIndex = 0;
    
    for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i];
        const account = senderAccounts[accountIndex];
        
        try {
            // Replace merge tags
            let personalizedSubject = replaceMergeTags(subject, recipient);
            let personalizedBody = replaceMergeTags(body, recipient);
            
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: account.email,
                    pass: account.password
                }
            });
            
            // Prepare attachments
            let emailAttachments = [];
            if (attachments && attachments.length > 0) {
                emailAttachments = attachments.map(att => ({
                    filename: att.originalname,
                    path: att.path
                }));
            }
            
            const mailOptions = {
                from: fromName ? `"${fromName}" <${account.email}>` : account.email,
                to: recipient.email,
                subject: personalizedSubject,
                replyTo: replyTo || account.email,
                attachments: emailAttachments
            };
            
            if (isHtml) {
                mailOptions.html = personalizedBody;
            } else {
                mailOptions.text = personalizedBody;
                mailOptions.html = personalizedBody.replace(/\n/g, '<br>');
            }
            
            await transporter.sendMail(mailOptions);
            
            account.sent++;
            account.dailySent++;
            sent++;
            campaignStats.totalSent++;
            
            console.log(`✓ Sent to ${recipient.email} (${sent}/${recipients.length})`);
            
            // Rotate accounts
            accountIndex = (accountIndex + 1) % senderAccounts.length;
            
            // Add delay with randomization
            if (i < recipients.length - 1) {
                const randomDelay = delay + (Math.random() * 30 - 15);
                await sleep(randomDelay * 1000);
            }
            
        } catch (error) {
            failed++;
            campaignStats.totalFailed++;
            console.error(`✗ Failed to send to ${recipient.email}:`, error.message);
        }
    }
    
    console.log(`Campaign complete! Sent: ${sent}, Failed: ${failed}`);
}

// Helper function to replace merge tags
function replaceMergeTags(text, recipient) {
    return text
        .replace(/{Email}/g, recipient.email || '')
        .replace(/{FirstName}/g, recipient.firstName || '')
        .replace(/{LastName}/g, recipient.lastName || '')
        .replace(/{Company}/g, recipient.company || '')
        .replace(/{Phone}/g, recipient.phone || '')
        .replace(/{City}/g, recipient.city || '')
        .replace(/{Country}/g, recipient.country || '')
        .replace(/{Custom1}/g, recipient.custom1 || '')
        .replace(/{Custom2}/g, recipient.custom2 || '');
}

// Helper function for delay
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Test endpoint
app.get('/api/test', (req, res) => {
    res.json({ 
        status: 'Server is running!',
        accounts: senderAccounts.length,
        stats: campaignStats,
        port: PORT
    });
});

// Get campaign stats
app.get('/api/stats', (req, res) => {
    res.json({
        success: true,
        stats: campaignStats,
        accounts: senderAccounts.map(acc => ({
            email: acc.email,
            sent: acc.sent,
            dailySent: acc.dailySent
        }))
    });
});

// Reset daily counters (run this daily via cron job)
app.post('/api/reset-daily', (req, res) => {
    senderAccounts.forEach(acc => acc.dailySent = 0);
    res.json({ success: true, message: 'Daily counters reset' });
});

// Verify email endpoint (advanced validation)
app.post('/api/verify-email', async (req, res) => {
    const { email } = req.body;
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const isValid = emailRegex.test(email);
    
    // Additional checks
    const disposableDomains = ['tempmail.com', '10minutemail.com', 'guerrillamail.com'];
    const domain = email.split('@')[1];
    const isDisposable = disposableDomains.includes(domain);
    
    res.json({
        email: email,
        valid: isValid && !isDisposable,
        reason: !isValid ? 'Invalid format' : isDisposable ? 'Disposable email' : 'Valid'
    });
});

// Clean up old uploaded files
app.post('/api/cleanup-uploads', (req, res) => {
    const uploadDir = './uploads';
    if (fs.existsSync(uploadDir)) {
        const files = fs.readdirSync(uploadDir);
        const now = Date.now();
        let deleted = 0;
        
        files.forEach(file => {
            const filePath = path.join(uploadDir, file);
            const stats = fs.statSync(filePath);
            const age = now - stats.mtimeMs;
            
            // Delete files older than 24 hours
            if (age > 24 * 60 * 60 * 1000) {
                fs.unlinkSync(filePath);
                deleted++;
            }
        });
        
        res.json({ success: true, deleted: deleted });
    } else {
        res.json({ success: true, deleted: 0 });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║   Email Marketing Backend Server - ENHANCED    ║
║   Server running on http://localhost:${PORT}    ║
║                                                ║
║   NEW FEATURES:                                ║
║   ✓ PDF & File Attachments (up to 25MB)       ║
║   ✓ HTML Email Support                         ║
║   ✓ CC/BCC Support                             ║
║   ✓ Reply-To Configuration                     ║
║   ✓ Advanced Statistics                        ║
║   ✓ Daily Limits Tracking                      ║
║                                                ║
║   API Endpoints:                               ║
║   POST /api/add-account                        ║
║   POST /api/send-email                         ║
║   POST /api/send-campaign                      ║
║   POST /api/upload-attachments                 ║
║   POST /api/verify-email                       ║
║   GET  /api/test                               ║
║   GET  /api/stats                              ║
╚════════════════════════════════════════════════╝
    `);
});