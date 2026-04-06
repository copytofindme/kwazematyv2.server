const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-session-id');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.set('trust proxy', 1);
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Слишком много запросов' } });
app.use(limiter);

const REQUIRED_ENV = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'BOT_TOKEN'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) { console.error('❌ Отсутствуют переменные:', missing.join(', ')); process.exit(1); }

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

const BATCH_SIZE = 10;
const COMMIT_DELAY_MS = 500;
const SPIN_EXPIRY_MS = 30 * 60 * 1000;

const commitLock = new Set();
const lastCommitDone = new Map();
const lastBatchRequest = new Map();
const MIN_BETWEEN_COMMITS_MS = 6000;
const MIN_BETWEEN_BATCHES_MS = 20000;
const MIN_SPIN_AGE_MS = 1000;

function pickWinner(caseId) {
    const items = CASES[caseId];
    if (!items) return null;
    const total = items.reduce((s, i) => s + i.chance, 0);
    let rnd = Math.random() * total;
    for (const item of items) { rnd -= item.chance; if (rnd <= 0) return item; }
    return items[items.length - 1];
}

function verifyTelegram(initData) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return null;
        params.delete('hash');
        const authDate = parseInt(params.get('auth_date') || '0');
        if (Math.floor(Date.now() / 1000) - authDate > 86400) return null;
        const dataStr = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`).join('\n');
        const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const expected = crypto.createHmac('sha256', secret).update(dataStr).digest('hex');
        if (expected !== hash) return null;
        return JSON.parse(params.get('user'));
    } catch { return null; }
}

app.get('/health', (req, res) => res.json({ ok: true }));


app.post('/batch', async (req, res) => {
    const { initData, caseId } = req.body;

    const user = verifyTelegram(initData);
    if (!user) return res.status(401).json({ error: 'Недействительная подпись' });

    const caseNum = parseInt(caseId) || 1;
    if (!CASES[caseNum]) return res.status(400).json({ error: 'Неизвестный кейс' });

    const userId = String(user.id);
    const pendingRef = db.collection('pending_spins').doc(userId);
    const now = Date.now();

    const lastBatch = lastBatchRequest.get(userId) || 0;
    if (now - lastBatch < MIN_BETWEEN_BATCHES_MS) {
        const doc = await pendingRef.get();
        const existing = (doc.exists ? doc.data().spins || [] : [])
            .filter(s => s.caseId === caseNum && !s.used && !s.committed && (now - s.createdAt) < SPIN_EXPIRY_MS);
        return res.json({ ok: true, spins: existing.map(s => ({ id: s.id, winner: s.winner, power: s.power })) });
    }
    lastBatchRequest.set(userId, now);

    const doc = await pendingRef.get();
    const existing = (doc.exists ? doc.data().spins || [] : [])
        .filter(s => s.caseId === caseNum && !s.used && !s.committed && (now - s.createdAt) < SPIN_EXPIRY_MS);

    const toAdd = Math.max(0, BATCH_SIZE - existing.length);
    const newSpins = [];
    for (let i = 0; i < toAdd; i++) {
        const w = pickWinner(caseNum);
        newSpins.push({
            id: crypto.randomUUID(),
            caseId: caseNum,
            winner: w.name,
            power: w.power,
            used: false,
            committed: false,
            createdAt: now,
        });
    }

    const allSpins = [...existing, ...newSpins];
    await pendingRef.set({ spins: allSpins, updatedAt: now });

    res.json({
        ok: true,
        spins: allSpins.map(s => ({ id: s.id, winner: s.winner, power: s.power }))
    });
});

app.post('/commit', async (req, res) => {
    const { initData, spinId, deviceId } = req.body;

    const user = verifyTelegram(initData);
    if (!user) return res.status(401).json({ error: 'Недействительная подпись' });

    const userId = String(user.id);

    if (commitLock.has(userId)) {
        return res.json({ ok: true, skipped: true });
    }

    const lastDone = lastCommitDone.get(userId) || 0;
    const sinceLastCommit = Date.now() - lastDone;
    if (sinceLastCommit < MIN_BETWEEN_COMMITS_MS) {
        const waitMs = MIN_BETWEEN_COMMITS_MS - sinceLastCommit;
        return res.status(429).json({ error: `Слишком быстро. Подожди ${Math.ceil(waitMs / 1000)} сек.` });
    }

    const pendingRef = db.collection('pending_spins').doc(userId);
    const pendingDoc = await pendingRef.get();
    if (!pendingDoc.exists) return res.status(400).json({ error: 'Нет заготовленных спинов' });

    const spins = pendingDoc.data().spins || [];
    const spinIdx = spins.findIndex(s => s.id === spinId && !s.used && !s.committed);
    if (spinIdx === -1) return res.status(400).json({ error: 'Спин не найден или уже использован' });

    const spin = spins[spinIdx];

    if (Date.now() - spin.createdAt < MIN_SPIN_AGE_MS) {
        return res.status(400).json({ error: 'Спин слишком свежий' });
    }

    spins[spinIdx] = { ...spin, committed: true };
    await pendingRef.update({ spins });

    commitLock.add(userId);

    res.json({ ok: true, queued: true });

    setTimeout(async () => {
        try {
            const userRef = db.collection('users').doc(userId);
            await db.runTransaction(async (t) => {
                const doc = await t.get(userRef);
                const data = doc.exists ? doc.data() : {};
                const itemCounts = data.itemCounts || {};
                itemCounts[spin.winner] = (itemCounts[spin.winner] || 0) + 1;
                const totalPower = (data.totalPower || 0) + spin.power;
                t.set(userRef, {
                    firstName: user.first_name || 'Игрок',
                    username: user.username || null,
                    photoUrl: user.photo_url || null,
                    totalPower,
                    itemCounts,
                    lastSpin: admin.firestore.FieldValue.serverTimestamp(),
                    deviceId: deviceId || null,
                }, { merge: true });
            });

            const freshDoc = await pendingRef.get();
            if (freshDoc.exists) {
                const freshSpins = freshDoc.data().spins || [];
                const idx = freshSpins.findIndex(s => s.id === spinId);
                if (idx !== -1) { freshSpins[idx].used = true; await pendingRef.update({ spins: freshSpins }); }
            }

            console.log(`✅ committed user=${userId} winner=${spin.winner} power=${spin.power}`);
            lastCommitDone.set(userId, Date.now());
        } catch (e) {
            console.error('❌ commit error:', e);
        } finally {
            commitLock.delete(userId);
        }
    }, COMMIT_DELAY_MS);
});

app.listen(process.env.PORT || 3000, () => console.log('✅ Server running'));
