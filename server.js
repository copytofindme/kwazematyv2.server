const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());
const limiter = rateLimit({
    windowMs: 60 * 1000,  
    max: 30,             
    message: { error: 'Слишком много запросов' }
});
app.use(limiter);
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    })
});
const db = admin.firestore();
const BOT_TOKEN = process.env.BOT_TOKEN;

function verifyTelegram(initData) {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    params.delete('hash');
    const dataStr = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataStr).digest('hex');
    return expectedHash === hash;
}

app.post('/spin', async (req, res) => {
    const { initData, winner } = req.body;
    if (!initData || !verifyTelegram(initData)) {
        return res.status(401).json({ error: 'Недействительная подпись Telegram' });
    }
    const params = new URLSearchParams(initData);
    const user = JSON.parse(params.get('user'));
    const userId = String(user.id);
    const userRef = db.collection('users').doc(userId);
    await db.runTransaction(async (t) => {
        const doc = await t.get(userRef);
        const existing = doc.exists ? doc.data() : {};
        const itemCounts = existing.itemCounts || {};
        itemCounts[winner.name] = (itemCounts[winner.name] || 0) + 1;
        const totalPower = (existing.totalPower || 0) + (winner.power || 0);
        t.set(userRef, {
            firstName: user.first_name || 'Игрок',
            username: user.username || null,
            photoUrl: user.photo_url || null,
            totalPower, itemCounts,
            lastSpin: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
    });
    res.json({ success: true });
});

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
