require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const webpush    = require('web-push');

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dlya-svoikh-secret-key-change-in-prod';
const CLIENT_URL = process.env.CLIENT_URL || '*';

// VAPID keys for push notifications
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_EMAIL || 'admin@dlya-svoikh.app'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// ─────────────────────────────────────────
//  DATABASE
// ─────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      username    VARCHAR(50)  UNIQUE NOT NULL,
      name        VARCHAR(100) NOT NULL,
      phone       VARCHAR(30),
      bio         TEXT,
      pass_hash   TEXT NOT NULL,
      avatar_img  TEXT,
      avatar_emoji VARCHAR(10),
      online_status VARCHAR(20) DEFAULT 'online',
      today_status  VARCHAR(100),
      push_sub    TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chats (
      id         SERIAL PRIMARY KEY,
      type       VARCHAR(20) DEFAULT 'direct',
      name       VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id  INT REFERENCES chats(id) ON DELETE CASCADE,
      user_id  INT REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      chat_id    INT  REFERENCES chats(id) ON DELETE CASCADE,
      user_id    INT  REFERENCES users(id) ON DELETE CASCADE,
      type       VARCHAR(20) DEFAULT 'text',
      content    TEXT,
      file_url   TEXT,
      duration   VARCHAR(20),
      is_secret  BOOLEAN DEFAULT FALSE,
      unlocks_at TIMESTAMPTZ,
      reactions  JSONB DEFAULT '[]',
      status     VARCHAR(10) DEFAULT 'sent',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id       SERIAL PRIMARY KEY,
      user_id  INT REFERENCES users(id) ON DELETE CASCADE,
      sub_json TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Database initialized');
}

// ─────────────────────────────────────────
//  APP SETUP
// ─────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: CLIENT_URL, methods: ['GET','POST'] },
  maxHttpBufferSize: 10 * 1024 * 1024 // 10MB для файлов
});

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Uploads folder
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ─────────────────────────────────────────
//  AUTH MIDDLEWARE
// ─────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Токен недействителен' });
  }
}

// ─────────────────────────────────────────
//  REST API — AUTH
// ─────────────────────────────────────────

// Регистрация
app.post('/api/register', async (req, res) => {
  try {
    const { username, name, phone, password } = req.body;
    if (!username || !name || !password)
      return res.status(400).json({ error: 'Заполните все поля' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    const exists = await db.query('SELECT id FROM users WHERE username=$1', [username.toLowerCase()]);
    if (exists.rows.length)
      return res.status(400).json({ error: 'Логин уже занят' });

    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (username,name,phone,pass_hash) VALUES($1,$2,$3,$4) RETURNING id,username,name,phone,created_at',
      [username.toLowerCase(), name, phone||null, hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { ...user, tag: '@'+user.username } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Вход
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await db.query('SELECT * FROM users WHERE username=$1', [username.toLowerCase()]);
    if (!result.rows.length)
      return res.status(400).json({ error: 'Пользователь не найден' });

    const user = result.rows[0];
    const ok   = await bcrypt.compare(password, user.pass_hash);
    if (!ok) return res.status(400).json({ error: 'Неверный пароль' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    const { pass_hash, ...safeUser } = user;
    res.json({ token, user: { ...safeUser, tag: '@'+user.username } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить свой профиль
app.get('/api/me', authMiddleware, async (req, res) => {
  const r = await db.query('SELECT id,username,name,phone,bio,avatar_img,avatar_emoji,online_status,today_status,created_at FROM users WHERE id=$1', [req.user.id]);
  const u = r.rows[0];
  res.json({ ...u, tag: '@'+u.username });
});

// Обновить профиль
app.put('/api/me', authMiddleware, async (req, res) => {
  const { name, bio, phone, today_status, online_status, avatar_emoji, avatar_img } = req.body;
  await db.query(
    `UPDATE users SET
      name=$1, bio=$2, phone=$3,
      today_status=$4, online_status=$5,
      avatar_emoji=$6, avatar_img=$7
     WHERE id=$8`,
    [name, bio||null, phone||null, today_status||null, online_status||'online', avatar_emoji||null, avatar_img||null, req.user.id]
  );
  res.json({ ok: true });
});

// Поиск пользователей
app.get('/api/users/search', authMiddleware, async (req, res) => {
  const q = '%' + (req.query.q||'') + '%';
  const r = await db.query(
    `SELECT id,username,name,avatar_img,avatar_emoji,online_status,today_status FROM users
     WHERE (username ILIKE $1 OR name ILIKE $1) AND id != $2 LIMIT 20`,
    [q, req.user.id]
  );
  res.json(r.rows);
});

// ─────────────────────────────────────────
//  REST API — CHATS
// ─────────────────────────────────────────

// Получить список чатов
app.get('/api/chats', authMiddleware, async (req, res) => {
  const r = await db.query(`
    SELECT
      c.id, c.type, c.name,
      u2.id        AS other_id,
      u2.username  AS other_username,
      u2.name      AS other_name,
      u2.avatar_img AS other_avatar_img,
      u2.avatar_emoji AS other_avatar_emoji,
      u2.online_status AS other_online,
      (SELECT content FROM messages WHERE chat_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_msg,
      (SELECT type    FROM messages WHERE chat_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_type,
      (SELECT created_at FROM messages WHERE chat_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_time,
      (SELECT COUNT(*) FROM messages WHERE chat_id=c.id AND user_id != $1 AND status='sent') AS unread
    FROM chats c
    JOIN chat_members cm  ON cm.chat_id=c.id AND cm.user_id=$1
    LEFT JOIN chat_members cm2 ON cm2.chat_id=c.id AND cm2.user_id != $1
    LEFT JOIN users u2 ON u2.id=cm2.user_id
    ORDER BY last_time DESC NULLS LAST
  `, [req.user.id]);
  res.json(r.rows);
});

// Создать / найти direct чат
app.post('/api/chats/direct', authMiddleware, async (req, res) => {
  const { target_user_id, is_secret } = req.body;
  // Проверить существующий
  const existing = await db.query(`
    SELECT c.id FROM chats c
    JOIN chat_members a ON a.chat_id=c.id AND a.user_id=$1
    JOIN chat_members b ON b.chat_id=c.id AND b.user_id=$2
    WHERE c.type=$3
  `, [req.user.id, target_user_id, is_secret ? 'secret' : 'direct']);

  if (existing.rows.length) return res.json({ chat_id: existing.rows[0].id });

  const chat = await db.query(
    'INSERT INTO chats (type) VALUES($1) RETURNING id',
    [is_secret ? 'secret' : 'direct']
  );
  const cid = chat.rows[0].id;
  await db.query('INSERT INTO chat_members VALUES($1,$2),($1,$3)', [cid, req.user.id, target_user_id]);
  res.json({ chat_id: cid });
});

// Создать группу
app.post('/api/chats/group', authMiddleware, async (req, res) => {
  const { name, member_ids } = req.body;
  const chat = await db.query('INSERT INTO chats (type,name) VALUES($2,$1) RETURNING id', [name, 'group']);
  const cid  = chat.rows[0].id;
  const all  = [req.user.id, ...(member_ids||[])];
  for (const uid of all) {
    await db.query('INSERT INTO chat_members VALUES($1,$2) ON CONFLICT DO NOTHING', [cid, uid]);
  }
  res.json({ chat_id: cid });
});

// Удалить чат
app.delete('/api/chats/:id', authMiddleware, async (req, res) => {
  await db.query('DELETE FROM chat_members WHERE chat_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  REST API — MESSAGES
// ─────────────────────────────────────────

// Получить сообщения
app.get('/api/chats/:id/messages', authMiddleware, async (req, res) => {
  // Проверить доступ
  const access = await db.query('SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!access.rows.length) return res.status(403).json({ error: 'Нет доступа' });

  const r = await db.query(`
    SELECT m.*, u.username, u.name, u.avatar_img, u.avatar_emoji
    FROM messages m
    JOIN users u ON u.id=m.user_id
    WHERE m.chat_id=$1
    ORDER BY m.created_at ASC
    LIMIT 100
  `, [req.params.id]);

  // Пометить как прочитанные
  await db.query(`UPDATE messages SET status='read' WHERE chat_id=$1 AND user_id != $2 AND status='sent'`, [req.params.id, req.user.id]);

  res.json(r.rows);
});

// Загрузить файл
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url, type: req.file.mimetype.startsWith('video') ? 'video' : 'image' });
});

// Push subscription
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  const sub = JSON.stringify(req.body);
  await db.query(
    'INSERT INTO push_subscriptions (user_id, sub_json) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [req.user.id, sub]
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  SOCKET.IO — реальное время
// ─────────────────────────────────────────
const onlineUsers = new Map(); // userId → socketId

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Нет токена'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Неверный токен'));
  }
});

io.on('connection', async (socket) => {
  const userId = socket.user.id;
  onlineUsers.set(userId, socket.id);
  console.log(`🟢 User ${socket.user.username} connected`);

  // Присоединить к комнатам своих чатов
  const chats = await db.query('SELECT chat_id FROM chat_members WHERE user_id=$1', [userId]);
  chats.rows.forEach(r => socket.join('chat:' + r.chat_id));

  // Уведомить всех что пользователь онлайн
  socket.broadcast.emit('user:online', { user_id: userId });

  // ── ОТПРАВИТЬ СООБЩЕНИЕ ──
  socket.on('message:send', async (data, ack) => {
    try {
      const { chat_id, type, content, file_url, duration, is_secret, unlocks_at } = data;

      // Проверить доступ к чату
      const access = await db.query('SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2', [chat_id, userId]);
      if (!access.rows.length) return ack && ack({ error: 'Нет доступа' });

      // Сохранить в БД
      const r = await db.query(`
        INSERT INTO messages (chat_id,user_id,type,content,file_url,duration,is_secret,unlocks_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [chat_id, userId, type||'text', content||null, file_url||null, duration||null, !!is_secret, unlocks_at||null]
      );
      const msg = r.rows[0];

      // Добавить данные юзера
      const userInfo = await db.query('SELECT username,name,avatar_img,avatar_emoji FROM users WHERE id=$1', [userId]);
      const fullMsg  = { ...msg, ...userInfo.rows[0] };

      // Отправить в комнату чата
      io.to('chat:' + chat_id).emit('message:new', fullMsg);

      // Push-уведомления оффлайн-пользователям
      const members = await db.query(
        'SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id != $2',
        [chat_id, userId]
      );
      for (const member of members.rows) {
        if (!onlineUsers.has(member.user_id)) {
          sendPushNotification(member.user_id, {
            title: userInfo.rows[0].name,
            body:  type === 'text' ? content : type === 'voice' ? '🎙️ Голосовое сообщение' : '📷 Фото',
            icon:  '/icons/icon-192.png',
          });
        }
      }

      ack && ack({ ok: true, msg: fullMsg });
    } catch (e) {
      console.error(e);
      ack && ack({ error: 'Ошибка' });
    }
  });

  // ── ПЕЧАТАЕТ ──
  socket.on('typing:start', ({ chat_id }) => {
    socket.to('chat:' + chat_id).emit('typing:start', { user_id: userId, chat_id });
  });
  socket.on('typing:stop', ({ chat_id }) => {
    socket.to('chat:' + chat_id).emit('typing:stop', { user_id: userId, chat_id });
  });

  // ── РЕАКЦИЯ ──
  socket.on('message:react', async ({ msg_id, emoji, chat_id }) => {
    const r = await db.query('SELECT reactions FROM messages WHERE id=$1', [msg_id]);
    if (!r.rows.length) return;
    let reactions = r.rows[0].reactions || [];
    const existing = reactions.findIndex(r => r.user_id === userId && r.emoji === emoji);
    if (existing >= 0) reactions.splice(existing, 1);
    else reactions.push({ user_id: userId, emoji });
    await db.query('UPDATE messages SET reactions=$1 WHERE id=$2', [JSON.stringify(reactions), msg_id]);
    io.to('chat:' + chat_id).emit('message:reacted', { msg_id, reactions });
  });

  // ── УДАЛИТЬ СООБЩЕНИЕ ──
  socket.on('message:delete', async ({ msg_id, chat_id }) => {
    await db.query('DELETE FROM messages WHERE id=$1 AND user_id=$2', [msg_id, userId]);
    io.to('chat:' + chat_id).emit('message:deleted', { msg_id, chat_id });
  });

  // ── ЗВОНОК ──
  socket.on('call:start', ({ target_user_id, type, chat_id }) => {
    const targetSocket = onlineUsers.get(target_user_id);
    if (targetSocket) {
      io.to(targetSocket).emit('call:incoming', { from_user_id: userId, type, chat_id });
    }
  });
  socket.on('call:accept',  ({ target_user_id }) => { const s=onlineUsers.get(target_user_id); if(s) io.to(s).emit('call:accepted',  { from_user_id: userId }); });
  socket.on('call:reject',  ({ target_user_id }) => { const s=onlineUsers.get(target_user_id); if(s) io.to(s).emit('call:rejected',  { from_user_id: userId }); });
  socket.on('call:end',     ({ target_user_id }) => { const s=onlineUsers.get(target_user_id); if(s) io.to(s).emit('call:ended',     { from_user_id: userId }); });
  socket.on('call:signal',  ({ target_user_id, signal }) => { const s=onlineUsers.get(target_user_id); if(s) io.to(s).emit('call:signal',  { from_user_id: userId, signal }); });

  // ── ОТКЛЮЧЕНИЕ ──
  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    socket.broadcast.emit('user:offline', { user_id: userId });
    console.log(`🔴 User ${socket.user.username} disconnected`);
  });
});

// ─────────────────────────────────────────
//  PUSH NOTIFICATIONS
// ─────────────────────────────────────────
async function sendPushNotification(userId, payload) {
  try {
    const subs = await db.query('SELECT sub_json FROM push_subscriptions WHERE user_id=$1', [userId]);
    for (const row of subs.rows) {
      try {
        await webpush.sendNotification(JSON.parse(row.sub_json), JSON.stringify(payload));
      } catch (e) {
        if (e.statusCode === 410) {
          await db.query('DELETE FROM push_subscriptions WHERE user_id=$1', [userId]);
        }
      }
    }
  } catch (e) {
    console.error('Push error:', e.message);
  }
}

// ─────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));
app.get('/',       (req, res) => res.json({ name: 'Для своих API', version: '1.0.0' }));

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
  });
}).catch(err => {
  console.error('DB init error:', err);
  process.exit(1);
});
