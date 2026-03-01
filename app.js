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
// ANTHROPIC (CLAUDE) API HELPERS
// ----------------------------------------------------------------
const API_TIMEOUT_MS = 30000;  // 30 s
const ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

function anthropicFetch(endpoint, body, apiKey) {
  const bodyStr    = JSON.stringify(body);
  const bodySizeKB = Math.round(bodyStr.length / 1024);
  log(`POST ${endpoint} (payload: ${bodySizeKB} KB)…`);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${ANTHROPIC_BASE}${endpoint}`, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('x-api-key', apiKey);
    xhr.setRequestHeader('anthropic-version', ANTHROPIC_VERSION);
    xhr.setRequestHeader('anthropic-dangerous-direct-browser-access', 'true');
    xhr.timeout = API_TIMEOUT_MS;

    xhr.onload = () => {
      log(`Response: HTTP ${xhr.status} — raw: ${xhr.responseText.substring(0, 300)}`);
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) {
        log(`JSON parse error: ${e.message}`, 'error');
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        const msg = data?.error?.message ?? `HTTP ${xhr.status}`;
        reject(new Error(msg));
      }
    };

    xhr.onerror = () => {
      log(`XHR error: readyState=${xhr.readyState}, status=${xhr.status}`, 'error');
      reject(new Error('Network error reaching api.anthropic.com. Check your connection.'));
    };

    xhr.ontimeout = () => {
      log(`Request timed out after ${API_TIMEOUT_MS / 1000}s`, 'error');
      reject(new Error(`Request timed out after ${API_TIMEOUT_MS / 1000} seconds.`));
    };

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.loaded === e.total) {
        log(`Upload complete (${Math.round(e.total / 1024)} KB) — waiting for Claude…`);
      }
    };

    log(`Sending body: ${bodyStr.substring(0, 200)}`);
    xhr.send(bodyStr);
  });
}

// Validate API key with a tiny cheap call
async function validateApiKey(apiKey) {
  log('Validating Anthropic API key…');
  const data = await anthropicFetch('/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'Hi' }],
  }, apiKey);
  log('API key is valid ✓', 'success');
  return true;
}

// Extract vocab from image using Claude Vision
async function extractVocabFromImage(imageDataURL, apiKey) {
  const base64   = imageDataURL.split(',')[1];
  const mimeType = imageDataURL.match(/data:(image\/[\w+]+);/)?.[1] ?? 'image/jpeg';
  const sizeKB   = Math.round(base64.length * 0.75 / 1024);
  log(`Sending image to Claude Vision (${sizeKB} KB)…`);

  const data = await anthropicFetch('/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType,
            data: base64,
          },
        },
        {
          type: 'text',
          text: `This image is a vocabulary lesson. Each line contains a Spanish word or phrase and its French translation (or vice versa).
Your job: identify every pair and return them so that "french" contains the French word/phrase and "spanish" contains the Spanish word/phrase.
Spanish words often contain accents like á, é, í, ó, ú, ñ. French words often contain accents like à, è, ê, ç, œ.
Return ONLY a valid JSON array, no markdown, no explanation.
Format: [{"french": "...", "spanish": "..."}, ...]
If the same word has multiple translations, create one entry per translation.
If you cannot find any pairs, return an empty array [].`,
        },
      ],
    }],
  }, apiKey);

  const text    = data.content?.[0]?.text ?? '';
  log(`Raw response: ${text.substring(0, 120)}…`);
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const pairs   = JSON.parse(cleaned);
  if (!Array.isArray(pairs)) throw new Error('Unexpected response format from Claude.');
  const filtered = pairs.filter(p => p.french && p.spanish);

  // Sanity check: detect if Claude swapped the languages.
  // Spanish words are more likely to contain ñ, ll, rr, or end in typical Spanish patterns.
  // French words are more likely to contain eau, ou, oi, or end in -tion, -eur, -ais.
  // Simple heuristic: if >50% of "french" values contain ñ or Spanish markers,
  // and >50% of "spanish" values contain French markers → swap all pairs.
  const spanishMarkers = /[ñ]|ción|ción|llo|rro/i;
  const frenchMarkers  = /eau|oi|ais|eur|eux|ment|être|avoir/i;
  const frenchFieldLooksSpanish = filtered.filter(p => spanishMarkers.test(p.french)).length;
  const spanishFieldLooksFrench = filtered.filter(p => frenchMarkers.test(p.spanish)).length;

  if (frenchFieldLooksSpanish > filtered.length * 0.4 || spanishFieldLooksFrench > filtered.length * 0.4) {
    log('Languages appear swapped — correcting automatically', 'warn');
    filtered.forEach(p => { [p.french, p.spanish] = [p.spanish, p.french]; });
  }

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
  setKeyStatus('Validating key…', 'loading');
  try {
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
    // Send original image — no resize, preserves quality for Claude to read handwriting
    const sizeKB = Math.round(State.imageDataURL.length * 0.75 / 1024);
    log(`Original image: ${sizeKB} KB — sending as-is`);
    setStatus('Sending to Claude Vision (up to 30s)…', 'loading');
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

// Persist weak words to localStorage keyed by vocab set (based on french words joined)
function weakWordsKey() {
  return 'weak_' + State.vocab.map(p => p.french.trim().toLowerCase()).sort().join('|').substring(0, 120);
}

function saveWeakWords() {
  const weak = State.cards
    .filter(c => c.firstAttempt === 'wrong' || c.firstAttempt === 'partial')
    .map(c => ({ french: c.french, spanish: c.spanish, firstAttempt: c.firstAttempt, userAnswer: c.userAnswer }));
  localStorage.setItem(weakWordsKey(), JSON.stringify(weak));
  log(`Saved ${weak.length} weak word(s) to localStorage`);
}

function loadWeakWords() {
  return JSON.parse(localStorage.getItem(weakWordsKey()) || '[]');
}

function startQuiz(cardsOverride = null) {
  quizImage.src = State.imageDataURL;
  State.cards   = (cardsOverride || State.vocab).map(p => makeCard(p.french, p.spanish));
  // firstAttempt: null = not yet seen | 'correct' | 'partial' | 'wrong'
  State.cards.forEach(c => {
    c.firstAttempt  = null;
    c.userAnswer    = '';
    c.reinforced    = false;  // true once the one reinforcement attempt has happened
    c.sessionResult = null;
  });
  State.queue    = shuffle(State.cards.map((_, i) => i));
  State.queuePos = 0;
  State.sessionStats = { correct: 0, partial: 0, wrong: 0 };
  updateStatsBar();
  showView('quiz');
  showNextCard();
}

function showNextCard() {
  // Advance past cards that are fully done for this session
  while (State.queuePos < State.queue.length &&
         State.cards[State.queue[State.queuePos]].sessionResult === 'done') {
    State.queuePos++;
  }

  if (State.queuePos >= State.queue.length) {
    endSession();
    return;
  }

  const ci   = State.queue[State.queuePos];
  const card = State.cards[ci];

  // Label the card if it's a reinforcement attempt
  const isReinforcement = card.firstAttempt !== null;
  quizWordEl.textContent = card.french;
  quizInput.value = '';
  quizFeedback.classList.add('hidden');
  btnNext.classList.add('hidden');
  quizInput.disabled = false;
  quizForm.querySelector('button[type="submit"]').disabled = false;

  // Show reinforcement label on the prompt
  const promptEl = document.querySelector('.quiz-prompt');
  if (isReinforcement) {
    promptEl.innerHTML = 'French &rarr; Spanish: <span class="reinforce-badge">Try again</span>';
  } else {
    promptEl.innerHTML = 'French &rarr; Spanish:';
  }

  quizInput.focus();

  // Progress: based on first-attempt seen cards
  const seen  = State.cards.filter(c => c.firstAttempt !== null).length;
  const total = State.cards.length;
  progressBar.style.width  = `${total ? Math.round(seen / total * 100) : 0}%`;
  progressLabel.textContent = `${seen} / ${total} words seen`;
}

quizForm.addEventListener('submit', e => {
  e.preventDefault();
  const ci   = State.queue[State.queuePos];
  const card = State.cards[ci];
  const { quality, verdict } = evaluate(quizInput.value, card.spanish);
  const isFirstAttempt = card.firstAttempt === null;

  quizInput.disabled = true;
  quizForm.querySelector('button[type="submit"]').disabled = true;

  // Build feedback message
  quizFeedback.className = `quiz-feedback ${verdict}`;
  if (verdict === 'correct') {
    quizFeedback.innerHTML = `Correct! <strong>${escHtml(card.spanish)}</strong>`;
  } else if (verdict === 'partial') {
    quizFeedback.innerHTML = `Close — the answer is <strong>${escHtml(card.spanish)}</strong>`;
  } else {
    quizFeedback.innerHTML = `Incorrect — the answer is <strong>${escHtml(card.spanish)}</strong>`;
  }
  quizFeedback.classList.remove('hidden');
  btnNext.classList.remove('hidden');

  // Update SM-2
  sm2Update(card, quality);

  if (isFirstAttempt) {
    // Record first attempt
    card.firstAttempt = verdict;
    card.userAnswer   = quizInput.value.trim();

    if (verdict === 'correct') {
      State.sessionStats.correct++;
      card.sessionResult = 'done';  // correct first try → done immediately
    } else if (verdict === 'partial') {
      State.sessionStats.partial++;
      // One reinforcement: insert 3 spots ahead
      State.queue.splice(Math.min(State.queuePos + 3, State.queue.length), 0, ci);
    } else {
      State.sessionStats.wrong++;
      // One reinforcement: insert 2 spots ahead
      State.queue.splice(Math.min(State.queuePos + 2, State.queue.length), 0, ci);
    }
  } else {
    // This is the reinforcement attempt — mark done regardless of result
    card.sessionResult = 'done';
    card.reinforced    = true;
    if (verdict === 'correct') {
      quizFeedback.innerHTML = `Got it this time! <strong>${escHtml(card.spanish)}</strong>`;
      quizFeedback.className = 'quiz-feedback correct';
    }
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
const resultsSummary     = document.getElementById('results-summary');
const resultsWeakSection = document.getElementById('results-weak-section');
const resultsWeakTbody   = document.getElementById('results-weak-tbody');
const resultsWeakTitle   = document.getElementById('results-weak-title');
const resultsStrongSection = document.getElementById('results-strong-section');
const resultsStrongTbody   = document.getElementById('results-strong-tbody');
const resultsStrongTitle   = document.getElementById('results-strong-title');
const btnNewSession      = document.getElementById('btn-new-session');
const btnWeakSession     = document.getElementById('btn-weak-session');
const btnReviewAgain     = document.getElementById('btn-review-again');

function nextReviewStr(card) {
  if (card.interval <= 0) return 'Again today';
  if (card.interval === 1) return 'Tomorrow';
  return `In ${card.interval} days`;
}

function endSession() {
  log('Session complete — showing results');

  const weak   = State.cards.filter(c => c.firstAttempt === 'wrong' || c.firstAttempt === 'partial');
  const strong = State.cards.filter(c => c.firstAttempt === 'correct');

  // Save weak words to localStorage for future sessions
  saveWeakWords();

  // Summary stats
  const { correct, partial, wrong } = State.sessionStats;
  resultsSummary.innerHTML = `
    <div class="result-stat green"><div class="number">${correct}</div><div class="label">Correct</div></div>
    <div class="result-stat amber"><div class="number">${partial}</div><div class="label">Close</div></div>
    <div class="result-stat red"><div class="number">${wrong}</div><div class="label">Wrong</div></div>`;

  // Weak words section
  if (weak.length > 0) {
    resultsWeakTitle.textContent = `To review (${weak.length} word${weak.length > 1 ? 's' : ''})`;
    resultsWeakTbody.innerHTML = '';
    weak.forEach(card => {
      const tr = document.createElement('tr');
      const wasWrong = card.firstAttempt === 'wrong';
      tr.innerHTML = `
        <td>${escHtml(card.french)}</td>
        <td><strong>${escHtml(card.spanish)}</strong></td>
        <td><span class="badge ${card.firstAttempt}">${escHtml(card.userAnswer) || '—'}</span></td>
        <td>${nextReviewStr(card)}</td>`;
      resultsWeakTbody.appendChild(tr);
    });
    resultsWeakSection.classList.remove('hidden');
    btnWeakSession.classList.remove('hidden');
    btnWeakSession.textContent = `Practice ${weak.length} weak word${weak.length > 1 ? 's' : ''}`;
  } else {
    resultsWeakSection.classList.add('hidden');
    btnWeakSession.classList.add('hidden');
  }

  // Strong words section
  if (strong.length > 0) {
    resultsStrongTitle.textContent = `Mastered (${strong.length} word${strong.length > 1 ? 's' : ''})`;
    resultsStrongTbody.innerHTML = '';
    strong.forEach(card => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escHtml(card.french)}</td>
        <td>${escHtml(card.spanish)}</td>
        <td>${nextReviewStr(card)}</td>`;
      resultsStrongTbody.appendChild(tr);
    });
    resultsStrongSection.classList.remove('hidden');
  } else {
    resultsStrongSection.classList.add('hidden');
  }

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

// Practice only weak words
btnWeakSession.addEventListener('click', () => {
  const weak = State.cards.filter(c => c.firstAttempt === 'wrong' || c.firstAttempt === 'partial');
  if (weak.length === 0) return;
  log(`Starting weak-words session with ${weak.length} cards`);
  startQuiz(weak.map(c => ({ french: c.french, spanish: c.spanish })));
});

// Full review of all words
btnReviewAgain.addEventListener('click', () => {
  log('Starting full review session');
  startQuiz(State.vocab);
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
