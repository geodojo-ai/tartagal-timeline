(() => {
  const data = window.VISOR_DATA;
  const years = data.years;
  const yearByValue = new Map(years.map(y => [String(y.year), y]));

  // ---------- Tracking GA4 ----------
  // Eventos enviados a la misma property que www.geodojo.ai (G-Q0C1DLZ52Q).
  // Cada evento lleva app_name=tartagal-timeline para filtrar fácil.
  const track = (name, params = {}) =>
    window.gtag && gtag('event', name, { app_name: 'tartagal-timeline', ...params });
  let swipeTracked = false; // solo el primer drag por sesión

  // Bbox AOI [lon_min, lat_min, lon_max, lat_max] → Leaflet [[s,w],[n,e]]
  const [lonMin, latMin, lonMax, latMax] = data.aoi_bbox;
  const aoiBounds = [[latMin, lonMin], [latMax, lonMax]];
  const [sLonMin, sLatMin, sLonMax, sLatMax] = data.sismica_bbox;
  const sismicaBounds = [[sLatMin, sLonMin], [sLatMax, sLonMax]];

  const map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
    minZoom: 9,
    maxZoom: 16,
    maxBounds: [[latMin - 0.3, lonMin - 0.3], [latMax + 0.3, lonMax + 0.3]],
    zoomAnimation: false, // evita parpadeo del swipe durante zoom
  });
  map.fitBounds(aoiBounds);

  // Panes con z-index explícitos para garantizar el stacking:
  // OSM (200) < base (401) < compare (402) < source (403) < líneas (404)
  map.createPane('p-base').style.zIndex = 401;
  map.createPane('p-compare').style.zIndex = 402;
  map.createPane('p-source').style.zIndex = 403;
  map.createPane('p-lines').style.zIndex = 404;

  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    opacity: 0.55,
    maxZoom: 19,
  });

  // ---------- Capas Landsat ----------
  // Mantenemos siempre dos imageOverlays activos: base abajo, compare arriba.
  // El compare se clipa via CSS para revelar el base.
  const cache = new Map();
  function getLayer(year, role) {
    const key = `${role}-${year}`;
    if (cache.has(key)) return cache.get(key);
    const meta = yearByValue.get(String(year));
    const layer = L.imageOverlay(meta.image, aoiBounds, {
      opacity: 1,
      interactive: false,
      pane: role === 'compare' ? 'p-compare' : 'p-base',
      className: role === 'compare' ? 'layer-compare' : 'layer-base',
    });
    cache.set(key, layer);
    return layer;
  }

  let baseLayer = null;
  let compareLayer = null;

  function setBase(year) {
    const next = getLayer(year, 'base');
    next.addTo(map);
    if (baseLayer && baseLayer !== next) map.removeLayer(baseLayer);
    baseLayer = next;
    updateMeta('base', year);
    document.getElementById('badge-left').textContent = year;
  }

  function setCompare(year) {
    const next = getLayer(year, 'compare');
    next.addTo(map);
    if (compareLayer && compareLayer !== next) map.removeLayer(compareLayer);
    compareLayer = next;
    updateMeta('compare', year);
    document.getElementById('badge-right').textContent = year;
    // El <img> nuevo no tiene el clip aún; reaplicar tras el render.
    requestAnimationFrame(applyClip);
  }

  function updateMeta(role, year) {
    const m = yearByValue.get(String(year));
    document.getElementById(`${role}-meta`).textContent =
      `${m.satellite} · ${m.date} · nubes ${m.cloud_cover.toFixed(1)}%`;
  }

  // ---------- Sísmica overlays ----------
  const sismica = L.imageOverlay('sismica.png', sismicaBounds, {
    opacity: 0.85,
    interactive: false,
    pane: 'p-lines',
  }).addTo(map);

  const sismicaSource = L.imageOverlay('sismica_original.jpg', sismicaBounds, {
    opacity: 0.9,
    interactive: false,
    pane: 'p-source',
  });

  // ---------- Selectores de año ----------
  const baseSel = document.getElementById('base');
  const compareSel = document.getElementById('compare');
  for (const y of years) {
    const optA = document.createElement('option'); optA.value = y.year; optA.textContent = y.year;
    const optB = optA.cloneNode(true);
    baseSel.appendChild(optA);
    compareSel.appendChild(optB);
  }
  baseSel.value = years[0].year;
  compareSel.value = years[years.length - 1].year;
  setBase(baseSel.value);
  setCompare(compareSel.value);

  baseSel.addEventListener('change', e => {
    setBase(e.target.value);
    track('year_change', { role: 'base', year: parseInt(e.target.value, 10) });
  });
  compareSel.addEventListener('change', e => {
    setCompare(e.target.value);
    track('year_change', { role: 'compare', year: parseInt(e.target.value, 10) });
  });

  // ---------- Curtain swipe ----------
  const mapEl = document.getElementById('map');
  const line = document.getElementById('swipe-line');
  const handle = document.getElementById('swipe-handle');

  // Estado: posición del swipe en px relativos al mapEl (no al img, no al %).
  // Esto evita la desalineación cuando el bbox no llena todo el viewport.
  let swipePx = null; // null = usar centro al primer paint

  function applyClip() {
    if (!compareLayer) return;
    const img = compareLayer.getElement();
    if (!img) return;
    const mapRect = mapEl.getBoundingClientRect();
    if (swipePx === null) swipePx = mapRect.width / 2;
    const lineX = mapRect.left + swipePx;
    const imgRect = img.getBoundingClientRect();
    // Clipamos el lado IZQUIERDO del compare hasta donde está la línea:
    // así el lado izq deja ver el base, y el der el compare (orden cronológico
    // intuitivo y consistente con los badges 1984 ← | → 2024).
    const fromLeft = lineX - imgRect.left;
    const leftClip = Math.max(0, Math.min(imgRect.width, fromLeft));
    img.style.clipPath = `inset(0 0 0 ${leftClip}px)`;
    img.style.webkitClipPath = `inset(0 0 0 ${leftClip}px)`;
    line.style.left = `${swipePx}px`;
  }

  function setSwipePx(px) {
    const w = mapEl.getBoundingClientRect().width;
    swipePx = Math.max(0, Math.min(w, px));
    applyClip();
  }

  // Re-aplicar el clip cada vez que el map se mueve/zooma o se cambia el año.
  map.on('move zoom resize viewreset', applyClip);
  window.addEventListener('resize', applyClip);

  let dragging = false;
  function onPointerMove(e) {
    if (!dragging) return;
    const rect = mapEl.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    setSwipePx(x);
  }
  function startDrag(e) {
    dragging = true;
    e.preventDefault();
    if (!swipeTracked) { track('swipe_used'); swipeTracked = true; }
  }
  function endDrag() { dragging = false; }
  handle.addEventListener('mousedown', startDrag);
  handle.addEventListener('touchstart', startDrag, { passive: false });
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('mouseup', endDrag);
  window.addEventListener('touchend', endDrag);

  // Click en el mapa fuera del handle también mueve la cortina (UX común).
  mapEl.addEventListener('click', e => {
    if (e.target.closest('#swipe-handle, .panel, .leaflet-control, .year-badge')) return;
    const rect = mapEl.getBoundingClientRect();
    setSwipePx(e.clientX - rect.left);
  });

  // Aplicar clip apenas Leaflet termina de pintar la primera capa.
  setTimeout(applyClip, 50);

  // ---------- Opacidad sísmica ----------
  const opInput = document.getElementById('opacity');
  const opLabel = document.getElementById('opacity-label');
  opInput.addEventListener('input', e => {
    sismica.setOpacity(parseInt(e.target.value, 10) / 100);
    opLabel.textContent = `${e.target.value}%`;
  });

  // ---------- Mapa base (ON por default) ----------
  osm.addTo(map);
  document.getElementById('basemap').addEventListener('change', e => {
    if (e.target.checked) osm.addTo(map);
    else map.removeLayer(osm);
  });

  // ---------- Toggle fuente original ----------
  document.getElementById('show-source').addEventListener('change', e => {
    if (e.target.checked) {
      sismicaSource.addTo(map);
      track('source_toggled', { state: 'on' });
    } else {
      map.removeLayer(sismicaSource);
    }
  });

  // ---------- Animación: avanza el año compare desde base+1 hasta el final ----------
  const playBtn = document.getElementById('play');
  let playing = null;
  playBtn.addEventListener('click', () => {
    if (playing) {
      clearInterval(playing); playing = null;
      playBtn.textContent = '▶ Animar comparación';
      playBtn.classList.remove('playing');
      return;
    }
    const baseIdx = years.findIndex(y => String(y.year) === baseSel.value);
    let i = Math.max(baseIdx + 1, 0);
    playBtn.textContent = '■ Detener';
    playBtn.classList.add('playing');
    track('play_started', { from_year: parseInt(baseSel.value, 10) });
    playing = setInterval(() => {
      if (i >= years.length) {
        clearInterval(playing); playing = null;
        playBtn.textContent = '▶ Animar comparación';
        playBtn.classList.remove('playing');
        return;
      }
      const y = years[i].year;
      compareSel.value = y;
      setCompare(y);
      i++;
    }, 700);
  });

  // ---------- Atajos de teclado ----------
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === ' ') { playBtn.click(); e.preventDefault(); }
  });

  // ---------- Alert bar (persistent dismiss) ----------
  const ALERT_KEY = 'tartagal-alert-dismissed-v1';
  const alertBar = document.getElementById('alert-bar');
  if (!localStorage.getItem(ALERT_KEY)) {
    alertBar.hidden = false;
  }
  document.getElementById('alert-dismiss').addEventListener('click', () => {
    alertBar.hidden = true;
    try { localStorage.setItem(ALERT_KEY, '1'); } catch (e) {}
    track('alert_dismissed');
  });

  // ---------- Tracking outbound clicks ----------
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="http"]');
    if (!a) return;
    const url = new URL(a.href);
    if (url.hostname.includes('geodojo.ai')) {
      track('click_geodojo', { utm_content: url.searchParams.get('utm_content') || 'unknown' });
    } else if (url.hostname.includes('lanacion.com.ar')) {
      track('click_source', { source: 'lanacion' });
    } else if (url.hostname.includes('opsur.org')) {
      track('click_source', { source: 'opsur' });
    }
  });
})();
