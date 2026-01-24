const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'X-Requested-With']
}));

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: 'email-marketing-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    }
}));

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        const userDir = `${uploadDir}/${req.session.userId || 'temp'}`;
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }
        cb(null, userDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: 25 * 1024 * 1024,
        files: 10
    }
});

const DB_FILE = './database.json';

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        const initialDB = {
            users: [],
            admin: {
                username: 'Digonta',
                password: bcrypt.hashSync('Digonta123', 10),
                email: 'digonta@system.com',
                role: 'admin'
            }
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialDB, null, 2));
        return initialDB;
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.userId || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// Detect email provider from email address
function getEmailProvider(email) {
    const domain = email.split('@')[1].toLowerCase();
    
    const providers = {
        'gmail.com': {
            host: 'smtp.gmail.com',
            port: 465,
            secure: true
        },
        'outlook.com': {
            host: 'smtp-mail.outlook.com',
            port: 587,
            secure: false
        },
        'hotmail.com': {
            host: 'smtp-mail.outlook.com',
            port: 587,
            secure: false
        },
        'yahoo.com': {
            host: 'smtp.mail.yahoo.com',
            port: 465,
            secure: true
        },
        'zoho.com': {
            host: 'smtp.zoho.com',
            port: 465,
            secure: true
        }
    };
    
    return providers[domain] || {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true
    };
}

// Create transporter with retry logic
async function createTransporter(email, password) {
    const provider = getEmailProvider(email);
    
    const config = {
        host: provider.host,
        port: provider.port,
        secure: provider.secure,
        auth: {
            user: email,
            pass: password
        },
        tls: {
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2'
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 15000,
        pool: true,
        maxConnections: 1,
        maxMessages: 100
    };
    
    const transporter = nodemailer.createTransport(config);
    
    try {
        await transporter.verify();
        console.log(`✓ Connected to ${provider.host}`);
        return transporter;
    } catch (error) {
        console.error(`✗ Failed to connect to ${provider.host}:`, error.message);
        
        // Try alternative port
        if (provider.port === 465) {
            console.log('Trying port 587...');
            config.port = 587;
            config.secure = false;
            const altTransporter = nodemailer.createTransport(config);
            await altTransporter.verify();
            return altTransporter;
        } else {
            console.log('Trying port 465...');
            config.port = 465;
            config.secure = true;
            const altTransporter = nodemailer.createTransport(config);
            await altTransporter.verify();
            return altTransporter;
        }
    }
}

function addSpamBypassHeaders(mailOptions, fromName, senderEmail) {
    const now = new Date();
    
    mailOptions.headers = {
        'X-Mailer': 'Microsoft Outlook 16.0',
        'X-Priority': '3',
        'X-MSMail-Priority': 'Normal',
        'Importance': 'Normal',
        'Message-ID': `<${Date.now()}.${Math.random().toString(36).substring(7)}@${senderEmail.split('@')[1]}>`,
        'Date': now.toUTCString(),
        'MIME-Version': '1.0',
        'List-Unsubscribe': `<mailto:unsubscribe@${senderEmail.split('@')[1]}>`
    };
    
    return mailOptions;
}

function cleanEmailContent(text) {
    if (!text) return '';
    
    const spamWords = ['free', 'click here', 'buy now', 'limited time', 'act now', 'winner', 'congratulations'];
    let cleaned = text;
    
    spamWords.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        cleaned = cleaned.replace(regex, word.split('').join('\u200B'));
    });
    
    return cleaned;
}

// AUTH
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const db = loadDB();
    
    if (username === db.admin.username) {
        if (bcrypt.compareSync(password, db.admin.password)) {
            req.session.userId = 'admin';
            req.session.username = username;
            req.session.role = 'admin';
            return res.json({ 
                success: true, 
                role: 'admin',
                username: username 
            });
        }
    }
    
    const user = db.users.find(u => u.username === username);
    if (user && bcrypt.compareSync(password, user.password)) {
        if (!user.active) {
            return res.status(403).json({ error: 'Account deactivated' });
        }
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = 'user';
        return res.json({ 
            success: true, 
            role: 'user',
            username: user.username 
        });
    }
    
    res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
    if (req.session.userId) {
        res.json({ 
            authenticated: true,
            username: req.session.username,
            role: req.session.role
        });
    } else {
        res.json({ authenticated: false });
    }
});

// ADMIN
app.post('/api/admin/create-user', requireAdmin, (req, res) => {
    const { username, password, email, dailyLimit } = req.body;
    const db = loadDB();
    
    if (db.users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'Username exists' });
    }
    
    if (db.users.find(u => u.email === email)) {
        return res.status(400).json({ error: 'Email exists' });
    }
    
    const newUser = {
        id: Date.now().toString(),
        username: username,
        password: bcrypt.hashSync(password, 10),
        email: email,
        dailyLimit: dailyLimit || 500,
        active: true,
        createdAt: new Date().toISOString(),
        senderAccounts: [],
        emails: [],
        stats: { totalSent: 0, totalFailed: 0 }
    };
    
    db.users.push(newUser);
    saveDB(db);
    res.json({ success: true, userId: newUser.id });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
    const db = loadDB();
    const users = db.users.map(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
        active: u.active,
        dailyLimit: u.dailyLimit,
        stats: u.stats,
        senderAccounts: u.senderAccounts ? u.senderAccounts.length : 0,
        emails: u.emails ? u.emails.length : 0
    }));
    res.json({ success: true, users });
});

app.post('/api/admin/update-user', requireAdmin, (req, res) => {
    const { userId, active, dailyLimit } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === userId);
    
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    if (active !== undefined) user.active = active;
    if (dailyLimit) user.dailyLimit = dailyLimit;
    
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/admin/delete-user', requireAdmin, (req, res) => {
    const { userId } = req.body;
    const db = loadDB();
    db.users = db.users.filter(u => u.id !== userId);
    saveDB(db);
    res.json({ success: true });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const db = loadDB();
    const stats = {
        totalUsers: db.users.length,
        activeUsers: db.users.filter(u => u.active).length,
        totalSent: db.users.reduce((sum, u) => sum + (u.stats.totalSent || 0), 0),
        totalFailed: db.users.reduce((sum, u) => sum + (u.stats.totalFailed || 0), 0),
        totalEmails: db.users.reduce((sum, u) => sum + (u.emails ? u.emails.length : 0), 0),
        totalAccounts: db.users.reduce((sum, u) => sum + (u.senderAccounts ? u.senderAccounts.length : 0), 0)
    };
    res.json({ success: true, stats });
});

// USER
app.get('/api/user/data', requireAuth, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.session.userId);
    
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
        success: true,
        data: {
            emails: user.emails || [],
            senderAccounts: (user.senderAccounts || []).map(acc => ({
                email: acc.email,
                sent: acc.sent || 0,
                dailySent: acc.dailySent || 0
            })),
            stats: user.stats || { totalSent: 0, totalFailed: 0 },
            dailyLimit: user.dailyLimit || 500
        }
    });
});

app.post('/api/user/add-account', requireAuth, (req, res) => {
    const { email, password } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === req.session.userId);
    
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    const cleanPassword = password.replace(/\s/g, '');
    
    if (!user.senderAccounts) {
        user.senderAccounts = [];
    }
    
    if (user.senderAccounts.find(acc => acc.email === email)) {
        return res.status(400).json({ error: 'Account exists' });
    }
    
    user.senderAccounts.push({
        email: email,
        password: cleanPassword,
        sent: 0,
        dailySent: 0,
        addedAt: new Date().toISOString()
    });
    
    saveDB(db);
    res.json({ success: true, message: 'Account added' });
});

app.post('/api/user/remove-account', requireAuth, (req, res) => {
    const { index } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === req.session.userId);
    
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    if (!user.senderAccounts || index < 0 || index >= user.senderAccounts.length) {
        return res.status(400).json({ error: 'Invalid account index' });
    }
    
    user.senderAccounts.splice(index, 1);
    saveDB(db);
    
    res.json({ success: true, message: 'Account removed' });
});

app.post('/api/user/add-email', requireAuth, (req, res) => {
    const { email } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === req.session.userId);
    
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }
    
    if (!user.emails) {
        user.emails = [];
    }
    
    user.emails.push({
        email: email,
        firstName: '',
        lastName: '',
        company: '',
        addedAt: new Date().toISOString()
    });
    
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/user/clear-emails', requireAuth, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.session.userId);
    
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    user.emails = [];
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/user/upload', requireAuth, upload.array('files', 10), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'No files' 
            });
        }
        
        const files = req.files.map(file => ({
            filename: file.filename,
            originalname: file.originalname,
            path: file.path,
            size: file.size
        }));
        
        res.json({ success: true, files: files });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.post('/api/user/send-email', requireAuth, async (req, res) => {
    const { to, subject, body, fromName, attachments } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === req.session.userId);
    
    if (!user || !user.active) {
        return res.status(403).json({ error: 'Account inactive' });
    }
    
    if (!user.senderAccounts || user.senderAccounts.length === 0) {
        return res.status(400).json({ error: 'No sender accounts' });
    }
    
    const account = user.senderAccounts[0];
    
    try {
        const transporter = await createTransporter(account.email, account.password);
        
        let emailAttachments = [];
        if (attachments && attachments.length > 0) {
            emailAttachments = attachments.map(att => ({
                filename: att.originalname,
                path: att.path
            }));
        }
        
        const cleanedSubject = cleanEmailContent(subject);
        const cleanedBody = cleanEmailContent(body);
        
        let mailOptions = {
            from: fromName ? `"${fromName}" <${account.email}>` : account.email,
            to: to,
            subject: cleanedSubject,
            text: cleanedBody,
            html: `<div style="font-family: Arial, sans-serif;">${cleanedBody.replace(/\n/g, '<br>')}</div>`,
            attachments: emailAttachments
        };
        
        mailOptions = addSpamBypassHeaders(mailOptions, fromName, account.email);
        
        await transporter.sendMail(mailOptions);
        
        account.sent++;
        account.dailySent++;
        user.stats.totalSent++;
        
        saveDB(db);
        
        res.json({ 
            success: true, 
            message: `Sent to ${to}`
        });
        
    } catch (error) {
        console.error('Send error:', error);
        user.stats.totalFailed++;
        saveDB(db);
        res.status(500).json({ 
            success: false, 
            error: `Failed: ${error.message}. Check your app password and try again.`
        });
    }
});

app.post('/api/user/send-campaign', requireAuth, async (req, res) => {
    const { recipients, subject, body, fromName, delay, attachments } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === req.session.userId);
    
    if (!user || !user.active) {
        return res.status(403).json({ error: 'Account inactive' });
    }
    
    if (!recipients || recipients.length === 0) {
        return res.status(400).json({ error: 'No recipients' });
    }
    
    if (!user.senderAccounts || user.senderAccounts.length === 0) {
        return res.status(400).json({ error: 'No sender accounts' });
    }
    
    sendCampaignInBackground(user.id, recipients, subject, body, fromName, delay || 60, attachments);
    
    res.json({ 
        success: true, 
        message: 'Campaign started',
        totalRecipients: recipients.length
    });
});

async function sendCampaignInBackground(userId, recipients, subject, body, fromName, delay, attachments) {
    let db = loadDB();
    let user = db.users.find(u => u.id === userId);
    
    if (!user) return;
    
    let accountIndex = 0;
    let transporter = null;
    
    for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i];
        const account = user.senderAccounts[accountIndex];
        
        try {
            if (!transporter) {
                transporter = await createTransporter(account.email, account.password);
            }
            
            let emailAttachments = [];
            if (attachments && attachments.length > 0) {
                emailAttachments = attachments.map(att => ({
                    filename: att.originalname,
                    path: att.path
                }));
            }
            
            const cleanedSubject = cleanEmailContent(subject);
            const cleanedBody = cleanEmailContent(body);
            
            let mailOptions = {
                from: fromName ? `"${fromName}" <${account.email}>` : account.email,
                to: recipient.email,
                subject: cleanedSubject,
                text: cleanedBody,
                html: `<div style="font-family: Arial, sans-serif;">${cleanedBody.replace(/\n/g, '<br>')}</div>`,
                attachments: emailAttachments
            };
            
            mailOptions = addSpamBypassHeaders(mailOptions, fromName, account.email);
            
            await transporter.sendMail(mailOptions);
            
            account.sent++;
            account.dailySent++;
            user.stats.totalSent++;
            
            db = loadDB();
            user = db.users.find(u => u.id === userId);
            const updatedAccount = user.senderAccounts[accountIndex];
            updatedAccount.sent = account.sent;
            updatedAccount.dailySent = account.dailySent;
            user.stats.totalSent = account.sent;
            saveDB(db);
            
            console.log(`✓ Sent to ${recipient.email} (${i+1}/${recipients.length})`);
            
            accountIndex = (accountIndex + 1) % user.senderAccounts.length;
            
            if (accountIndex === 0 && transporter) {
                transporter.close();
                transporter = null;
            }
            
            if (i < recipients.length - 1) {
                const randomDelay = delay + (Math.random() * 30 - 15);
                await sleep(randomDelay * 1000);
            }
            
        } catch (error) {
            user.stats.totalFailed++;
            saveDB(db);
            console.error(`✗ Failed to ${recipient.email}: ${error.message}`);
            
            if (transporter) {
                transporter.close();
                transporter = null;
            }
        }
    }
    
    if (transporter) {
        transporter.close();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/api/test', (req, res) => {
    res.json({ 
        status: 'Running',
        version: '2.2',
        port: PORT
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════╗
║   EMAIL MARKETING SYSTEM v2.2             ║
║   Port: ${PORT}                            ║
║   ✓ Multi-provider support                ║
║   ✓ Auto port detection                   ║
║   ✓ Spam bypass enabled                   ║
╚═══════════════════════════════════════════╝
    `);
});
