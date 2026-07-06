// ── CONSTANTS ──────────────────────────────────────────────────────────────

const LEVELS = {
  bajo:    { buffer: 100,  label: 'Bajo' },
  medio:   { buffer: 250,  label: 'Medio' },
  alto:    { buffer: 500,  label: 'Alto' },
  critico: { buffer: 800,  label: 'Crítico' }
};

const INFRA = {
  hospital: { emoji: '🏥', label: 'Hospitales / Clínicas' },
  school:   { emoji: '🏫', label: 'Escuelas' },
  fire:     { emoji: '🚒', label: 'Bomberos' },
  police:   { emoji: '🚔', label: 'Carabineros' },
  bridge:   { emoji: '🌉', label: 'Puentes' }
};

const OVERPASS  = 'https://overpass-api.de/api/interpreter';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// ── STATE ───────────────────────────────────────────────────────────────────

let chileData      = null;
let riversGeoJSON  = null;  // todas las líneas de agua de la comuna
let infraFeatures  = [];
let namesMap       = new Map(); // nombre_río → [features]
let selectedRiverId = null;     // null = "todos"
let activeGeoJSON  = null;      // GeoJSON sobre el que se calcula el buffer
let bufferedPolygon = null;
let currentBuffer  = 250;

let riversLayer = null;
let bufferLayer = null;
let infraLayer  = null;

// ── MAP + PANES ──────────────────────────────────────────────────────────────

const cartoLight = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  { attribution: '© OpenStreetMap © CARTO', maxZoom: 19 }
);
const osmLayer = L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { attribution: '© OpenStreetMap contributors', maxZoom: 19 }
);
const satellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { attribution: '© Esri', maxZoom: 18 }
);
const cartoDark = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  { attribution: '© OpenStreetMap © CARTO', maxZoom: 19 }
);

const map = L.map('map', {
  center: [-35.5, -71.0],
  zoom: 6,
  layers: [cartoLight]
});

// Panes garantizan orden z: buffer < ríos < infra
map.createPane('buffers'); map.getPane('buffers').style.zIndex = 400;
map.createPane('rivers');  map.getPane('rivers').style.zIndex  = 450;
map.createPane('infra');   map.getPane('infra').style.zIndex   = 500;

L.control.layers({
  '☀️ Mapa claro':    cartoLight,
  '🗺 OpenStreetMap': osmLayer,
  '🛰 Satélite':      satellite,
  '🌙 Mapa oscuro':   cartoDark
}, null, { position: 'topright', collapsed: true }).addTo(map);

// ── ADMIN DATA ───────────────────────────────────────────────────────────────

async function loadAdminData() {
  try {
    const res  = await fetch('data/chile.json');
    chileData  = await res.json();
    const sel  = document.getElementById('regSelect');
    chileData.regiones.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.nombre;
      opt.textContent = `${r.numero} — ${r.nombre}`;
      sel.appendChild(opt);
    });
  } catch (e) {
    setStatus('Error al cargar datos administrativos', 'error');
  }
}

// ── DROPDOWN CASCADA ─────────────────────────────────────────────────────────

document.getElementById('regSelect').addEventListener('change', function () {
  const provSel   = document.getElementById('provSelect');
  const comunaSel = document.getElementById('comunaSelect');

  provSel.innerHTML   = '<option value="">— Selecciona provincia —</option>';
  comunaSel.innerHTML = '<option value="">— Selecciona comuna —</option>';
  provSel.disabled    = !this.value;
  comunaSel.disabled  = true;
  clearAll();

  if (!this.value) return;
  const region = chileData.regiones.find(r => r.nombre === this.value);
  region.provincias.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.nombre;
    opt.textContent = p.nombre;
    provSel.appendChild(opt);
  });
});

document.getElementById('provSelect').addEventListener('change', function () {
  const regNombre = document.getElementById('regSelect').value;
  const comunaSel = document.getElementById('comunaSelect');

  comunaSel.innerHTML = '<option value="">— Selecciona comuna —</option>';
  comunaSel.disabled  = !this.value;
  clearAll();

  if (!this.value) return;
  const region = chileData.regiones.find(r => r.nombre === regNombre);
  const prov   = region.provincias.find(p => p.nombre === this.value);
  prov.comunas.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    comunaSel.appendChild(opt);
  });
});

document.getElementById('comunaSelect').addEventListener('change', function () {
  clearAll();
  if (!this.value) return;
  const region = document.getElementById('regSelect').value;
  geocodeAndLoad(this.value, region);
});

// ── GEOCODE + LOAD ────────────────────────────────────────────────────────────

async function geocodeAndLoad(comuna, region) {
  setStatus(`Buscando ${comuna}...`, 'loading');
  try {
    const q   = `${comuna}, ${region}, Chile`;
    const res = await fetch(`${NOMINATIM}?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=0`);
    const data = await res.json();

    if (!data.length) {
      setStatus('No se pudo encontrar la comuna en el mapa.', 'error');
      return;
    }

    // boundingbox: [min_lat, max_lat, min_lon, max_lon]
    const [bS, bN, bW, bE] = data[0].boundingbox.map(Number);
    const cLat = +data[0].lat;
    const cLon = +data[0].lon;

    // Vista del mapa: bbox de Nominatim
    map.fitBounds([[bS, bW], [bN, bE]], { padding: [30, 30], maxZoom: 14 });

    await Promise.all([
      fetchRiversByComuna(comuna, bS, bW, bN, bE),
      fetchInfraBbox(bS, bW, bN, bE)
    ]);

    buildRiverList();

  } catch (err) {
    setStatus('Error de conexión. Verifica tu internet.', 'error');
    console.error(err);
  }
}

// ── FETCH RIVERS ─────────────────────────────────────────────────────────────

async function fetchRiversByComuna(comunaNombre, bS, bW, bN, bE) {
  // Estrategia primaria: área administrativa exacta de la comuna (admin_level=8).
  // Solo muestra la hidrografía que cae dentro del límite comunal.
  // Incluye ways con tag directo Y ways miembros de relaciones waterway
  // (ríos principales como el Maule, modelados en OSM como relaciones).
  const areaQuery = `
[out:json][timeout:30];
area["name"="${comunaNombre}"]["admin_level"="8"]["boundary"="administrative"]->.a;
(
  way["waterway"~"^(river|stream|canal)$"](area.a);
  rel["waterway"~"^(river|canal)$"](area.a)->.rels;
  way(r.rels)(area.a);
);
out geom;`;

  // Fallback bbox: si la comuna no está en OSM con ese nombre exacto.
  const bboxQuery = `
[out:json][timeout:30];
(
  way["waterway"~"^(river|stream|canal)$"](${bS},${bW},${bN},${bE});
  rel["waterway"~"^(river|canal)$"](${bS},${bW},${bN},${bE})->.rels;
  way(r.rels)(${bS},${bW},${bN},${bE});
);
out geom;`;

  try {
    let res  = await fetch(OVERPASS, { method: 'POST', body: areaQuery });
    let data = await res.json();

    // Si el área no devuelve nada, usar bbox como respaldo
    const hasResults = data.elements?.some(el => el.type === 'way' && el.geometry?.length >= 2);
    if (!hasResults) {
      res  = await fetch(OVERPASS, { method: 'POST', body: bboxQuery });
      data = await res.json();
    }

    processRiverElements(data.elements || []);

  } catch (e) {
    console.error('Error al cargar ríos:', e);
    setStatus('No se pudo cargar la hidrografía.', 'error');
  }
}

function processRiverElements(elements) {
  const features = elements
    .filter(el => el.type === 'way' && el.geometry?.length >= 2)
    .map(el => ({
      type: 'Feature',
      properties: {
        name:     el.tags?.name || '',
        waterway: el.tags?.waterway || ''
      },
      geometry: {
        type: 'LineString',
        coordinates: el.geometry.map(p => [p.lon, p.lat])
      }
    }));

  riversGeoJSON = { type: 'FeatureCollection', features };

  namesMap.clear();
  features.forEach(f => {
    if (!f.properties.name) return;
    const key = f.properties.name.toLowerCase().trim();
    if (!namesMap.has(key)) namesMap.set(key, { name: f.properties.name, features: [] });
    namesMap.get(key).features.push(f);
  });

  renderRiversLayer(null);
}

// ── FETCH INFRA ───────────────────────────────────────────────────────────────

async function fetchInfraBbox(s, w, n, e) {
  const query = `
[out:json][timeout:25];
(
  node["amenity"~"^(hospital|clinic|school|university|fire_station|police)$"](${s},${w},${n},${e});
  way["man_made"="bridge"](${s},${w},${n},${e});
);
out center;`;
  try {
    const res  = await fetch(OVERPASS, { method: 'POST', body: query });
    const data = await res.json();

    infraFeatures = data.elements
      .map(el => {
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (!lat || !lng) return null;
        return { id: el.id, lat, lng, name: el.tags?.name || '', type: classifyInfra(el.tags) };
      })
      .filter(f => f && f.type !== 'unknown');

  } catch (e) {
    console.error('Error al cargar infraestructura:', e);
  }
}

function classifyInfra(tags) {
  if (!tags) return 'unknown';
  if (tags.amenity === 'hospital' || tags.amenity === 'clinic')      return 'hospital';
  if (tags.amenity === 'school'   || tags.amenity === 'university')  return 'school';
  if (tags.amenity === 'fire_station')                                return 'fire';
  if (tags.amenity === 'police')                                      return 'police';
  if (tags.man_made === 'bridge')                                     return 'bridge';
  return 'unknown';
}

// ── RIVER LIST ────────────────────────────────────────────────────────────────

function buildRiverList() {
  const section = document.getElementById('riverSection');
  const list    = document.getElementById('riverList');
  const empty   = document.getElementById('riverEmpty');

  section.style.display = '';

  if (!riversGeoJSON || !riversGeoJSON.features.length) {
    list.innerHTML   = '';
    empty.style.display = '';
    setStatus('No se encontraron ríos en esta zona.', '');
    return;
  }

  empty.style.display = 'none';

  // Opción "todos"
  const totalTramos = riversGeoJSON.features.length;
  let html = `
    <div class="river-item river-item-all selected" data-id="__all__">
      <div class="river-dot"></div>
      <span>Todos los cursos de agua</span>
      <span class="river-tramos">${totalTramos}</span>
    </div>`;

  // Ríos con nombre, ordenados alfabéticamente
  const sorted = [...namesMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  sorted.forEach(([key, r]) => {
    html += `
      <div class="river-item" data-id="${key}">
        <div class="river-dot"></div>
        <span>${r.name}</span>
        <span class="river-tramos">${r.features.length}</span>
      </div>`;
  });

  list.innerHTML = html;

  list.querySelectorAll('.river-item').forEach(item => {
    item.addEventListener('click', () => selectRiver(item.dataset.id));
  });

  // Auto-seleccionar "todos" e inicializar buffer
  selectRiver('__all__');
  showControls(true);
}

// ── RIVER SELECTION ───────────────────────────────────────────────────────────

function selectRiver(id) {
  selectedRiverId = id;

  document.querySelectorAll('.river-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });

  if (id === '__all__') {
    activeGeoJSON = riversGeoJSON;
    renderRiversLayer(null);
  } else {
    const entry = namesMap.get(id);
    if (!entry) return;
    activeGeoJSON = { type: 'FeatureCollection', features: entry.features };
    renderRiversLayer(id);

    // Zoom al río seleccionado
    try {
      const coords = entry.features.flatMap(f => f.geometry.coordinates);
      const latlngs = coords.map(c => [c[1], c[0]]);
      map.fitBounds(latlngs, { padding: [40, 40], maxZoom: 15 });
    } catch (_) {}
  }

  updateBuffer(currentBuffer);
}

// ── RENDER RIVERS ─────────────────────────────────────────────────────────────

function renderRiversLayer(selectedId) {
  if (riversLayer) { map.removeLayer(riversLayer); riversLayer = null; }
  if (!riversGeoJSON) return;

  riversLayer = L.geoJSON(riversGeoJSON, {
    pane: 'rivers',
    style: f => {
      const key = (f.properties.name || '').toLowerCase().trim();
      const isSelected = selectedId === null || key === selectedId;
      return isSelected
        ? { color: '#0066cc', weight: 4, opacity: 1 }
        : { color: '#1a3a5c', weight: 1.5, opacity: 0.3 };
    },
    onEachFeature: (f, layer) => {
      if (f.properties.name) {
        layer.bindTooltip(`💧 ${f.properties.name}`, { sticky: true });
      }
    }
  }).addTo(map);
}

// ── BUFFER ───────────────────────────────────────────────────────────────────

function updateBuffer(meters) {
  currentBuffer = meters;
  document.getElementById('sliderVal').textContent     = meters;
  document.getElementById('bufferDisplay').textContent = meters + ' m';

  if (bufferLayer) { map.removeLayer(bufferLayer); bufferLayer = null; }
  bufferedPolygon = null;

  const target = activeGeoJSON;
  if (!target || !target.features.length) { updateImpact(); return; }

  try {
    const lines = target.features.filter(f => f.geometry.type === 'LineString');
    if (!lines.length) { updateImpact(); return; }

    const multi     = turf.multiLineString(lines.map(f => f.geometry.coordinates));
    const simple    = turf.simplify(multi, { tolerance: 0.0003, highQuality: false });
    bufferedPolygon = turf.buffer(simple, meters / 1000, { units: 'kilometers' });

    if (!bufferedPolygon) { updateImpact(); return; }

    const color = bufferColor(meters);
    bufferLayer = L.geoJSON(bufferedPolygon, {
      pane: 'buffers',
      style: { color, fillColor: color, fillOpacity: 0.3, weight: 1.5, opacity: 0.55 }
    }).addTo(map);

  } catch (e) {
    console.error('Error al calcular buffer:', e);
  }

  updateImpact();
}

function bufferColor(m) {
  if (m <= 150) return '#ffdd00';
  if (m <= 350) return '#ff8800';
  if (m <= 600) return '#dd3300';
  return '#880000';
}

// ── IMPACT ───────────────────────────────────────────────────────────────────

function updateImpact() {
  if (infraLayer) { map.removeLayer(infraLayer); infraLayer = null; }

  const counts = {};
  Object.keys(INFRA).forEach(k => { counts[k] = { total: 0, at: 0 }; });

  const atRisk = [], safe = [];

  infraFeatures.forEach(f => {
    if (!counts[f.type]) return;
    counts[f.type].total++;
    let inZone = false;
    if (bufferedPolygon) {
      try { inZone = turf.booleanPointInPolygon(turf.point([f.lng, f.lat]), bufferedPolygon); }
      catch (_) {}
    }
    if (inZone) { counts[f.type].at++; atRisk.push(f); }
    else safe.push(f);
  });

  renderMarkers(atRisk, safe);
  renderImpactPanel(counts);

  if (riversGeoJSON) {
    const r = riversGeoJSON.features.length;
    const a = atRisk.length;
    const t = infraFeatures.length;
    setStatus(`${r} tramos cargados · ${a} de ${t} elementos en riesgo`, a > 0 ? 'error' : 'ok');
  }
}

function renderMarkers(atRisk, safe) {
  const layers = [];
  [...safe, ...atRisk].forEach(f => {
    const risk = atRisk.includes(f);
    const cfg  = INFRA[f.type];
    const m = L.marker([f.lat, f.lng], {
      pane: 'infra',
      icon: L.divIcon({
        className: '',
        html: `<div class="infra-marker${risk ? ' at-risk' : ''}">${cfg.emoji}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      }),
      zIndexOffset: risk ? 500 : 0
    });
    const n = f.name ? `<strong>${f.name}</strong><br>` : '';
    const r = risk ? `<br><span style="color:#ff6b6b">⚠️ En zona de riesgo</span>` : '';
    m.bindTooltip(`${n}${cfg.emoji} ${cfg.label}${r}`, { direction: 'top', offset: [0, -6] });
    layers.push(m);
  });
  infraLayer = L.layerGroup(layers).addTo(map);
}

function renderImpactPanel(counts) {
  const el = document.getElementById('impactList');
  const rows = Object.entries(counts)
    .filter(([, c]) => c.total > 0)
    .map(([type, c]) => {
      const cfg    = INFRA[type];
      const pct    = Math.round((c.at / c.total) * 100);
      const cls    = c.at === 0 ? 'impact-safe' : pct >= 50 ? 'impact-critical' : 'impact-warning';
      const barPct = c.at === 0 ? 0 : Math.max(8, pct);
      return `
        <div class="impact-row ${cls}">
          <div class="impact-icon">${cfg.emoji}</div>
          <div class="impact-info">
            <div class="impact-label">${cfg.label}</div>
            <div class="impact-bar-wrap"><div class="impact-bar" style="width:${barPct}%"></div></div>
          </div>
          <div class="impact-count">${c.at}/${c.total}</div>
        </div>`;
    }).join('');

  el.innerHTML = rows || '<div class="impact-empty">Sin infraestructura en esta área</div>';
}

// ── UI HELPERS ────────────────────────────────────────────────────────────────

function showControls(show) {
  ['levelSection', 'sliderSection', 'impactSection'].forEach(id => {
    document.getElementById(id).style.display = show ? '' : 'none';
  });
  document.getElementById('legend').style.display = show ? '' : 'none';
}

function clearAll() {
  [riversLayer, bufferLayer, infraLayer].forEach(l => { if (l) map.removeLayer(l); });
  riversLayer = bufferLayer = infraLayer = null;
  riversGeoJSON = null;
  infraFeatures = [];
  namesMap.clear();
  selectedRiverId = null;
  activeGeoJSON   = null;
  bufferedPolygon = null;

  document.getElementById('riverSection').style.display = 'none';
  document.getElementById('riverList').innerHTML = '';
  showControls(false);
  setStatus('Selecciona región, provincia y comuna para comenzar', '');
}

function setStatus(msg, type) {
  const el = document.getElementById('poiStatus');
  el.textContent = msg;
  el.className   = 'poi-status ' + (type || '');
}

// ── LEVEL BUTTONS ─────────────────────────────────────────────────────────────

document.querySelectorAll('.lvl-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.lvl-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const cfg = LEVELS[btn.dataset.level];
    document.getElementById('bufferSlider').value     = cfg.buffer;
    document.getElementById('levelLabel').textContent = cfg.label;
    document.getElementById('levelLabel').className   = `level-label-badge level-${btn.dataset.level}`;
    updateBuffer(cfg.buffer);
  });
});

let bufferTimer = null;
document.getElementById('bufferSlider').addEventListener('input', e => {
  const val = +e.target.value;
  document.getElementById('sliderVal').textContent     = val;
  document.getElementById('bufferDisplay').textContent = val + ' m';
  clearTimeout(bufferTimer);
  bufferTimer = setTimeout(() => updateBuffer(val), 350);
});

document.getElementById('toggleSidebar').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('active');
});

// ── INIT ──────────────────────────────────────────────────────────────────────

loadAdminData();
