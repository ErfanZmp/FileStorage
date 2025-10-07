require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const mime = require('mime-types');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const session = require('express-session');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { finished } = require('stream/promises');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const PORT = Number(process.env.PORT) || 3001;
const MAX_FILE_SIZE = 150 * 1024 * 1024; // 150 MB
const DEFAULT_CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 2 * 1024 * 1024); // default 2 MB
const CHUNK_UPLOAD_LIMIT = Math.ceil(DEFAULT_CHUNK_SIZE * 1.5);
const IMAGE_MIME_PREFIX = 'image/';
const UPLOAD_DIR = path.resolve(__dirname, 'uploads');
const CHUNKS_DIR = path.join(UPLOAD_DIR, '.chunks');

const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.pdf', '.txt', '.zip', '.tar', '.gz', '.rar', '.7z',
  '.mp4', '.mov', '.mkv', '.avi', '.wmv', '.mp3', '.wav',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf',
]);

const ALLOWED_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'application/zip', 'application/x-zip-compressed',
  'application/x-tar', 'application/gzip', 'application/x-7z-compressed', 'application/vnd.rar',
  'video/mp4', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo', 'video/mpeg', 'video/x-ms-wmv',
  'audio/mpeg', 'audio/wav', 'audio/x-wav',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
]);
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-httpd-php',
  'application/sql',
  'application/x-sql',
]);

const getPreviewType = (mimeType = '') => {
  if (!mimeType) return null;
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('text/') || TEXT_MIME_TYPES.has(mimeType)) return 'text';
  return null;
};

const parseRange = (rangeHeader, size) => {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return null;
  }
  const [rawStart, rawEnd] = rangeHeader.replace(/bytes=/, '').split('-');
  let start = Number(rawStart);
  let end = Number(rawEnd);

  if (Number.isNaN(start)) {
    start = size - end;
    end = size - 1;
  }
  if (Number.isNaN(end) || end >= size) {
    end = size - 1;
  }
  if (start < 0 || start > end || end >= size) {
    return null;
  }
  return { start, end, size };
};

const streamWithRange = async (req, res, filePath, mimeType, { inlineName } = {}) => {
  const stats = await fsp.stat(filePath);
  const range = parseRange(req.headers.range, stats.size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');

  if (inlineName) {
    const encoded = encodeURIComponent(inlineName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
    res.setHeader('Content-Disposition', `inline; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  }

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${range.size}`);
    res.setHeader('Content-Length', range.end - range.start + 1);
    const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
    stream.on('error', (err) => {
      console.error('Preview stream error:', err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    stream.pipe(res);
    return;
  }

  res.setHeader('Content-Length', stats.size);
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    console.error('Preview stream error:', err);
    if (!res.headersSent) {
      res.status(500).end();
    }
  });
  stream.pipe(res);
};

const parseCorsOrigins = () => {
  const value = process.env.CORS_ORIGINS;
  if (!value) {
    return true;
  }
  const origins = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return origins.length ? origins : true;
};

const fileCors = cors({
  origin: parseCorsOrigins(),
  methods: ['GET', 'HEAD', 'OPTIONS'],
  credentials: false,
  maxAge: 86400,
});


const sanitizeFilename = (originalName) => {
  const base = path.basename(originalName);
  return base.replace(/[^A-Za-z0-9._-]/g, '_');
};

const generateStoredName = (originalName) => {
  const safeName = sanitizeFilename(originalName);
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return `${uniqueSuffix}-${safeName}`;
};

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => cb(null, generateStoredName(file.originalname)),
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const detectedMime = file.mimetype || mime.lookup(file.originalname) || 'application/octet-stream';

    if (!ALLOWED_EXTENSIONS.has(ext) && !ALLOWED_MIME_TYPES.has(detectedMime)) {
      file.mimetype = 'application/octet-stream';
    } else if (!file.mimetype) {
      file.mimetype = detectedMime;
    }

    cb(null, true);
  },
});

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHUNK_UPLOAD_LIMIT },
});

const ensureUploadsDir = async () => {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(CHUNKS_DIR, { recursive: true });
};

const presentFile = (file) => {
  const mimeType = file.mimeType || 'application/octet-stream';
  const uploadedAt = file.uploadedAt instanceof Date ? file.uploadedAt.toISOString() : file.uploadedAt;
  const previewType = getPreviewType(mimeType);
  return {
    id: file.id,
    name: file.originalName,
    size: file.size,
    mimeType,
    uploadedAt,
    isImage: previewType === 'image',
    isVideo: previewType === 'video',
    isAudio: previewType === 'audio',
    isPdf: previewType === 'pdf',
    isText: previewType === 'text',
    isPublic: Boolean(file.isPublic),
    previewType,
    downloadUrl: `/api/files/${file.id}/download`,
    previewUrl: previewType ? `/api/files/${file.id}/preview` : null,
    publicUrl: file.isPublic ? `/api/files/${file.id}/download` : null,
  };
};

const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  return next();
};

const app = express();
app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    name: 'filemanager.sid',
    secret: process.env.SESSION_SECRET || 'change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60, // 1 hour
    },
  })
);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/auth/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  res.json({ user: { id: req.session.userId, username: req.session.username } });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;

    res.json({ user: { id: user.id, username: user.username } });
  } catch (error) {
    console.error('Login failed:', error);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Failed to destroy session:', err);
      return res.status(500).json({ error: 'Logout failed.' });
    }
    res.clearCookie('filemanager.sid');
    res.status(204).send();
  });
});

app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const files = await prisma.file.findMany({ orderBy: { uploadedAt: 'desc' } });
    res.json({ files: files.map(presentFile) });
  } catch (error) {
    console.error('Failed to list files:', error);
    res.status(500).json({ error: 'Failed to read files.' });
  }
});

app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    const created = await prisma.file.create({
      data: {
        storedName: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedBy: req.session.userId ?? null,
        isPublic: false,
      },
    });

    res.status(201).json({ file: presentFile(created) });
  } catch (error) {
    console.error('Failed to save file metadata:', error);
    await fsp.unlink(req.file.path).catch(() => { /* ignore */ });
    res.status(500).json({ error: 'Failed to save file metadata.' });
  }
});

const validateFileType = (originalName, mimeType) => {
  const ext = path.extname(originalName).toLowerCase();
  const resolvedMime = mimeType || mime.lookup(originalName) || 'application/octet-stream';

  if (ALLOWED_EXTENSIONS.has(ext) || ALLOWED_MIME_TYPES.has(resolvedMime)) {
    return resolvedMime;
  }

  // Allow other files by default but mark them as generic binary.
  return 'application/octet-stream';
};

app.post('/api/upload/init', requireAuth, async (req, res) => {
  const { name, size, mimeType } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'File name is required.' });
  }
  const numericSize = Number(size);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    return res.status(400).json({ error: 'File size is invalid.' });
  }
  if (numericSize > MAX_FILE_SIZE) {
    return res.status(413).json({ error: 'File exceeds maximum allowed size (150 MB).' });
  }

  try {
    const resolvedMime = validateFileType(name, mimeType);
    const chunkSize = DEFAULT_CHUNK_SIZE;
    const totalChunks = Math.ceil(numericSize / chunkSize);
    const storedName = generateStoredName(name);

    const sessionRecord = await prisma.uploadSession.create({
      data: {
        originalName: name,
        storedName,
        mimeType: resolvedMime,
        size: numericSize,
        chunkSize,
        totalChunks,
        uploadedBy: req.session.userId ?? null,
      },
    });

    const sessionDir = path.join(CHUNKS_DIR, sessionRecord.id);
    await fsp.mkdir(sessionDir, { recursive: true });

    res.json({
      uploadId: sessionRecord.id,
      chunkSize,
      totalChunks,
    });
  } catch (error) {
    if (error.message === 'Unsupported file type.') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Upload init failed:', error);
    res.status(500).json({ error: 'Failed to prepare upload.' });
  }
});

app.post('/api/upload/chunk', requireAuth, chunkUpload.single('chunk'), async (req, res) => {
  const { uploadId, chunkIndex, totalChunks, size } = req.body || {};
  if (!uploadId) {
    return res.status(400).json({ error: 'uploadId is required.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Chunk payload missing.' });
  }

  const index = Number(chunkIndex);
  const expectedTotal = Number(totalChunks);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: 'Invalid chunk index.' });
  }
  if (!Number.isInteger(expectedTotal) || expectedTotal <= 0) {
    return res.status(400).json({ error: 'Invalid total chunk count.' });
  }

  try {
    const sessionRecord = await prisma.uploadSession.findUnique({ where: { id: uploadId } });
    if (!sessionRecord) {
      return res.status(404).json({ error: 'Upload session not found.' });
    }

    if (index >= sessionRecord.totalChunks || expectedTotal !== sessionRecord.totalChunks) {
      return res.status(400).json({ error: 'Chunk metadata mismatch.' });
    }

    const numericSize = Number(size);
    if (!Number.isFinite(numericSize) || numericSize !== sessionRecord.size) {
      return res.status(400).json({ error: 'Size mismatch for upload session.' });
    }

    const chunkDir = path.join(CHUNKS_DIR, sessionRecord.id);
    await fsp.mkdir(chunkDir, { recursive: true });

    const chunkPath = path.join(chunkDir, `${String(index).padStart(6, '0')}.part`);
    await fsp.writeFile(chunkPath, req.file.buffer);

    const updated = await prisma.uploadSession.update({
      where: { id: sessionRecord.id },
      data: { uploadedChunks: { increment: 1 } },
    });

    if (index + 1 < sessionRecord.totalChunks) {
      return res.json({
        completed: false,
        received: index,
        uploadedChunks: updated.uploadedChunks,
        totalChunks: sessionRecord.totalChunks,
      });
    }

    // Finalise upload when last chunk arrives.
    const finalPath = path.join(UPLOAD_DIR, sessionRecord.storedName);
    const writeStream = fs.createWriteStream(finalPath);

    for (let i = 0; i < sessionRecord.totalChunks; i += 1) {
      const partPath = path.join(chunkDir, `${String(i).padStart(6, '0')}.part`);
      await fsp.access(partPath);
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(partPath);
        readStream.on('error', reject);
        readStream.on('end', resolve);
        readStream.pipe(writeStream, { end: false });
      });
    }

    writeStream.end();
    await finished(writeStream);

    const tempFiles = await fsp.readdir(chunkDir).catch(() => []);
    await Promise.all(tempFiles.map((file) => fsp.unlink(path.join(chunkDir, file)).catch(() => {})));
    await fsp.rmdir(chunkDir).catch(() => {});

    const createdFile = await prisma.file.create({
      data: {
        storedName: sessionRecord.storedName,
        originalName: sessionRecord.originalName,
        mimeType: sessionRecord.mimeType,
        size: sessionRecord.size,
        uploadedBy: sessionRecord.uploadedBy,
        isPublic: false,
      },
    });

    await prisma.uploadSession.delete({ where: { id: sessionRecord.id } }).catch(() => {});

    res.json({ completed: true, file: presentFile(createdFile) });
  } catch (error) {
    console.error('Chunk upload failed:', error);
    res.status(500).json({ error: 'Failed to process upload chunk.' });
  }
});

app.options('/api/files/:id/preview', fileCors);
app.get('/api/files/:id/preview', fileCors, async (req, res) => {
  const fileId = req.params.id ? String(req.params.id).trim() : '';
  if (!fileId) {
    return res.status(400).json({ error: 'Invalid file id.' });
  }

  try {
    const file = await prisma.file.findUnique({ where: { id: fileId } });
    if (!file) {
      return res.status(404).json({ error: 'File not found.' });
    }

    if (!file.isPublic && (!req.session || !req.session.userId)) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const filePath = path.join(UPLOAD_DIR, file.storedName);
    const mimeType = file.mimeType || mime.lookup(file.storedName) || 'application/octet-stream';
    const previewType = getPreviewType(mimeType);

    if (!previewType) {
      return res.status(415).json({ error: 'Preview not available for this file.' });
    }

    await fsp.access(filePath);

    if (previewType === 'image') {
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'no-store');
      const stream = fs.createReadStream(filePath);
      stream.on('error', (err) => {
        console.error('Failed to stream preview:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream preview.' });
        }
      });
      stream.pipe(res);
      return;
    }

    if (previewType === 'video' || previewType === 'audio') {
      res.setHeader('Cache-Control', 'no-store');
      await streamWithRange(req, res, filePath, mimeType, { inlineName: file.originalName });
      return;
    }

    if (previewType === 'pdf') {
      res.setHeader('Cache-Control', 'no-store');
      await streamWithRange(req, res, filePath, mimeType, { inlineName: file.originalName });
      return;
    }

    if (previewType === 'text') {
      res.setHeader('Content-Type', `${mimeType}; charset=utf-8`);
      res.setHeader('Cache-Control', 'no-store');
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      stream.on('error', (err) => {
        console.error('Failed to stream preview:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream preview.' });
        }
      });
      stream.pipe(res);
      return;
    }

    return res.status(415).json({ error: 'Preview not available for this file.' });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found.' });
    }
    console.error('Preview error:', error);
    res.status(500).json({ error: 'Failed to preview file.' });
  }
});

const setAttachmentHeaders = (res, fileName, mimeType, dataLength, range) => {
  res.setHeader('Accept-Ranges', 'bytes');
  if (range) {
    const { start, end, size } = range;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
  } else if (Number.isFinite(dataLength)) {
    res.setHeader('Content-Length', dataLength);
  }

  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`
  );
};

app.options('/api/files/:id/download', fileCors);
app.get('/api/files/:id/download', fileCors, async (req, res) => {
  const fileId = req.params.id ? String(req.params.id).trim() : '';
  if (!fileId) {
    return res.status(400).json({ error: 'Invalid file id.' });
  }

  try {
    const file = await prisma.file.findUnique({ where: { id: fileId } });
    if (!file) {
      return res.status(404).json({ error: 'File not found.' });
    }

    if (!file.isPublic && (!req.session || !req.session.userId)) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const filePath = path.join(UPLOAD_DIR, file.storedName);
    await fsp.access(filePath);
    const stats = await fsp.stat(filePath);

    const range = parseRange(req.headers.range, stats.size);
    setAttachmentHeaders(res, file.originalName, file.mimeType, stats.size, range);

    if (range) {
      const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
      stream.on('error', (err) => {
        console.error('Download error (range):', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to download file.' });
        }
      });
      stream.pipe(res);
    } else {
      const stream = fs.createReadStream(filePath);
      stream.on('error', (err) => {
        console.error('Download error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to download file.' });
        }
      });
      stream.pipe(res);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found.' });
    }
    console.error('Download error:', error);
    res.status(500).json({ error: 'Failed to download file.' });
  }
});

app.patch('/api/files/:id/visibility', requireAuth, async (req, res) => {
  const fileId = req.params.id ? String(req.params.id).trim() : '';
  if (!fileId) {
    return res.status(400).json({ error: 'Invalid file id.' });
  }

  const rawValue = req.body ? req.body.isPublic : undefined;
  let desiredState;
  if (typeof rawValue === 'boolean') {
    desiredState = rawValue;
  } else if (typeof rawValue === 'string') {
    if (rawValue.toLowerCase() === 'true') desiredState = true;
    else if (rawValue.toLowerCase() === 'false') desiredState = false;
  }
  if (typeof desiredState !== 'boolean') {
    return res.status(400).json({ error: 'isPublic must be a boolean.' });
  }

  try {
    const updated = await prisma.file.update({
      where: { id: fileId },
      data: { isPublic: desiredState },
    });
    res.json({ file: presentFile(updated) });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'File not found.' });
    }
    console.error('Failed to update visibility:', error);
    res.status(500).json({ error: 'Failed to update visibility.' });
  }
});

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  const fileId = req.params.id ? String(req.params.id).trim() : '';
  if (!fileId) {
    return res.status(400).json({ error: 'Invalid file id.' });
  }

  try {
    const file = await prisma.file.findUnique({ where: { id: fileId } });
    if (!file) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const filePath = path.join(UPLOAD_DIR, file.storedName);

    await fsp.unlink(filePath).catch((err) => {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    });

    await prisma.file.delete({ where: { id: fileId } });

    res.status(204).send();
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete file.' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message });
  }
  if (err) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'An unexpected error occurred.' });
  }
  next();
});

const ensureAdminUser = async () => {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    console.warn('ADMIN_USERNAME/ADMIN_PASSWORD not provided. Create users manually or run prisma db seed.');
    return;
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.create({
    data: {
      username,
      passwordHash,
    },
  });
  console.log(`Created default admin user '${username}'.`);
};

const start = async () => {
  try {
    await ensureUploadsDir();
    await prisma.$connect();
    await ensureAdminUser();
    app.listen(PORT, () => {
      console.log(`File service running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Server failed to start:', error);
    process.exit(1);
  }
};

start();

const shutdown = async () => {
  try {
    await prisma.$disconnect();
  } catch (error) {
    console.error('Error during Prisma disconnect:', error);
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
