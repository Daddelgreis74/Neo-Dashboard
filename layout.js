// layout.js – Drag & Drop + Kachel-Sichtbarkeit
// Wird nach SortableJS und dem Dashboard-HTML geladen.

const TILE_LABELS = {
  weather: '🌤️ Wetter',
  server:  '🖥️ Server',
  abfall:  '🗑️ Abfuhrkalender',
  tasmota: '🔌 Tasmota',
  neo:     '🤖 Neo Status',
  calendar: '📅 Eigene Termine',
  postit:  '📝 Notizen',
  news:    '📰 News',
  fuel:    '⛽ Benzinpreise',
  voice:   '🎙️ Neo Voice'
};

let currentLayout = { order: ['weather','server','abfall','postit','news','tasmota','neo','calendar','fuel','voice'], visible: { weather:true, server:true, abfall:true, postit:true, news:true, tasmota:true, neo:true, calendar:true, fuel:true, voice:true } };
let sortableInstance = null;

// ── Laden vom Server ──────────────────────────────────────
async function loadLayout() {
  try {
    const data = await fetch('/api/layout').then(r => r.json());
    currentLayout = data;
    applyLayout();
  } catch(e) { console.warn('Layout laden fehlgeschlagen', e); }
}

// ── Speichern auf Server ──────────────────────────────────
async function saveLayout() {
  try {
    await fetch('/api/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentLayout)
    });
  } catch(e) { console.warn('Layout speichern fehlgeschlagen', e); }
}

// ── Layout anwenden (Reihenfolge + Sichtbarkeit) ──────────
function applyLayout() {
  const grid = document.getElementById('tile-grid');
  if (!grid) return;

  // Reihenfolge wiederherstellen
  currentLayout.order.forEach(id => {
    const el = document.getElementById('tile-' + id);
    if (el) grid.appendChild(el);
  });

  // Sichtbarkeit setzen
  Object.keys(currentLayout.visible).forEach(id => {
    const el = document.getElementById('tile-' + id);
    if (el) el.style.display = currentLayout.visible[id] ? '' : 'none';
  });
}

// ── SortableJS initialisieren ─────────────────────────────
function initSortable() {
  const grid = document.getElementById('tile-grid');
  if (!grid || typeof Sortable === 'undefined') return;

  sortableInstance = Sortable.create(grid, {
    animation: 150,
    ghostClass: 'drag-ghost',
    chosenClass: 'drag-chosen',
    handle: '.tile-drag-handle',
    onEnd: () => {
      // neue Reihenfolge aus dem DOM lesen
      const newOrder = Array.from(grid.children)
        .map(el => el.id.replace('tile-', ''))
        .filter(id => TILE_LABELS[id]);
      currentLayout.order = newOrder;
      saveLayout();
    }
  });
}

// ── Layout-Tab im Modal rendern ───────────────────────────
function renderLayoutTab() {
  const container = document.getElementById('panel-layout');
  if (!container) return;

  container.innerHTML = `
    <p style="font-size:12px;color:#7d8590;margin-bottom:12px;">
      Kacheln ein-/ausblenden. Reihenfolge per Drag &amp; Drop direkt im Dashboard ändern (🟰 Handle ziehen).
    </p>
    <div id="layout-toggles"></div>
    <p style="font-size:11px;color:#7d8590;margin-top:10px;">Layout wird automatisch gespeichert.</p>
  `;

  const togglesEl = document.getElementById('layout-toggles');
  currentLayout.order.forEach(id => {
    const visible = currentLayout.visible[id] !== false;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#0d1117;border-radius:8px;margin-bottom:6px;';
    row.innerHTML = `
      <span style="font-size:13px;">${TILE_LABELS[id] || id}</span>
      <label class="toggle">
        <input type="checkbox" ${visible ? 'checked' : ''} onchange="toggleTile('${id}', this.checked)">
        <span class="slider"></span>
      </label>
    `;
    togglesEl.appendChild(row);
  });
}

// ── Einzelne Kachel umschalten ────────────────────────────
function toggleTile(id, visible) {
  currentLayout.visible[id] = visible;
  const el = document.getElementById('tile-' + id);
  if (el) el.style.display = visible ? '' : 'none';
  saveLayout();
}

// ── Init beim Seitenload ──────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadLayout().then(() => initSortable());
});
