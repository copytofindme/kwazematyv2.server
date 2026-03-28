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

const limiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: 'Слишком много запросов' } });
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

const CASES = {
    1: [
        { name: "Amour plastique",  power: 1,   chance: 35  },
        { name: "Я НЕ ПЕРДЕЛ",     power: 3,   chance: 25  },
        { name: "Еврейское логово", power: 6,   chance: 20  },
        { name: "ПАРНУХА",          power: 15,  chance: 10  },
        { name: "TURKISH KILLER",   power: 30,  chance: 7   },
        { name: "Иисус",            power: 100, chance: 2.5 },
        { name: "АХнежка",          power: 500, chance: 0.5 },
    ],
    2: [
        { name: "Персонаж 2-1", power: 1,   chance: 35  },
        { name: "Персонаж 2-2", power: 3,   chance: 25  },
        { name: "Персонаж 2-3", power: 6,   chance: 20  },
        { name: "Персонаж 2-4", power: 15,  chance: 10  },
        { name: "Персонаж 2-5", power: 30,  chance: 7   },
        { name: "Персонаж 2-6", power: 100, chance: 2.5 },
        { name: "Секрет 2",     power: 500, chance: 0.5 },
    ],
    3: [
        { name: "Персонаж 3-1", power: 1,   chance: 35  },
        { name: "Персонаж 3-2", power: 3,   chance: 25  },
        { name: "Персонаж 3-3", power: 6,   chance: 20  },
        { name: "Персонаж 3-4", power: 15,  chance: 10  },
        { name: "Персонаж 3-5", power: 30,  chance: 7   },
        { name: "Персонаж 3-6", power: 100, chance: 2.5 },
        { name: "Секрет 3",     power: 500, chance: 0.5 },
    ]
};

function pickWinner(caseId) {
    const items = CASES[caseId];
    if (!items) return null;
    const total = items.reduce((s, i) => s + i.chance, 0);
    let rnd = Math.random() * total;
    for (const item of items) {
        rnd -= item.chance;
        if (rnd <= 0) return item;
    }
    return items[items.length - 1];
}

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
    const { initData, caseId } = req.body;

    const user = verifyTelegram(initData);
    if (!user) return res.status(401).json({ error: 'Недействительная подпись' });

    const caseNum = parseInt(caseId) || 1;
    if (!CASES[caseNum]) return res.status(400).json({ error: 'Неизвестный кейс' });

    const userId = String(user.id);
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (userDoc.exists) {
        const lastSpin = userDoc.data().lastSpin?.toDate?.();
        if (lastSpin && (Date.now() - lastSpin.getTime()) < 5000) {
            return res.status(429).json({ error: 'Слишком быстро!' });
        }
    }

    const winner = pickWinner(caseNum);

    await db.runTransaction(async (t) => {
        const doc = await t.get(userRef);
        const existing = doc.exists ? doc.data() : {};
        const itemCounts = existing.itemCounts || {};
        itemCounts[winner.name] = (itemCounts[winner.name] || 0) + 1;
        const totalPower = (existing.totalPower || 0) + winner.power;
        t.set(userRef, {
            firstName: user.first_name || 'Игрок',
            username: user.username || null,
            photoUrl: user.photo_url || null,
            totalPower,
            itemCounts,
            lastSpin: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
    });

    res.json({ winner: winner.name, power: winner.power });
});

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
