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

// Middleware
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie']
}));

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// Session configuration
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

// File upload configuration
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
    },
    fileFilter: function(req, file, cb) {
        console.log('Uploading file:', file.originalname);
        cb(null, true);
    }
});

// Database
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

// Auth middleware
function requireAuth(req, res, next) {
    console.log('Auth check - Session userId:', req.session.userId);
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

// AUTH ENDPOINTS
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const db = loadDB();
    
    console.log('Login attempt:', username);
    
    if (username === db.admin.username) {
        if (bcrypt.compareSync(password, db.admin.password)) {
            req.session.userId = 'admin';
            req.session.username = username;
            req.session.role = 'admin';
            console.log('Admin login successful');
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
        console.log('User login successful:', user.id);
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

// ADMIN ENDPOINTS
app.post('/api/admin/create-user', requireAdmin, (req, res) => {
    const { username, password, email, dailyLimit } = req.body;
    const db = loadDB();
    
    if (db.users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'Username already exists' });
    }
    
    if (db.users.find(u => u.email === email)) {
        return res.status(400).json({ error: 'Email already exists' });
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
        stats: {
            totalSent: 0,
            totalFailed: 0,
            lastLogin: null
        }
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
        senderAccounts: u.senderAccounts.length,
        emails: u.emails.length
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
        totalSent: db.users.reduce((sum, u) => sum + u.stats.totalSent, 0),
        totalFailed: db.users.reduce((sum, u) => sum + u.stats.totalFailed, 0),
        totalEmails: db.users.reduce((sum, u) => sum + u.emails.length, 0),
        totalAccounts: db.users.reduce((sum, u) => sum + u.senderAccounts.length, 0)
    };
    res.json({ success: true, stats });
});

// USER ENDPOINTS
app.get('/api/user/data', requireAuth, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.session.userId);
    
    console.log('Getting user data for:', req.session.userId);
    
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
            stats: user.stats,
            dailyLimit: user.dailyLimit
        }
    });
});

app.post('/api/user/add-account', requireAuth, (req, res) => {
    const { email, password } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === req.session.userId);
    
    console.log('Adding account for user:', req.session.userId);
    console.log('Account email:', email);
    
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    // Check if account already exists
    if (user.senderAccounts && user.senderAccounts.find(acc => acc.email === email)) {
        return res.status(400).json({ error: 'Account already exists' });
    }
    
    if (!user.senderAccounts) {
        user.senderAccounts = [];
    }
    
    user.senderAccounts.push({
        email: email,
        password: password,
        sent: 0,
        dailySent: 0,
        addedAt: new Date().toISOString()
    });
    
    saveDB(db);
    console.log('Account added successfully');
    res.json({ success: true, message: 'Account added successfully' });
});

app.post('/api/user/add-email', requireAuth, (req, res) => {
    const { email, firstName, lastName, company } = req.body;
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
        firstName: firstName || '',
        lastName: lastName || '',
        company: company || '',
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
        console.log('Upload request received');
        console.log('Session userId:', req.session.userId);
        console.log('Files received:', req.files ? req.files.length : 0);
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'No files uploaded' 
            });
        }
        
        const files = req.files.map(file => ({
            filename: file.filename,
            originalname: file.originalname,
            path: file.path,
            size: file.size
        }));
        
        console.log('Files processed successfully:', files.length);
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
    const { to, subject, body, fromName, attachments, replyTo, cc, bcc, isHtml } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === req.session.userId);
    
    if (!user || !user.active) {
        return res.status(403).json({ error: 'Account inactive' });
    }
    
    if (!user.senderAccounts || user.senderAccounts.length === 0) {
        return res.status(400).json({ error: 'No sender accounts configured' });
    }
    
    const account = user.senderAccounts[0];
    
    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: account.email,
                pass: account.password
            }
        });
        
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
        
        if (cc) mailOptions.cc = cc;
        if (bcc) mailOptions.bcc = bcc;
        
        if (isHtml) {
            mailOptions.html = body;
        } else {
            mailOptions.text = body;
            mailOptions.html = body.replace(/\n/g, '<br>');
        }
        
        await transporter.sendMail(mailOptions);
        
        account.sent++;
        account.dailySent++;
        user.stats.totalSent++;
        
        saveDB(db);
        
        res.json({ 
            success: true, 
            message: `Email sent to ${to}`,
            sentCount: account.sent
        });
        
    } catch (error) {
        user.stats.totalFailed++;
        saveDB(db);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/send-campaign', requireAuth, async (req, res) => {
    const { recipients, subject, body, fromName, delay, attachments, replyTo, isHtml } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === req.session.userId);
    
    if (!user || !user.active) {
        return res.status(403).json({ error: 'Account inactive' });
    }
    
    if (!recipients || recipients.length === 0) {
        return res.status(400).json({ error: 'No recipients' });
    }
    
    if (!user.senderAccounts || user.senderAccounts.length === 0) {
        return res.status(400).json({ error: 'No sender accounts configured' });
    }
    
    sendCampaignInBackground(user.id, recipients, subject, body, fromName, delay || 60, attachments, replyTo, isHtml);
    
    res.json({ 
        success: true, 
        message: 'Campaign started',
        totalRecipients: recipients.length
    });
});

async function sendCampaignInBackground(userId, recipients, subject, body, fromName, delay, attachments, replyTo, isHtml) {
    let db = loadDB();
    let user = db.users.find(u => u.id === userId);
    
    if (!user) return;
    
    let accountIndex = 0;
    
    for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i];
        const account = user.senderAccounts[accountIndex];
        
        try {
            let personalizedSubject = replaceMergeTags(subject, recipient);
            let personalizedBody = replaceMergeTags(body, recipient);
            
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: account.email,
                    pass: account.password
                }
            });
            
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
            user.stats.totalSent++;
            
            db = loadDB();
            user = db.users.find(u => u.id === userId);
            const updatedAccount = user.senderAccounts[accountIndex];
            updatedAccount.sent = account.sent;
            updatedAccount.dailySent = account.dailySent;
            user.stats.totalSent = account.sent;
            saveDB(db);
            
            console.log(`✓ [${user.username}] Sent to ${recipient.email} (${i+1}/${recipients.length})`);
            
            accountIndex = (accountIndex + 1) % user.senderAccounts.length;
            
            if (i < recipients.length - 1) {
                const randomDelay = delay + (Math.random() * 30 - 15);
                await sleep(randomDelay * 1000);
            }
            
        } catch (error) {
            user.stats.totalFailed++;
            saveDB(db);
            console.error(`✗ [${user.username}] Failed: ${error.message}`);
        }
    }
}

function replaceMergeTags(text, recipient) {
    if (!text) return '';
    return text
        .replace(/{Email}/g, recipient.email || '')
        .replace(/{FirstName}/g, recipient.firstName || '')
        .replace(/{LastName}/g, recipient.lastName || '')
        .replace(/{Company}/g, recipient.company || '');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/api/test', (req, res) => {
    res.json({ 
        status: 'Multi-User Email Marketing Server Running!',
        version: '2.0',
        port: PORT
    });
});

// Serve index.html for root path
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`
╔═════════════════════════════════════════════════════════╗
║   MULTI-USER EMAIL MARKETING SYSTEM                     ║
║   Server: http://localhost:${PORT}                       ║
║                                                         ║
║   DEFAULT ADMIN LOGIN:                                  ║
║   Username: Digonta                                     ║
║   Password: Digonta123                                  ║
╚═════════════════════════════════════════════════════════╝
    `);
});
