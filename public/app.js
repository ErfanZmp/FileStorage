const authCard = document.getElementById('auth-card');
const appShell = document.getElementById('app-shell');
const userPanel = document.getElementById('user-panel');
const loginForm = document.getElementById('login-form');
const loginButton = document.getElementById('login-button');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const uploadForm = document.getElementById('upload-form');
const fileInput = document.getElementById('file-input');
const uploadButton = document.getElementById('upload-button');
const refreshButton = document.getElementById('refresh-button');
const logoutButton = document.getElementById('logout-button');
const sessionControls = document.querySelector('.session-controls');
const fileList = document.getElementById('file-list');
const fileCount = document.getElementById('file-count');
const statusEl = document.getElementById('status');
const previewSection = document.getElementById('preview');
const previewImage = document.getElementById('preview-image');
const previewCaption = document.getElementById('preview-caption');
const closePreview = document.getElementById('close-preview');

const state = {
  user: null,
  chunkSize: 8 * 1024 * 1024,
};

const endpoints = {
  me: '/api/auth/me',
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  list: '/api/files',
  uploadInit: '/api/upload/init',
  uploadChunk: '/api/upload/chunk',
  uploadLegacy: '/api/upload',
  download: (id) => `/api/files/${encodeURIComponent(id)}/download`,
  preview: (id) => `/api/files/${encodeURIComponent(id)}/preview`,
  remove: (id) => `/api/files/${encodeURIComponent(id)}`,
  toggleVisibility: (id) => `/api/files/${encodeURIComponent(id)}/visibility`,
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const precision = unit === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unit]}`;
};

const formatDateTime = (value) => {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch (error) {
    return '';
  }
};

const setStatus = (message, variant = 'info', timeout = 3000) => {
  statusEl.textContent = message || '';
  statusEl.dataset.variant = variant;
  if (timeout && message) {
    window.clearTimeout(setStatus._timeoutId);
    setStatus._timeoutId = window.setTimeout(() => {
      statusEl.textContent = '';
      statusEl.dataset.variant = 'info';
    }, timeout);
  }
};

const setAuthStatus = (user) => {
  state.user = user;
  if (user) {
    userPanel.textContent = `Signed in as ${user.username}`;
    userPanel.classList.remove('hidden');
    logoutButton.classList.remove('hidden');
    authCard.classList.add('hidden');
    appShell.classList.remove('hidden');
    uploadForm.reset();
    fileInput.disabled = false;
    uploadButton.disabled = false;
    fetchFiles();
  } else {
    userPanel.classList.add('hidden');
    logoutButton.classList.add('hidden');
    appShell.classList.add('hidden');
    authCard.classList.remove('hidden');
    renderEmptyState('Sign in to load files.');
    clearPreview();
  }
};

const clearPreview = () => {
  previewImage.removeAttribute('src');
  previewCaption.textContent = '';
  previewSection.classList.remove('active');
};

const renderEmptyState = (message) => {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 3;
  cell.className = 'file-meta';
  cell.textContent = message;
  row.appendChild(cell);
  fileList.replaceChildren(row);
  fileCount.textContent = '';
};

const apiFetch = async (input, options = {}) => {
  const config = {
    credentials: 'include',
    ...options,
  };

  if (
    config.body &&
    !(config.body instanceof FormData) &&
    typeof config.body === 'object' &&
    !(config.body instanceof Blob)
  ) {
    config.headers = {
      'Content-Type': 'application/json',
      ...(config.headers || {}),
    };
    config.body = JSON.stringify(config.body);
  }

  const response = await fetch(input, config);
  if (response.status === 401) {
    setStatus('Session expired. Sign in again.', 'error', 5000);
    setAuthStatus(null);
    throw new Error('Authentication required.');
  }
  return response;
};

const toggleVisibility = async (id, nextState) => {
  try {
    const response = await apiFetch(endpoints.toggleVisibility(id), {
      method: 'PATCH',
      body: { isPublic: nextState },
    });
    if (!response.ok) {
      await handleFetchError(response);
    }
    const payload = await response.json();
    const visibilityLabel = payload.file.isPublic ? 'public' : 'private';
    setStatus(`File marked ${visibilityLabel}.`, 'success');
    fetchFiles();
  } catch (error) {
    if (error.message !== 'Authentication required.') {
      setStatus(error.message, 'error', 5000);
    }
  }
};

const handleFetchError = async (response) => {
  let errorMessage = response.statusText || 'Request failed.';
  try {
    const payload = await response.json();
    if (payload && payload.error) {
      errorMessage = payload.error;
    }
  } catch (error) {
    /* ignore */
  }
  const error = new Error(errorMessage);
  error.status = response.status;
  throw error;
};

const renderFiles = (files) => {
  if (!files.length) {
    fileCount.textContent = 'No files uploaded yet.';
    renderEmptyState('No files uploaded yet.');
    return;
  }

  fileList.replaceChildren();
  fileCount.textContent = `${files.length} file${files.length > 1 ? 's' : ''}`;

  files.forEach((file) => {
    const row = document.createElement('tr');
    row.dataset.fileId = file.id;

    const nameCell = document.createElement('td');
    const nameEl = document.createElement('div');
    nameEl.className = 'file-name';
    nameEl.textContent = file.name;
    const metaEl = document.createElement('div');
    metaEl.className = 'file-meta';
    const visibilityLabel = file.isPublic ? 'Public' : 'Private';
    metaEl.textContent = `${file.mimeType} • ${formatBytes(file.size)} • ${formatDateTime(
      file.uploadedAt
    )} • ${visibilityLabel}`;
    nameCell.append(nameEl, metaEl);

    const sizeCell = document.createElement('td');
    sizeCell.textContent = formatBytes(file.size);

    const actionsCell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'actions';

    if (file.isImage && file.previewUrl) {
      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'ghost';
      previewBtn.dataset.action = 'preview';
      previewBtn.dataset.id = file.id;
      previewBtn.dataset.name = file.name;
      previewBtn.textContent = 'Preview';
      actions.appendChild(previewBtn);
    }

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'ghost';
    downloadBtn.dataset.action = 'download';
    downloadBtn.dataset.id = file.id;
    downloadBtn.textContent = 'Download';
    actions.appendChild(downloadBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ghost';
    copyBtn.dataset.action = 'copy-link';
    copyBtn.dataset.id = file.id;
    copyBtn.dataset.url = `${window.location.origin}${file.downloadUrl}`;
    copyBtn.textContent = 'Copy Link';
    actions.appendChild(copyBtn);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'ghost';
    toggleBtn.dataset.action = 'toggle-visibility';
    toggleBtn.dataset.id = file.id;
    toggleBtn.dataset.state = file.isPublic ? 'public' : 'private';
    toggleBtn.textContent = file.isPublic ? 'Make Private' : 'Make Public';
    actions.appendChild(toggleBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger';
    deleteBtn.dataset.action = 'delete';
    deleteBtn.dataset.id = file.id;
    deleteBtn.textContent = 'Delete';
    actions.appendChild(deleteBtn);

    actionsCell.appendChild(actions);

    row.append(nameCell, sizeCell, actionsCell);
    fileList.appendChild(row);
  });
};

const fetchFiles = async () => {
  if (!state.user) {
    renderEmptyState('Sign in to load files.');
    return;
  }

  renderEmptyState('Loading files…');
  try {
    const response = await apiFetch(endpoints.list, { cache: 'no-store' });
    if (!response.ok) {
      await handleFetchError(response);
    }
    const payload = await response.json();
    renderFiles(payload.files || []);
  } catch (error) {
    if (error.message === 'Authentication required.') {
      return;
    }
    setStatus(error.message, 'error', 5000);
    renderEmptyState(error.message || 'Unable to load files.');
  }
};

fileList.addEventListener('click', async (event) => {
  const target = event.target.closest('button[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const fileId = target.dataset.id;
  if (!fileId) return;

  if (action === 'download') {
    window.open(endpoints.download(fileId), '_blank', 'noopener');
    return;
  }

  if (action === 'copy-link') {
    const url = target.dataset.url || `${window.location.origin}${endpoints.download(fileId)}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        setStatus('Download link copied to clipboard.', 'success');
      }).catch(() => {
        window.prompt('Copy this download link', url);
      });
    } else {
      window.prompt('Copy this download link', url);
    }
    return;
  }

  if (action === 'toggle-visibility') {
    const currentState = target.dataset.state === 'public';
    toggleVisibility(fileId, !currentState);
    return;
  }

  if (action === 'preview') {
    previewImage.src = `${endpoints.preview(fileId)}?t=${Date.now()}`;
    previewCaption.textContent = target.dataset.name || '';
    previewSection.classList.add('active');
    return;
  }

  if (action === 'delete') {
    const confirmed = window.confirm('Delete this file?');
    if (!confirmed) return;
    try {
      const response = await apiFetch(endpoints.remove(fileId), { method: 'DELETE' });
      if (!response.ok && response.status !== 204) {
        await handleFetchError(response);
      }
      setStatus('File deleted.', 'success');
      clearPreview();
      fetchFiles();
    } catch (error) {
      if (error.message === 'Authentication required.') {
        return;
      }
      setStatus(error.message, 'error', 5000);
    }
  }
});

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
});

loginButton.addEventListener('click', async () => {
  const username = loginUsername.value.trim();
  const password = loginPassword.value;
  if (!username || !password) {
    setStatus('Enter username and password.', 'error', 4000);
    return;
  }

  loginButton.disabled = true;
  setStatus('Signing in…', 'info', 0);

  try {
    const response = await fetch(endpoints.login, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!response.ok) {
      await handleFetchError(response);
    }

    const payload = await response.json();
    setStatus('Signed in.', 'success');
    setAuthStatus(payload.user);
    loginForm.reset();
  } catch (error) {
    setStatus(error.message, 'error', 5000);
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    const response = await apiFetch(endpoints.logout, { method: 'POST' });
    if (!response.ok && response.status !== 204) {
      await handleFetchError(response);
    }
    setStatus('Signed out.', 'info');
    setAuthStatus(null);
  } catch (error) {
    if (error.message !== 'Authentication required.') {
      setStatus(error.message, 'error', 5000);
    }
  } finally {
    logoutButton.disabled = false;
  }
});

const startChunkedUpload = async (file) => {
  const initResponse = await apiFetch(endpoints.uploadInit, {
    method: 'POST',
    body: {
      name: file.name,
      size: file.size,
      mimeType: file.type || undefined,
    },
  });

  if (!initResponse.ok) {
    await handleFetchError(initResponse);
  }

  const initPayload = await initResponse.json();
  const uploadId = initPayload.uploadId;
  const chunkSize = initPayload.chunkSize || state.chunkSize;
  const totalChunks = initPayload.totalChunks || Math.ceil(file.size / chunkSize);
  state.chunkSize = chunkSize;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunk = file.slice(start, end);

    const formData = new FormData();
    formData.append('uploadId', uploadId);
    formData.append('chunkIndex', String(chunkIndex));
    formData.append('totalChunks', String(totalChunks));
    formData.append('originalName', file.name);
    formData.append('mimeType', file.type || 'application/octet-stream');
    formData.append('size', String(file.size));
    formData.append('chunk', chunk, `${file.name}.part`);

    const response = await apiFetch(endpoints.uploadChunk, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      await handleFetchError(response);
    }

    const payload = await response.json();
    const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);
    setStatus(`Uploading… ${progress}%`, 'info', 0);

    if (payload.completed) {
      setStatus('Upload complete!', 'success');
      return payload.file;
    }
  }

  throw new Error('Upload did not complete.');
};

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!fileInput.files.length) {
    setStatus('Choose a file to upload.', 'error');
    return;
  }

  const file = fileInput.files[0];
  if (file.size === 0) {
    setStatus('File is empty.', 'error');
    return;
  }

  uploadButton.disabled = true;
  fileInput.disabled = true;
  setStatus('Preparing upload…', 'info', 0);

  try {
    await startChunkedUpload(file);
    uploadForm.reset();
    fileInput.disabled = false;
    fetchFiles();
  } catch (error) {
    if (error.message !== 'Authentication required.') {
      setStatus(error.message, 'error', 5000);
    }
  } finally {
    uploadButton.disabled = false;
    fileInput.disabled = false;
  }
});

refreshButton.addEventListener('click', () => {
  setStatus('Refreshing…', 'info', 1000);
  fetchFiles();
});

closePreview.addEventListener('click', clearPreview);

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    clearPreview();
  }
});

const bootstrap = async () => {
  try {
    const response = await fetch(endpoints.me, { credentials: 'include' });
    if (!response.ok) {
      setAuthStatus(null);
      if (response.status !== 401) {
        await handleFetchError(response);
      }
      return;
    }
    const payload = await response.json();
    setAuthStatus(payload.user);
  } catch (error) {
    setStatus(error.message, 'error', 5000);
    setAuthStatus(null);
  }
};

bootstrap();
