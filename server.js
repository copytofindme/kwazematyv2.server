const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Слишком много запросов' }
});
app.use(limiter);

admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    })
});
const db = admin.firestore();
const BOT_TOKEN = process.env.BOT_TOKEN;

const VALID_ITEMS = {
    "Amour plastique":  1,
    "Я НЕ ПЕРДЕЛ":     3,
    "Еврейское логово": 6,
    "ПАРНУХА":          15,
    "TURKISH KILLER":   30,
    "Иисус":            100,
    "АХнежка":          500,
    "Персонаж 2-1":     1,
    "Персонаж 2-2":     3,
    "Персонаж 2-3":     6,
    "Персонаж 2-4":     15,
    "Персонаж 2-5":     30,
    "Персонаж 2-6":     100,
    "Секрет 2":         500,
    "Персонаж 3-1":     1,
    "Персонаж 3-2":     3,
    "Персонаж 3-3":     6,
    "Персонаж 3-4":     15,
    "Персонаж 3-5":     30,
    "Персонаж 3-6":     100,
    "Секрет 3":         500,
};

function verifyTelegram(initData) {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const authDate = parseInt(params.get('auth_date') || '0');
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 300) return null;
    const dataStr = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataStr).digest('hex');
    if (expectedHash !== hash) return null;

    return JSON.parse(params.get('user'));
}

app.post('/spin', async (req, res) => {
    const { initData, winner } = req.body;

    const user = verifyTelegram(initData);
    if (!user) {
        return res.status(401).json({ error: 'Недействительная или устаревшая подпись Telegram' });
    }

    const realPower = VALID_ITEMS[winner.name];
    if (realPower === undefined) {
        return res.status(400).json({ error: 'Неизвестный предмет' });
    }

    const queryId = new URLSearchParams(initData).get('query_id');
    if (queryId) {
        const replayRef = db.collection('used_tokens').doc(queryId);
        const existing = await replayRef.get();
        if (existing.exists) {
            return res.status(429).json({ error: 'Токен уже использован' });
        }
        // Сохраняем токен на 10 минут
        await replayRef.set({ usedAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    const userId = String(user.id);
    const userRef = db.collection('users').doc(userId);
    await db.runTransaction(async (t) => {
        const doc = await t.get(userRef);
        const existing = doc.exists ? doc.data() : {};
        const itemCounts = existing.itemCounts || {};
        itemCounts[winner.name] = (itemCounts[winner.name] || 0) + 1;
        const totalPower = (existing.totalPower || 0) + realPower; // мощь с сервера!
        t.set(userRef, {
            firstName: user.first_name || 'Игрок',
            username: user.username || null,
            photoUrl: user.photo_url || null,
            totalPower,
            itemCounts,
            lastSpin: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
    });

    res.json({ success: true });
});

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
