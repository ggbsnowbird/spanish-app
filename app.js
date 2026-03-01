/* =============================================================
   Spanish Vocabulary Trainer
   Stack: Vanilla JS  |  Algorithm: SM-2 Spaced Repetition
   ============================================================= */

'use strict';

// ----------------------------------------------------------------
// STATE
// ----------------------------------------------------------------
const State = {
  apiKey:     '',
  imageDataURL: '',   // base64 data URL of uploaded image
  vocab:      [],     // [{ french, spanish }]
  cards:      [],     // SM-2 card objects for current session
  queue:      [],     // indices into cards[], in play order
  queuePos:   0,
  sessionStats: { correct: 0, partial: 0, wrong: 0 },
};

// ----------------------------------------------------------------
// SM-2 CARD FACTORY
// ----------------------------------------------------------------
function makeCard(french, spanish) {
  // Load persisted SM-2 data if it exists
  const key   = `sm2_${french.trim().toLowerCase()}`;
  const saved = JSON.parse(localStorage.getItem(key) || 'null');
  return {
    french,
    spanish,
    // SM-2 fields
    easeFactor:   saved?.easeFactor   ?? 2.5,
    interval:     saved?.interval     ?? 0,    // days
    repetitions:  saved?.repetitions  ?? 0,
    dueDate:      saved?.dueDate      ?? 0,    // timestamp ms
    // Session tracking
    lastQuality:  null,   // 0-5
    sessionResult: null,  // 'correct' | 'partial' | 'wrong'
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

// SM-2 update given quality q (0–5)
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
// FUZZY MATCH  (returns quality 0–5)
// ----------------------------------------------------------------
function normalize(s) {
  return s.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accents
    .replace(/[^a-z\s]/g, '');                          // strip punctuation
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

// Returns { quality: 0|2|5, verdict: 'correct'|'partial'|'wrong' }
function evaluate(input, expected) {
  const a = normalize(input);
  const b = normalize(expected);

  if (a === b) return { quality: 5, verdict: 'correct' };

  // Allow 1-char typo for short words, 2-char for longer
  const maxDist = b.length <= 4 ? 1 : 2;
  if (levenshtein(a, b) <= maxDist) return { quality: 4, verdict: 'correct' };

  // Partial: missing/wrong accent only (normalized match)
  // We already normalized above — if we reach here accents were NOT the only diff.
  // Check if only ONE accent was wrong (raw comparison after stripping just accents)
  const rawA = input.trim().toLowerCase().replace(/[^a-z\s\u00C0-\u024F]/gi,'');
  const rawB = expected.trim().toLowerCase().replace(/[^a-z\s\u00C0-\u024F]/gi,'');
  if (levenshtein(normalize(rawA), normalize(rawB)) === 0 && rawA !== rawB) {
    // Accent-only error
    return { quality: 3, verdict: 'partial' };
  }

  // Partial: close but not quite (distance ≤ 4 for longer words)
  const dist = levenshtein(a, b);
  const threshold = Math.ceil(b.length * 0.4);
  if (dist <= threshold && threshold >= 2) return { quality: 2, verdict: 'partial' };

  return { quality: 0, verdict: 'wrong' };
}

// ----------------------------------------------------------------
// OPENAI VISION  →  vocab list
// ----------------------------------------------------------------
async function extractVocabFromImage(imageDataURL, apiKey) {
  const base64 = imageDataURL.split(',')[1];
  const mimeType = imageDataURL.match(/data:(image\/\w+);/)?.[1] ?? 'image/jpeg';

  const body = {
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
          image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' },
        },
      ],
    }],
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';

  // Strip possible markdown code fences
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const pairs = JSON.parse(cleaned);
  if (!Array.isArray(pairs)) throw new Error('Unexpected response format from OpenAI.');
  return pairs.filter(p => p.french && p.spanish);
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
const apiKeyInput     = document.getElementById('api-key-input');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnCloseSettings= document.getElementById('btn-close-settings');
const btnSettings     = document.getElementById('btn-settings');

function loadSettings() {
  State.apiKey = localStorage.getItem('openai_api_key') ?? '';
  apiKeyInput.value = State.apiKey;
}

btnSettings.addEventListener('click', () => {
  apiKeyInput.value = State.apiKey;
  showView('settings');
});
btnSaveSettings.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) { alert('Please enter a valid API key.'); return; }
  State.apiKey = key;
  localStorage.setItem('openai_api_key', key);
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
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    State.imageDataURL = e.target.result;
    imagePreview.src   = State.imageDataURL;
    imagePreview.classList.remove('hidden');
    dropLabel.classList.add('hidden');
    extractStatus.classList.add('hidden');
    btnExtract.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

// Drag-and-drop
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});

btnExtract.addEventListener('click', async () => {
  if (!State.apiKey) {
    setStatus('No API key set. Click the gear icon to enter your OpenAI key.', 'error');
    return;
  }
  btnExtract.disabled = true;
  setStatus('Sending image to OpenAI Vision — please wait...', 'loading');
  try {
    const pairs = await extractVocabFromImage(State.imageDataURL, State.apiKey);
    if (pairs.length === 0) {
      setStatus('No word pairs found. Try a clearer image or add them manually in the next step.', 'error');
      btnExtract.disabled = false;
      return;
    }
    State.vocab = pairs;
    setStatus(`Found ${pairs.length} word pair${pairs.length > 1 ? 's' : ''}!`, 'success');
    setTimeout(() => buildReviewView(), 800);
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    btnExtract.disabled = false;
  }
});

// ----------------------------------------------------------------
// REVIEW VIEW
// ----------------------------------------------------------------
const vocabTbody  = document.getElementById('vocab-tbody');
const btnAddRow   = document.getElementById('btn-add-row');
const btnStartQuiz= document.getElementById('btn-start-quiz');
const reviewImage = document.getElementById('review-image');

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
      <td><button class="btn-delete-row" data-i="${i}" title="Remove row">&#10005;</button></td>`;
    vocabTbody.appendChild(tr);
  });
  // Live edit sync
  vocabTbody.querySelectorAll('[contenteditable]').forEach(cell => {
    cell.addEventListener('input', () => {
      const i = +cell.dataset.i;
      const f = cell.dataset.field;
      State.vocab[i][f] = cell.textContent.trim();
    });
  });
  // Delete buttons
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
  // Focus last French cell
  const cells = vocabTbody.querySelectorAll('[data-field="french"]');
  cells[cells.length - 1]?.focus();
});

btnStartQuiz.addEventListener('click', () => {
  const clean = State.vocab.filter(p => p.french.trim() && p.spanish.trim());
  if (clean.length === 0) { alert('Add at least one word pair first.'); return; }
  State.vocab = clean;
  startQuiz();
});

// ----------------------------------------------------------------
// QUIZ ENGINE
// ----------------------------------------------------------------
const quizImage    = document.getElementById('quiz-image');
const quizWordEl   = document.getElementById('quiz-word');
const quizForm     = document.getElementById('quiz-form');
const quizInput    = document.getElementById('quiz-input');
const quizFeedback = document.getElementById('quiz-feedback');
const btnNext      = document.getElementById('btn-next');
const progressBar  = document.getElementById('progress-bar');
const progressLabel= document.getElementById('progress-label');
const statCorrect  = document.getElementById('stat-correct');
const statPartial  = document.getElementById('stat-partial');
const statWrong    = document.getElementById('stat-wrong');

function startQuiz() {
  quizImage.src = State.imageDataURL;

  // Build card list
  State.cards = State.vocab.map(p => makeCard(p.french, p.spanish));

  // Build initial queue: all cards, shuffled
  State.queue = shuffle(State.cards.map((_, i) => i));
  State.queuePos = 0;
  State.sessionStats = { correct: 0, partial: 0, wrong: 0 };

  updateStatsBar();
  showView('quiz');
  showNextCard();
}

function showNextCard() {
  // Find the next card index that is not yet 'correct' in this session
  // The queue may have repeats for wrong answers
  while (State.queuePos < State.queue.length) {
    const ci = State.queue[State.queuePos];
    if (State.cards[ci].sessionResult === 'correct') {
      State.queuePos++;
      continue;
    }
    break;
  }

  if (State.queuePos >= State.queue.length) {
    // Check if any cards still need repeating
    const pending = State.cards.filter(c => c.sessionResult !== 'correct');
    if (pending.length === 0) {
      endSession();
      return;
    }
    // Re-queue pending cards (wrong/partial), shuffled
    const pendingIdx = State.cards
      .map((c, i) => c.sessionResult !== 'correct' ? i : -1)
      .filter(i => i >= 0);
    State.queue.push(...shuffle(pendingIdx));
  }

  const ci = State.queue[State.queuePos];
  const card = State.cards[ci];

  quizWordEl.textContent = card.french;
  quizInput.value = '';
  quizFeedback.classList.add('hidden');
  btnNext.classList.add('hidden');
  quizInput.disabled = false;
  quizForm.querySelector('button[type="submit"]').disabled = false;
  quizInput.focus();

  // Progress: % of cards with sessionResult === 'correct'
  const done   = State.cards.filter(c => c.sessionResult === 'correct').length;
  const total  = State.cards.length;
  const pct    = total ? Math.round((done / total) * 100) : 0;
  progressBar.style.width  = pct + '%';
  progressLabel.textContent = `${done} / ${total} mastered this session`;
}

quizForm.addEventListener('submit', e => {
  e.preventDefault();
  const ci   = State.queue[State.queuePos];
  const card = State.cards[ci];
  const { quality, verdict } = evaluate(quizInput.value, card.spanish);

  // Disable input while feedback shown
  quizInput.disabled = true;
  quizForm.querySelector('button[type="submit"]').disabled = true;

  // Feedback message
  quizFeedback.className = `quiz-feedback ${verdict}`;
  if (verdict === 'correct') {
    quizFeedback.innerHTML = `Correct! <strong>${card.spanish}</strong>`;
  } else if (verdict === 'partial') {
    quizFeedback.innerHTML = `Close — the answer is <strong>${card.spanish}</strong>`;
  } else {
    quizFeedback.innerHTML = `Incorrect — the answer is <strong>${card.spanish}</strong>`;
  }
  quizFeedback.classList.remove('hidden');
  btnNext.classList.remove('hidden');

  // Update SM-2
  sm2Update(card, quality);

  // Update session result
  if (verdict === 'correct') {
    if (card.sessionResult !== 'correct') {
      State.sessionStats.correct++;
      card.sessionResult = 'correct';
    }
  } else if (verdict === 'partial') {
    if (card.sessionResult === null) State.sessionStats.partial++;
    if (card.sessionResult === null) card.sessionResult = 'partial';
    // Re-insert into queue a few spots ahead so it comes up again
    const insertAt = Math.min(State.queuePos + 3, State.queue.length);
    State.queue.splice(insertAt, 0, ci);
  } else {
    if (card.sessionResult === null) State.sessionStats.wrong++;
    if (card.sessionResult === null) card.sessionResult = 'wrong';
    // Re-insert soon
    const insertAt = Math.min(State.queuePos + 2, State.queue.length);
    State.queue.splice(insertAt, 0, ci);
  }

  updateStatsBar();
});

btnNext.addEventListener('click', () => {
  State.queuePos++;
  showNextCard();
});

function updateStatsBar() {
  statCorrect.textContent = `Correct: ${State.sessionStats.correct}`;
  statPartial.textContent = `Close: ${State.sessionStats.partial}`;
  statWrong.textContent   = `Wrong: ${State.sessionStats.wrong}`;
}

// ----------------------------------------------------------------
// RESULTS VIEW
// ----------------------------------------------------------------
const resultsTbody  = document.getElementById('results-tbody');
const resultsSummary= document.getElementById('results-summary');
const btnNewSession = document.getElementById('btn-new-session');
const btnReviewAgain= document.getElementById('btn-review-again');

function endSession() {
  // Build results table
  resultsTbody.innerHTML = '';
  State.cards.forEach(card => {
    const result  = card.sessionResult ?? 'wrong';
    const nextStr = card.interval <= 1
      ? 'Tomorrow'
      : `In ${card.interval} day${card.interval > 1 ? 's' : ''}`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escHtml(card.french)}</td>
      <td>${escHtml(card.spanish)}</td>
      <td><span class="badge ${result}">${capitalize(result)}</span></td>
      <td>${nextStr}</td>`;
    resultsTbody.appendChild(tr);
  });

  // Summary stats
  const { correct, partial, wrong } = State.sessionStats;
  resultsSummary.innerHTML = `
    <div class="result-stat green"><div class="number">${correct}</div><div class="label">Correct</div></div>
    <div class="result-stat amber"><div class="number">${partial}</div><div class="label">Close</div></div>
    <div class="result-stat red"><div class="number">${wrong}</div><div class="label">Wrong</div></div>`;

  showView('results');
}

btnNewSession.addEventListener('click', () => {
  // Reset upload view for a new image
  imagePreview.classList.add('hidden');
  dropLabel.classList.remove('hidden');
  btnExtract.classList.add('hidden');
  btnExtract.disabled = false;
  extractStatus.classList.add('hidden');
  fileInput.value = '';
  State.imageDataURL = '';
  State.vocab = [];
  showView('upload');
});

btnReviewAgain.addEventListener('click', () => {
  // Reset session results on cards, keep SM-2 data, restart quiz
  State.cards.forEach(c => { c.sessionResult = null; c.lastQuality = null; });
  State.queue = shuffle(State.cards.map((_, i) => i));
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

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ----------------------------------------------------------------
// INIT
// ----------------------------------------------------------------
function init() {
  loadSettings();
  if (!State.apiKey) {
    // First launch: show settings first
    showView('settings');
  } else {
    showView('upload');
  }
}

init();
