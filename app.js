/* =============================================================
   Spanish Vocabulary Trainer
   Stack: Vanilla JS  |  Algorithm: SM-2 Spaced Repetition
   ============================================================= */

'use strict';

// ----------------------------------------------------------------
// DEBUG LOG  — visible in-app panel + browser console
// ----------------------------------------------------------------
const debugPanel = document.getElementById('debug-panel');
const debugLog   = document.getElementById('debug-log');
const btnClearLog= document.getElementById('btn-clear-log');

function log(msg, level = 'info') {
  // Console
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[SpanishApp] ${msg}`);

  // In-app panel
  debugPanel.classList.remove('hidden');
  const li = document.createElement('li');
  li.className = `log-${level}`;
  const ts = new Date().toLocaleTimeString();
  li.textContent = `[${ts}] ${msg}`;
  debugLog.appendChild(li);
  debugLog.scrollTop = debugLog.scrollHeight;
}

btnClearLog.addEventListener('click', () => {
  debugLog.innerHTML = '';
  debugPanel.classList.add('hidden');
});

// ----------------------------------------------------------------
// STATE
// ----------------------------------------------------------------
const State = {
  apiKey:       '',
  imageDataURL: '',   // resized base64 data URL
  vocab:        [],   // [{ french, spanish }]
  cards:        [],   // SM-2 card objects
  queue:        [],
  queuePos:     0,
  sessionStats: { correct: 0, partial: 0, wrong: 0 },
};

// ----------------------------------------------------------------
// IMAGE RESIZE  (max 1024px, JPEG quality 0.85)
// ----------------------------------------------------------------
function resizeImage(dataURL, maxPx = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { width: w, height: h } = img;
      const scale = Math.min(1, maxPx / Math.max(w, h));
      const nw = Math.round(w * scale);
      const nh = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width  = nw;
      canvas.height = nh;
      canvas.getContext('2d').drawImage(img, 0, 0, nw, nh);
      const resized = canvas.toDataURL('image/jpeg', 0.85);
      const origKB   = Math.round(dataURL.length * 0.75 / 1024);
      const resizedKB= Math.round(resized.length * 0.75 / 1024);
      log(`Image resized: ${w}×${h} → ${nw}×${nh} | ${origKB} KB → ${resizedKB} KB`);
      resolve(resized);
    };
    img.onerror = () => reject(new Error('Could not load image for resizing'));
    img.src = dataURL;
  });
}

// ----------------------------------------------------------------
// SM-2 CARD FACTORY
// ----------------------------------------------------------------
function makeCard(french, spanish) {
  const key   = `sm2_${french.trim().toLowerCase()}`;
  const saved = JSON.parse(localStorage.getItem(key) || 'null');
  return {
    french, spanish,
    easeFactor:  saved?.easeFactor  ?? 2.5,
    interval:    saved?.interval    ?? 0,
    repetitions: saved?.repetitions ?? 0,
    dueDate:     saved?.dueDate     ?? 0,
    lastQuality:  null,
    sessionResult: null,
    _key: key,
  };
}

function saveCard(card) {
  localStorage.setItem(card._key, JSON.stringify({
    easeFactor:  card.easeFactor,
    interval:    card.interval,
    repetitions: card.repetitions,
    dueDate:     card.dueDate,
  }));
}

function sm2Update(card, q) {
  if (q >= 3) {
    if (card.repetitions === 0)      card.interval = 1;
    else if (card.repetitions === 1) card.interval = 6;
    else card.interval = Math.round(card.interval * card.easeFactor);
    card.repetitions++;
  } else {
    card.repetitions = 0;
    card.interval    = 1;
  }
  card.easeFactor = Math.max(1.3, card.easeFactor + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  card.dueDate    = Date.now() + card.interval * 86400000;
  saveCard(card);
}

// ----------------------------------------------------------------
// FUZZY MATCH
// ----------------------------------------------------------------
function normalize(s) {
  return s.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, '');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function evaluate(input, expected) {
  const a = normalize(input);
  const b = normalize(expected);
  if (a === b) return { quality: 5, verdict: 'correct' };
  const maxDist = b.length <= 4 ? 1 : 2;
  if (levenshtein(a, b) <= maxDist) return { quality: 4, verdict: 'correct' };
  const rawA = input.trim().toLowerCase().replace(/[^a-z\s\u00C0-\u024F]/gi,'');
  const rawB = expected.trim().toLowerCase().replace(/[^a-z\s\u00C0-\u024F]/gi,'');
  if (levenshtein(normalize(rawA), normalize(rawB)) === 0 && rawA !== rawB)
    return { quality: 3, verdict: 'partial' };
  const dist = levenshtein(a, b);
  const threshold = Math.ceil(b.length * 0.4);
  if (dist <= threshold && threshold >= 2) return { quality: 2, verdict: 'partial' };
  return { quality: 0, verdict: 'wrong' };
}

// ----------------------------------------------------------------
// OPENAI HELPERS
// ----------------------------------------------------------------
const OPENAI_TIMEOUT_MS = 30000;  // 30 s

async function checkConnectivity() {
  log('Testing connectivity to api.openai.com…');

  // Step 1: GET without auth (no preflight)
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    log(`GET (no auth) check: HTTP ${res.status} ✓`, 'success');
  } catch (err) {
    log(`GET check FAILED: ${err.name} — ${err.message}`, 'error');
    return false;
  }

  // Step 2: OPTIONS preflight simulation — does the network block preflights?
  log('Testing OPTIONS preflight to api.openai.com…');
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'OPTIONS',
      signal: AbortSignal.timeout(8000),
    });
    log(`OPTIONS check: HTTP ${res.status} ✓`, 'success');
  } catch (err) {
    log(`OPTIONS/preflight FAILED: ${err.name} — ${err.message}`, 'error');
    log('Your network (router/ISP/firewall) is blocking CORS preflight requests to api.openai.com', 'warn');
    return false;
  }

  // Step 3: POST with Authorization header (triggers preflight)
  log('Testing POST with Authorization header…');
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.openai.com/v1/chat/completions', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer INVALID_KEY_TEST`);
    xhr.timeout = 10000;
    xhr.onload = () => {
      log(`POST+Auth check: HTTP ${xhr.status} ✓ (network allows authorized POST)`, 'success');
      resolve(true);
    };
    xhr.onerror = () => {
      log(`POST+Auth check FAILED — network blocks authenticated POST to api.openai.com`, 'error');
      log('Check: 1) Chrome extensions (uBlock, AdGuard, etc) 2) Corporate/school network firewall 3) DNS filtering (NextDNS, Pi-hole)', 'warn');
      resolve(false);
    };
    xhr.ontimeout = () => {
      log('POST+Auth check timed out', 'warn');
      resolve(false);
    };
    xhr.send(JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }));
  });
}

// XHR-based fetch — works in Safari where fetch() blocks large cross-origin POSTs
function openAIFetch(endpoint, body, apiKey) {
  const bodyStr    = JSON.stringify(body);
  const bodySizeKB = Math.round(bodyStr.length / 1024);
  log(`POST ${endpoint} (payload: ${bodySizeKB} KB) via XHR…`);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.openai.com/v1${endpoint}`, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${apiKey}`);
    xhr.timeout = OPENAI_TIMEOUT_MS;

    xhr.onload = () => {
      log(`Response: HTTP ${xhr.status}`);
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        const msg = data?.error?.message ?? `HTTP ${xhr.status}`;
        reject(new Error(msg));
      }
    };

    xhr.onerror = () => {
      log(`XHR network error (readyState=${xhr.readyState}, status=${xhr.status})`, 'error');
      reject(new Error('Network error: could not reach api.openai.com. Check your internet connection or browser extensions.'));
    };

    xhr.ontimeout = () => {
      log(`XHR timed out after ${OPENAI_TIMEOUT_MS / 1000}s`, 'error');
      reject(new Error(`Request timed out after ${OPENAI_TIMEOUT_MS / 1000} seconds.`));
    };

    xhr.onprogress = (e) => {
      if (e.lengthComputable) {
        log(`Receiving response… ${Math.round(e.loaded / 1024)} KB`);
      }
    };

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 100);
        if (pct % 25 === 0) log(`Uploading payload… ${pct}%`);
      }
    };

    xhr.send(bodyStr);
  });
}

// Validate API key with a tiny cheap call
async function validateApiKey(apiKey) {
  log('Validating API key…');
  const data = await openAIFetch('/chat/completions', {
    model: 'gpt-4o-mini',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'Hi' }],
  }, apiKey);
  log('API key is valid ✓', 'success');
  return true;
}

// Extract vocab from image
async function extractVocabFromImage(imageDataURL, apiKey) {
  const base64   = imageDataURL.split(',')[1];
  const mimeType = imageDataURL.match(/data:(image\/\w+);/)?.[1] ?? 'image/jpeg';
  const sizeKB   = Math.round(base64.length * 0.75 / 1024);
  log(`Sending image to OpenAI Vision (${sizeKB} KB, detail: low)…`);

  const data = await openAIFetch('/chat/completions', {
    model: 'gpt-4o',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `This image is a French–Spanish vocabulary lesson.
Extract every French–Spanish word pair you can see.
Return ONLY a valid JSON array, no markdown, no explanation.
Format: [{"french": "...", "spanish": "..."}, ...]
If the same French word has multiple Spanish translations, create one entry per translation.
If you cannot find any pairs, return an empty array [].`,
        },
        {
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'low' },
        },
      ],
    }],
  }, apiKey);

  const text    = data.choices?.[0]?.message?.content ?? '';
  log(`Raw response: ${text.substring(0, 120)}…`);
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const pairs   = JSON.parse(cleaned);
  if (!Array.isArray(pairs)) throw new Error('Unexpected response format from OpenAI.');
  const filtered = pairs.filter(p => p.french && p.spanish);
  log(`Extracted ${filtered.length} word pairs ✓`, 'success');
  return filtered;
}

// ----------------------------------------------------------------
// VIEW ROUTER
// ----------------------------------------------------------------
const views = {
  settings: document.getElementById('view-settings'),
  upload:   document.getElementById('view-upload'),
  review:   document.getElementById('view-review'),
  quiz:     document.getElementById('view-quiz'),
  results:  document.getElementById('view-results'),
};

function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
}

// ----------------------------------------------------------------
// SETTINGS
// ----------------------------------------------------------------
const apiKeyInput      = document.getElementById('api-key-input');
const btnSaveSettings  = document.getElementById('btn-save-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const btnSettings      = document.getElementById('btn-settings');
const btnValidateKey   = document.getElementById('btn-validate-key');
const keyStatus        = document.getElementById('key-status');

function setKeyStatus(msg, type) {
  keyStatus.textContent = msg;
  keyStatus.className   = `status-msg ${type}`;
  keyStatus.classList.remove('hidden');
}

function loadSettings() {
  State.apiKey = localStorage.getItem('openai_api_key') ?? '';
  apiKeyInput.value = State.apiKey;
}

btnSettings.addEventListener('click', () => {
  apiKeyInput.value = State.apiKey;
  keyStatus.classList.add('hidden');
  showView('settings');
});

btnValidateKey.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { setKeyStatus('Enter a key first.', 'error'); return; }
  btnValidateKey.disabled = true;
  setKeyStatus('Checking connectivity…', 'loading');
  try {
    const reachable = await checkConnectivity();
    if (!reachable) {
      setKeyStatus('Cannot reach api.openai.com — check your network or browser extensions.', 'error');
      return;
    }
    setKeyStatus('Validating key…', 'loading');
    await validateApiKey(key);
    setKeyStatus('Key is valid ✓', 'success');
  } catch (err) {
    setKeyStatus(`Error: ${err.message}`, 'error');
    log(`Key validation failed: ${err.message}`, 'error');
  } finally {
    btnValidateKey.disabled = false;
  }
});

btnSaveSettings.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) { setKeyStatus('Please enter a valid API key.', 'error'); return; }
  State.apiKey = key;
  localStorage.setItem('openai_api_key', key);
  log('API key saved to localStorage');
  showView('upload');
});

btnCloseSettings.addEventListener('click', () => showView('upload'));

// ----------------------------------------------------------------
// UPLOAD VIEW
// ----------------------------------------------------------------
const fileInput     = document.getElementById('file-input');
const dropZone      = document.getElementById('drop-zone');
const dropLabel     = document.getElementById('drop-label');
const imagePreview  = document.getElementById('image-preview');
const extractStatus = document.getElementById('extract-status');
const btnExtract    = document.getElementById('btn-extract');

function setStatus(msg, type) {
  extractStatus.textContent = msg;
  extractStatus.className   = `status-msg ${type}`;
  extractStatus.classList.remove('hidden');
}

function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('Please select a valid image file.', 'error');
    log('Invalid file type selected', 'warn');
    return;
  }
  log(`File selected: ${file.name} (${Math.round(file.size / 1024)} KB, ${file.type})`);
  const reader = new FileReader();
  reader.onload = e => {
    State.imageDataURL = e.target.result;
    imagePreview.src   = State.imageDataURL;
    imagePreview.classList.remove('hidden');
    dropLabel.classList.add('hidden');
    extractStatus.classList.add('hidden');
    btnExtract.classList.remove('hidden');
    log('Image loaded into memory, ready to extract');
  };
  reader.onerror = () => {
    log('FileReader error', 'error');
    setStatus('Failed to read the image file.', 'error');
  };
  reader.readAsDataURL(file);
}

fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});

btnExtract.addEventListener('click', async () => {
  if (!State.apiKey) {
    setStatus('No API key set. Click the gear icon ⚙ to enter your OpenAI key.', 'error');
    log('Extraction attempted without API key', 'warn');
    return;
  }
  if (!State.imageDataURL) {
    setStatus('Please select an image first.', 'error');
    return;
  }

  btnExtract.disabled = true;
  log('Starting extraction pipeline…');

  try {
    // Step 1 — resize
    setStatus('Step 1/2 — Resizing image…', 'loading');
    log('Resizing image…');
    const resized = await resizeImage(State.imageDataURL, 1024);
    State.imageDataURL = resized;
    imagePreview.src   = resized;  // show resized version

    // Step 2 — connectivity check
    setStatus('Step 2/3 — Checking connectivity to OpenAI…', 'loading');
    const reachable = await checkConnectivity();
    if (!reachable) {
      throw new Error('Cannot reach api.openai.com. Check your network, VPN, or browser extensions (e.g. ad blockers, privacy shields).');
    }

    // Step 3 — call OpenAI Vision
    setStatus('Step 3/3 — Sending to OpenAI Vision (up to 30s)…', 'loading');
    const pairs = await extractVocabFromImage(State.imageDataURL, State.apiKey);

    if (pairs.length === 0) {
      setStatus('No word pairs found. Try a clearer image or add them manually.', 'error');
      log('OpenAI returned 0 pairs', 'warn');
      btnExtract.disabled = false;
      return;
    }

    State.vocab = pairs;
    setStatus(`Found ${pairs.length} word pair${pairs.length > 1 ? 's' : ''}!`, 'success');
    log(`Done — building review view with ${pairs.length} pairs`);
    setTimeout(() => buildReviewView(), 800);

  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    log(`Extraction failed: ${err.message}`, 'error');
    btnExtract.disabled = false;
  }
});

// ----------------------------------------------------------------
// REVIEW VIEW
// ----------------------------------------------------------------
const vocabTbody   = document.getElementById('vocab-tbody');
const btnAddRow    = document.getElementById('btn-add-row');
const btnStartQuiz = document.getElementById('btn-start-quiz');
const reviewImage  = document.getElementById('review-image');

function buildReviewView() {
  reviewImage.src = State.imageDataURL;
  renderVocabTable();
  showView('review');
}

function renderVocabTable() {
  vocabTbody.innerHTML = '';
  State.vocab.forEach((pair, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td contenteditable="true" data-i="${i}" data-field="french">${escHtml(pair.french)}</td>
      <td contenteditable="true" data-i="${i}" data-field="spanish">${escHtml(pair.spanish)}</td>
      <td><button class="btn-delete-row" data-i="${i}" title="Remove">&#10005;</button></td>`;
    vocabTbody.appendChild(tr);
  });
  vocabTbody.querySelectorAll('[contenteditable]').forEach(cell => {
    cell.addEventListener('input', () => {
      State.vocab[+cell.dataset.i][cell.dataset.field] = cell.textContent.trim();
    });
  });
  vocabTbody.querySelectorAll('.btn-delete-row').forEach(btn => {
    btn.addEventListener('click', () => {
      State.vocab.splice(+btn.dataset.i, 1);
      renderVocabTable();
    });
  });
}

btnAddRow.addEventListener('click', () => {
  State.vocab.push({ french: '', spanish: '' });
  renderVocabTable();
  vocabTbody.querySelectorAll('[data-field="french"]').forEach((c, i, a) => {
    if (i === a.length - 1) c.focus();
  });
});

btnStartQuiz.addEventListener('click', () => {
  const clean = State.vocab.filter(p => p.french.trim() && p.spanish.trim());
  if (clean.length === 0) { alert('Add at least one word pair first.'); return; }
  State.vocab = clean;
  log(`Starting quiz with ${clean.length} cards`);
  startQuiz();
});

// ----------------------------------------------------------------
// QUIZ ENGINE
// ----------------------------------------------------------------
const quizImage     = document.getElementById('quiz-image');
const quizWordEl    = document.getElementById('quiz-word');
const quizForm      = document.getElementById('quiz-form');
const quizInput     = document.getElementById('quiz-input');
const quizFeedback  = document.getElementById('quiz-feedback');
const btnNext       = document.getElementById('btn-next');
const progressBar   = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const statCorrect   = document.getElementById('stat-correct');
const statPartial   = document.getElementById('stat-partial');
const statWrong     = document.getElementById('stat-wrong');

function startQuiz() {
  quizImage.src = State.imageDataURL;
  State.cards   = State.vocab.map(p => makeCard(p.french, p.spanish));
  State.queue   = shuffle(State.cards.map((_, i) => i));
  State.queuePos = 0;
  State.sessionStats = { correct: 0, partial: 0, wrong: 0 };
  updateStatsBar();
  showView('quiz');
  showNextCard();
}

function showNextCard() {
  while (State.queuePos < State.queue.length) {
    if (State.cards[State.queue[State.queuePos]].sessionResult === 'correct') {
      State.queuePos++;
    } else break;
  }

  if (State.queuePos >= State.queue.length) {
    const pending = State.cards.filter(c => c.sessionResult !== 'correct');
    if (pending.length === 0) { endSession(); return; }
    const pendingIdx = State.cards.map((c,i) => c.sessionResult !== 'correct' ? i : -1).filter(i => i >= 0);
    State.queue.push(...shuffle(pendingIdx));
  }

  const ci   = State.queue[State.queuePos];
  const card = State.cards[ci];
  quizWordEl.textContent = card.french;
  quizInput.value = '';
  quizFeedback.classList.add('hidden');
  btnNext.classList.add('hidden');
  quizInput.disabled = false;
  quizForm.querySelector('button[type="submit"]').disabled = false;
  quizInput.focus();

  const done  = State.cards.filter(c => c.sessionResult === 'correct').length;
  const total = State.cards.length;
  progressBar.style.width  = `${total ? Math.round(done / total * 100) : 0}%`;
  progressLabel.textContent = `${done} / ${total} mastered this session`;
}

quizForm.addEventListener('submit', e => {
  e.preventDefault();
  const ci   = State.queue[State.queuePos];
  const card = State.cards[ci];
  const { quality, verdict } = evaluate(quizInput.value, card.spanish);

  quizInput.disabled = true;
  quizForm.querySelector('button[type="submit"]').disabled = true;

  quizFeedback.className = `quiz-feedback ${verdict}`;
  if (verdict === 'correct')
    quizFeedback.innerHTML = `Correct! <strong>${escHtml(card.spanish)}</strong>`;
  else if (verdict === 'partial')
    quizFeedback.innerHTML = `Close — the answer is <strong>${escHtml(card.spanish)}</strong>`;
  else
    quizFeedback.innerHTML = `Incorrect — the answer is <strong>${escHtml(card.spanish)}</strong>`;

  quizFeedback.classList.remove('hidden');
  btnNext.classList.remove('hidden');

  sm2Update(card, quality);

  if (verdict === 'correct') {
    if (card.sessionResult !== 'correct') { State.sessionStats.correct++; card.sessionResult = 'correct'; }
  } else if (verdict === 'partial') {
    if (card.sessionResult === null) { State.sessionStats.partial++; card.sessionResult = 'partial'; }
    State.queue.splice(Math.min(State.queuePos + 3, State.queue.length), 0, ci);
  } else {
    if (card.sessionResult === null) { State.sessionStats.wrong++; card.sessionResult = 'wrong'; }
    State.queue.splice(Math.min(State.queuePos + 2, State.queue.length), 0, ci);
  }

  updateStatsBar();
});

btnNext.addEventListener('click', () => { State.queuePos++; showNextCard(); });

function updateStatsBar() {
  statCorrect.textContent = `Correct: ${State.sessionStats.correct}`;
  statPartial.textContent = `Close: ${State.sessionStats.partial}`;
  statWrong.textContent   = `Wrong: ${State.sessionStats.wrong}`;
}

// ----------------------------------------------------------------
// RESULTS VIEW
// ----------------------------------------------------------------
const resultsTbody   = document.getElementById('results-tbody');
const resultsSummary = document.getElementById('results-summary');
const btnNewSession  = document.getElementById('btn-new-session');
const btnReviewAgain = document.getElementById('btn-review-again');

function endSession() {
  log('Session complete — showing results');
  resultsTbody.innerHTML = '';
  State.cards.forEach(card => {
    const result  = card.sessionResult ?? 'wrong';
    const nextStr = card.interval <= 1 ? 'Tomorrow' : `In ${card.interval} days`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escHtml(card.french)}</td>
      <td>${escHtml(card.spanish)}</td>
      <td><span class="badge ${result}">${capitalize(result)}</span></td>
      <td>${nextStr}</td>`;
    resultsTbody.appendChild(tr);
  });
  const { correct, partial, wrong } = State.sessionStats;
  resultsSummary.innerHTML = `
    <div class="result-stat green"><div class="number">${correct}</div><div class="label">Correct</div></div>
    <div class="result-stat amber"><div class="number">${partial}</div><div class="label">Close</div></div>
    <div class="result-stat red"><div class="number">${wrong}</div><div class="label">Wrong</div></div>`;
  showView('results');
}

btnNewSession.addEventListener('click', () => {
  imagePreview.classList.add('hidden');
  dropLabel.classList.remove('hidden');
  btnExtract.classList.add('hidden');
  btnExtract.disabled = false;
  extractStatus.classList.add('hidden');
  fileInput.value = '';
  State.imageDataURL = '';
  State.vocab = [];
  debugLog.innerHTML = '';
  debugPanel.classList.add('hidden');
  showView('upload');
});

btnReviewAgain.addEventListener('click', () => {
  State.cards.forEach(c => { c.sessionResult = null; c.lastQuality = null; });
  State.queue    = shuffle(State.cards.map((_, i) => i));
  State.queuePos = 0;
  State.sessionStats = { correct: 0, partial: 0, wrong: 0 };
  updateStatsBar();
  showView('quiz');
  showNextCard();
});

// ----------------------------------------------------------------
// UTILITIES
// ----------------------------------------------------------------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ----------------------------------------------------------------
// INIT
// ----------------------------------------------------------------
function init() {
  loadSettings();
  log(`App initialized. API key in storage: ${State.apiKey ? 'yes' : 'no'}`);
  showView(State.apiKey ? 'upload' : 'settings');
}

init();
