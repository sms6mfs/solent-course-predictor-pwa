const $ = id => document.getElementById(id);
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
let marks = Array.isArray(window.EXCEL_MARKS) ? [...window.EXCEL_MARKS] : [];
let polar = window.EXCEL_POLAR;
if(polar && !polar.sourceFormat) polar.sourceFormat = 'Preloaded Cape31 polar';
let course = [];
let customStart = {id:'custom_start', name:'Custom Start', lat: NaN, lon: NaN, custom:true};
let customFinish = {id:'custom_finish', name:'Custom Finish', lat: NaN, lon: NaN, custom:true};
let pickMode = null;
let map, markLayer, courseLayer, vectorLayer, customLayer;

function norm360(d){ return ((d % 360) + 360) % 360; }
function norm180(d){ const x = norm360(d + 180) - 180; return x === -180 ? 180 : x; }
function toRad(d){ return d * RAD; }
function fmtTime(sec){
  if(!isFinite(sec) || sec < 0) return "—";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = v => String(v).padStart(2,'0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function windToDir(twdFromDeg){ return norm360(twdFromDeg + 180); }
function currentToVector(setToDeg, driftKt){ return vecFrom(setToDeg, driftKt); }
function fmt(n, dp=2){ return isFinite(n) ? Number(n).toFixed(dp) : "—"; }

function validPoint(m){ return m && isFinite(m.lat) && isFinite(m.lon); }
function setPickHint(text){ const el=$('pickHint'); if(el) el.textContent = text; }
function refreshPickButtons(){
  ['pickStart','pickFinish'].forEach(id => $(id)?.classList.remove('pick-active'));
  if(pickMode === 'start') $('pickStart')?.classList.add('pick-active');
  if(pickMode === 'finish') $('pickFinish')?.classList.add('pick-active');
}
function readCustomPoints(){
  const slat = Number($('startLat')?.value), slon = Number($('startLon')?.value);
  const flat = Number($('finishLat')?.value), flon = Number($('finishLon')?.value);
  customStart.lat = Number.isFinite(slat) ? slat : NaN;
  customStart.lon = Number.isFinite(slon) ? slon : NaN;
  customFinish.lat = Number.isFinite(flat) ? flat : NaN;
  customFinish.lon = Number.isFinite(flon) ? flon : NaN;
}
function setCustomPoint(which, lat, lon){
  const latEl = which === 'start' ? $('startLat') : $('finishLat');
  const lonEl = which === 'start' ? $('startLon') : $('finishLon');
  latEl.value = Number(lat).toFixed(6);
  lonEl.value = Number(lon).toFixed(6);
  readCustomPoints();
}
function insertCustomStart(){
  readCustomPoints();
  if(!validPoint(customStart)) return alert('Enter a valid start latitude and longitude, or pick the start on the chart.');
  course = course.filter(m => m.id !== customStart.id);
  course.unshift(customStart);
  updateAll();
}
function insertCustomFinish(){
  readCustomPoints();
  if(!validPoint(customFinish)) return alert('Enter a valid finish latitude and longitude, or pick the finish on the chart.');
  course = course.filter(m => m.id !== customFinish.id);
  course.push(customFinish);
  updateAll();
}

function distanceNm(a,b){
  const R = 3440.065;
  const p1 = toRad(a.lat), p2 = toRad(b.lat), dp = toRad(b.lat-a.lat), dl = toRad(b.lon-a.lon);
  const h = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
}
function bearingDeg(a,b){
  const p1=toRad(a.lat), p2=toRad(b.lat), dl=toRad(b.lon-a.lon);
  const y=Math.sin(dl)*Math.cos(p2);
  const x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return norm360(Math.atan2(y,x)*DEG);
}
function vecFrom(dirDeg, speed){ return {x: speed*Math.sin(toRad(dirDeg)), y: speed*Math.cos(toRad(dirDeg))}; }
function vecProject(v, dirDeg){ const u=vecFrom(dirDeg,1); return v.x*u.x + v.y*u.y; }
function vecCross(v, dirDeg){ const u=vecFrom(dirDeg,1); return v.x*u.y - v.y*u.x; }
function addVec(a,b){ return {x:a.x+b.x, y:a.y+b.y}; }
function vectorToDir(v){ return norm360(Math.atan2(v.x, v.y)*DEG); }

function readInputs(){
  return {
    twd: Number($('twd').value), tws: Number($('tws').value), set: Number($('set').value), drift: Number($('drift').value),
    usePolar: $('usePolar').value === 'Yes', upTwa: Number($('upTwa').value), reachTwa: Number($('reachTwa').value), dnTwa: Number($('dnTwa').value),
    upBsp: Number($('upBsp').value), reachBsp: Number($('reachBsp').value), dnBsp: Number($('dnBsp').value),
    polarFactor: Number(($('polarFactorPct')?.value || 100)) / 100, magVar: Number($('magVar').value || 0)
  };
}

function interp1(points, x){
  // points: sorted [{x, y}], x clamped to available range. Returns NaN if no usable points.
  const pts = points
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a,b)=>a.x-b.x);
  if(!pts.length) return NaN;
  if(pts.length === 1) return pts[0].y;
  if(x <= pts[0].x) return pts[0].y;
  if(x >= pts[pts.length-1].x) return pts[pts.length-1].y;
  let hi = pts.findIndex(p => p.x >= x);
  if(hi <= 0) return pts[0].y;
  const lo = hi - 1;
  const x0 = pts[lo].x, x1 = pts[hi].x;
  const y0 = pts[lo].y, y1 = pts[hi].y;
  const t = (x - x0) / (x1 - x0 || 1);
  return y0 + (y1 - y0) * t;
}
function polarSpeed(tws, twaAbs){
  if(!polar || !polar.rows?.length || !polar.twa?.length) return NaN;
  const twa = Math.abs(Number(twaAbs));
  const wind = Number(tws);
  if(!Number.isFinite(twa) || !Number.isFinite(wind)) return NaN;

  // Robust sparse-polar interpolation:
  // 1) interpolate speed versus TWA inside each TWS row using only valid cells
  // 2) interpolate those row results versus TWS.
  // This is needed for Expedition .txt files where each wind-speed row has its own
  // best-upwind/downwind TWA columns, creating a sparse union table.
  const rowPoints = polar.rows.map(row => {
    const anglePoints = polar.twa.map((angle, i) => ({x: angle, y: row.values?.[i]}));
    const bspAtTwa = interp1(anglePoints, twa);
    return {x: Number(row.tws), y: bspAtTwa};
  }).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));

  return interp1(rowPoints, wind);
}

function legMode(absAngleToWindFrom){
  // TWD is the direction the wind comes FROM.
  // A course bearing close to TWD is upwind; close to TWD+180 is downwind.
  if(absAngleToWindFrom < 60) return 'upwind';
  if(absAngleToWindFrom > 120) return 'downwind';
  return 'reach';
}
function targetSpeed(inputs, twaAbs, manualBsp){
  const polarBsp = inputs.usePolar ? polarSpeed(inputs.tws, twaAbs) : NaN;
  const baseBsp = Number.isFinite(polarBsp) && polarBsp > 0 ? polarBsp : manualBsp;
  return baseBsp * inputs.polarFactor;
}
function targetFor(mode, inputs, twaDirect){
  const directTwa = Math.abs(twaDirect);
  if(mode === 'upwind') return {twa: inputs.upTwa, bsp: targetSpeed(inputs, inputs.upTwa, inputs.upBsp)};
  if(mode === 'downwind') return {twa: inputs.dnTwa, bsp: targetSpeed(inputs, inputs.dnTwa, inputs.dnBsp)};
  const displayTwa = inputs.usePolar ? directTwa : inputs.reachTwa;
  return {twa: displayTwa, bsp: targetSpeed(inputs, inputs.usePolar ? directTwa : inputs.reachTwa, inputs.reachBsp)};
}
function tackHeadings(mode, twdFrom, targetTwa){
  // TWA is measured from the wind-FROM direction to the boat heading.
  // Upwind headings are centred on TWD. Downwind headings are centred on TWD+180,
  // which is equivalent to TWD +/- a large downwind TWA.
  if(mode === 'upwind') {
    return {port: norm360(twdFrom - targetTwa), stbd: norm360(twdFrom + targetTwa)};
  }
  return {port: norm360(twdFrom - targetTwa), stbd: norm360(twdFrom + targetTwa)};
}
function solveTwoBoardLeg(distNm, bearing, mode, target, inputs){
  const current = currentToVector(inputs.set, inputs.drift);
  const hdg = tackHeadings(mode, inputs.twd, target.twa);
  const vp = addVec(vecFrom(hdg.port, target.bsp), current);
  const vs = addVec(vecFrom(hdg.stbd, target.bsp), current);
  const ap = vecProject(vp, bearing), as = vecProject(vs, bearing);
  const xp = vecCross(vp, bearing), xs = vecCross(vs, bearing);
  const denom = (ap*xs - as*xp);
  let tp=NaN, ts=NaN;
  if(Math.abs(denom) > 1e-9){
    tp = distNm * xs / denom;
    ts = -distNm * xp / denom;
  }
  if(!isFinite(tp) || !isFinite(ts) || tp < -1e-6 || ts < -1e-6){
    const best = ap > as ? {which:'port', along:ap} : {which:'stbd', along:as};
    tp = best.which === 'port' ? distNm / Math.max(best.along, .01) : 0;
    ts = best.which === 'stbd' ? distNm / Math.max(best.along, .01) : 0;
  }
  return {portHours: Math.max(0,tp), stbdHours: Math.max(0,ts), totalHours: Math.max(0,tp)+Math.max(0,ts), headings: hdg, cts: `${fmt(hdg.port,0)} / ${fmt(hdg.stbd,0)}`};
}
function solveReachLeg(distNm, bearing, target, inputs){
  const current = currentToVector(inputs.set, inputs.drift);
  const boat = vecFrom(bearing, target.bsp);
  const ground = addVec(boat, current);
  const along = vecProject(ground, bearing);
  const totalHours = distNm / Math.max(along,.01);

  // For a direct reaching leg there is no split, but the leg is still sailed
  // on one tack. Match tackHeadings(): positive signed TWA = starboard,
  // negative signed TWA = port.
  const signedTwa = norm180(bearing - inputs.twd);
  const portHours = signedTwa < 0 ? totalHours : 0;
  const stbdHours = signedTwa >= 0 ? totalHours : 0;

  return {portHours, stbdHours, totalHours, headings:{direct:bearing}, cts: fmt(bearing,0)};
}
function predict(){
  readCustomPoints();
  const inputs = readInputs();
  const results = [];
  for(let i=0;i<course.length-1;i++){
    const from=course[i], to=course[i+1];
    const dist=distanceNm(from,to), brg=bearingDeg(from,to);
    const signed = norm180(brg - inputs.twd); // signed TWA if boat could sail directly on the leg; TWD is wind FROM
    const abs = Math.abs(signed);
    const mode = legMode(abs);
    const target = targetFor(mode, inputs, signed);
    const sol = mode === 'reach' ? solveReachLeg(dist, brg, target, inputs) : solveTwoBoardLeg(dist, brg, mode, target, inputs);
    results.push({from,to,dist,brg,signed,abs,mode,target,...sol});
  }
  return results;
}

function populateMarks(){
  $('markSelect').innerHTML = marks.map((m,i)=>`<option value="${i}">${m.name}</option>`).join('');
}
function renderCourseList(){
  $('courseList').innerHTML = course.map((m,i)=>`<li>${i+1}. ${m.name}${m.custom ? ` <span class="muted">(${fmt(m.lat,5)}, ${fmt(m.lon,5)})</span>` : ''} <button class="secondary" data-remove="${i}">×</button></li>`).join('');
  document.querySelectorAll('[data-remove]').forEach(btn => btn.onclick = e => { course.splice(Number(btn.dataset.remove),1); updateAll(); });
}
function renderTable(results){
  const body = $('legsTable').querySelector('tbody');
  body.innerHTML = results.map(r => `<tr>
    <td>${r.from.name} → ${r.to.name}</td><td>${fmt(r.dist,2)} nm</td><td>${fmt(r.brg,0)}</td>
    <td class="mode-${r.mode}">${r.mode}</td><td>${fmt(r.target.twa,0)}° / ${fmt(r.target.bsp,2)} kn</td>
    <td class="port-time">${fmtTime(r.portHours*3600)}</td><td class="stbd-time">${fmtTime(r.stbdHours*3600)}</td><td><b>${fmtTime(r.totalHours*3600)}</b></td><td>${r.cts}</td>
  </tr>`).join('');
  const nm = results.reduce((s,r)=>s+r.dist,0), h=results.reduce((s,r)=>s+r.totalHours,0);
  const inputs = readInputs();
  const fallback = inputs.usePolar && results.some(r => !Number.isFinite(polarSpeed(inputs.tws, r.target.twa)));
  $('summary').innerHTML = `<div class="kpi"><b>${fmt(nm,2)} nm</b><span>Course distance</span></div><div class="kpi"><b>${fmtTime(h*3600)}</b><span>Predicted elapsed</span></div><div class="kpi"><b>${results.length}</b><span>Legs</span></div><div class="kpi"><b>${fmt(nm/Math.max(h,.001),2)} kn</b><span>Course VMG/SOG</span></div>${fallback ? '<div class="kpi warn"><b>Polar fallback</b><span>Manual BSP used where polar lookup was invalid</span></div>' : ''}`;
}
function renderMap(results=[]){
  if(!map){
    map = L.map('map', {preferCanvas:true});
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 18, attribution: '&copy; OpenStreetMap'}).addTo(map);
    L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {attribution: 'Map data: © OpenSeaMap contributors'}).addTo(map);
    markLayer=L.layerGroup().addTo(map); courseLayer=L.layerGroup().addTo(map); vectorLayer=L.layerGroup().addTo(map); customLayer=L.layerGroup().addTo(map);
    map.on('click', e => {
      if(!pickMode) return;
      setCustomPoint(pickMode, e.latlng.lat, e.latlng.lng);
      setPickHint(`${pickMode === 'start' ? 'Start' : pickMode === 'finish' ? 'Finish' : 'Picked point'} set from chart: ${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`);
      pickMode = null; refreshPickButtons(); map.getContainer().classList.remove('crosshair'); updateAll();
    });
  }
  markLayer.clearLayers(); courseLayer.clearLayers(); vectorLayer.clearLayers(); customLayer.clearLayers();
  readCustomPoints();
  marks.forEach(m => {
    const marker = L.circleMarker([m.lat,m.lon],{radius:5,weight:1,fillOpacity:.75})
      .bindTooltip(m.name)
      .on('click', e => {
        if(e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
        if(pickMode){
          setCustomPoint(pickMode, m.lat, m.lon);
          setPickHint(`${pickMode === 'start' ? 'Start' : pickMode === 'finish' ? 'Finish' : 'Picked point'} set from mark: ${m.name} (${m.lat.toFixed(6)}, ${m.lon.toFixed(6)})`);
          pickMode = null;
          refreshPickButtons();
          map.getContainer().classList.remove('crosshair');
        } else {
          course.push(m);
          setPickHint(`Added ${m.name} to course from chart. Click more marks, or use Clear to restart.`);
        }
        updateAll();
      });
    marker.addTo(markLayer);
  });
  if(validPoint(customStart)) L.marker([customStart.lat,customStart.lon],{title:'Custom Start'}).bindTooltip('Custom Start').addTo(customLayer);
  if(validPoint(customFinish)) L.marker([customFinish.lat,customFinish.lon],{title:'Custom Finish'}).bindTooltip('Custom Finish').addTo(customLayer);
  if(course.length){
    const latlngs=course.map(m=>[m.lat,m.lon]);
    L.polyline(latlngs,{weight:4}).addTo(courseLayer);
    course.forEach((m,i)=>L.marker([m.lat,m.lon]).bindTooltip(`${i+1}. ${m.name}`,{permanent:false}).addTo(courseLayer));
    map.fitBounds(L.latLngBounds(latlngs).pad(.18));
  } else if(marks.length) {
    map.fitBounds(L.latLngBounds(marks.map(m=>[m.lat,m.lon])).pad(.1));
  }
}

function polarCell(row, colIdx){
  const v = row?.values?.[colIdx];
  return Number.isFinite(Number(v)) ? Number(v) : NaN;
}
function renderPolarMeta(){
  const el = $('polarMeta');
  if(!el) return;
  if(!polar || !polar.rows?.length || !polar.twa?.length){ el.textContent = 'No polar loaded'; return; }
  const twsVals = polar.rows.map(r=>Number(r.tws)).filter(Number.isFinite);
  const twaVals = polar.twa.map(Number).filter(Number.isFinite);
  const validCells = polar.rows.reduce((n,r)=>n + (r.values||[]).filter(v=>Number.isFinite(Number(v))).length, 0);
  const totalCells = polar.rows.length * polar.twa.length;
  const debugBits = polar.debug?.filename ? ` · file: ${polar.debug.filename}` : '';
  el.textContent = `${polar.sourceFormat || 'Polar'}${debugBits} · ${polar.rows.length} TWS rows (${fmt(Math.min(...twsVals),0)}–${fmt(Math.max(...twsVals),0)} kn) · ${polar.twa.length} TWA columns (${fmt(Math.min(...twaVals),0)}–${fmt(Math.max(...twaVals),0)}°) · ${validCells}/${totalCells} populated cells`;
}
function renderPolarTable(){
  const table = $('polarTable');
  if(!table) return;
  const thead = table.querySelector('thead'), tbody = table.querySelector('tbody');
  if(!polar || !polar.rows?.length || !polar.twa?.length){
    thead.innerHTML = ''; tbody.innerHTML = '<tr><td>No polar loaded</td></tr>'; return;
  }
  thead.innerHTML = `<tr><th>TWS \\ TWA</th>${polar.twa.map(a=>`<th>${fmt(a,0)}°</th>`).join('')}</tr>`;
  tbody.innerHTML = polar.rows.map(row => `<tr><th>${fmt(row.tws,1)} kn</th>${polar.twa.map((a,i)=>{
    const v = polarCell(row,i);
    return Number.isFinite(v) ? `<td>${fmt(v,2)}</td>` : '<td class="empty">—</td>';
  }).join('')}</tr>`).join('');
}
function drawPolarCurve(ctx, cx, cy, scale, points, stroke, label){
  const drawSide = (sign) => {
    ctx.beginPath();
    let started = false;
    for(const p of points){
      if(!Number.isFinite(p.twa) || !Number.isFinite(p.bsp)) continue;
      const theta = sign * p.twa * RAD;
      const r = p.bsp * scale;
      const x = cx + Math.sin(theta) * r;
      const y = cy - Math.cos(theta) * r;
      if(!started){ ctx.moveTo(x,y); started = true; } else ctx.lineTo(x,y);
    }
    if(started){ ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
  };
  drawSide(1); drawSide(-1);
}
function renderPolarDiagram(){
  const canvas = $('polarCanvas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = '#07101a'; ctx.fillRect(0,0,w,h);
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if(!polar || !polar.rows?.length || !polar.twa?.length){
    ctx.fillStyle = '#90a0b4'; ctx.fillText('No polar loaded', w/2, h/2); return;
  }
  // Full 0–180° TWA polar plot.
  // Earlier builds placed the plot centre near the bottom and drew only the upper semicircle,
  // which made the visible diagram appear to stop around 90° TWA.  A true TWA polar
  // needs room below the origin because 180° is directly downwind.
  const cx = w/2, cy = h*0.52;
  const allBsp = polar.rows.flatMap(r => (r.values||[]).map(Number).filter(Number.isFinite));
  const maxBsp = Math.max(1, ...allBsp);
  const radius = Math.min(w*0.43, h*0.40);
  const scale = radius / maxBsp;
  ctx.strokeStyle = '#26364a'; ctx.lineWidth = 1;
  const ringStep = maxBsp <= 8 ? 1 : maxBsp <= 16 ? 2 : 5;
  for(let sp=ringStep; sp<=maxBsp+0.0001; sp+=ringStep){
    ctx.beginPath(); ctx.arc(cx, cy, sp*scale, 0, Math.PI*2); ctx.stroke();
    ctx.fillStyle = '#90a0b4'; ctx.textAlign='left'; ctx.fillText(`${sp} kn`, cx + 4, cy - sp*scale);
  }
  for(const deg of [-180,-150,-120,-90,-60,-30,0,30,60,90,120,150,180]){
    const theta = deg * RAD;
    const x = cx + Math.sin(theta) * radius;
    const y = cy - Math.cos(theta) * radius;
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(x,y); ctx.stroke();
    ctx.fillStyle = '#90a0b4'; ctx.textAlign='center';
    const label = Math.abs(deg).toString() + '°';
    const lx = cx + Math.sin(theta)*(radius+18);
    const ly = cy - Math.cos(theta)*(radius+18);
    ctx.fillText(label, lx, ly);
  }
  ctx.fillStyle = '#eaf0f8'; ctx.font = '13px system-ui, sans-serif';
  ctx.fillText('TWA 0° / upwind', cx, cy-radius-34);
  ctx.fillText('TWA 180° / downwind', cx, cy+radius+28);
  const palette = ['#62d2ff','#8cffb3','#ffca66','#ff8c8c','#c7a0ff','#7ad7c7','#f0f48d','#9cb7ff','#ff9ed8','#b9f1ff','#d5ffb8','#ffd0a6'];
  const rows = polar.rows.slice().sort((a,b)=>Number(a.tws)-Number(b.tws));
  rows.forEach((row, idx) => {
    const points = polar.twa.map((a,i)=>({twa:Number(a), bsp:polarCell(row,i)})).filter(p=>Number.isFinite(p.bsp));
    drawPolarCurve(ctx,cx,cy,scale,points,palette[idx % palette.length]);
  });
  // Legend
  ctx.font = '12px system-ui, sans-serif'; ctx.textAlign='left'; ctx.textBaseline='middle';
  const lx = 16, ly = 18, rowH = 18;
  rows.forEach((row, idx) => {
    const y = ly + idx*rowH;
    if(y > h-12) return;
    ctx.strokeStyle = palette[idx % palette.length]; ctx.lineWidth=3;
    ctx.beginPath(); ctx.moveTo(lx,y); ctx.lineTo(lx+22,y); ctx.stroke();
    ctx.fillStyle = '#d8e3f0'; ctx.fillText(`${fmt(row.tws,1)} kn TWS`, lx+30, y);
  });
}
function renderPolarView(){ renderPolarMeta(); renderPolarTable(); renderPolarDiagram(); }
function setPolarTab(which){
  const diagram = which === 'diagram';
  $('polarDiagramPanel').hidden = !diagram;
  $('polarTablePanel').hidden = diagram;
  $('polarDiagramTab').classList.toggle('active-tab', diagram);
  $('polarTableTab').classList.toggle('active-tab', !diagram);
  if(diagram) renderPolarDiagram();
}

function updateAll(){ renderCourseList(); const r=predict(); renderTable(r); renderMap(r); renderPolarView(); }

function parseGpx(text){
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const pts = [...doc.querySelectorAll('wpt,rtept')].map((el,i)=>({
    id:`gpx_${i}`, name: el.querySelector('name')?.textContent?.trim() || `Mark ${i+1}`,
    lat:Number(el.getAttribute('lat')), lon:Number(el.getAttribute('lon'))
  })).filter(m=>isFinite(m.lat)&&isFinite(m.lon));
  return pts;
}
function splitPolarLine(line){
  return line.trim().split(/[;,\t ]+/).map(x=>x.trim()).filter(Boolean);
}
function numToken(v){
  if(v == null) return NaN;
  const cleaned = String(v).trim().replace(/^[\"']|[\"']$/g,'').replace(',', '.');
  if(!cleaned || /^[-–—]+$/.test(cleaned)) return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}
function cleanPolarText(text){
  return text.replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\u00a0/g, ' ').trim())
    .filter(l => l && !/^(!|#|\/\/)/.test(l));
}
function makePolar(twa, rows){
  // Normalise the polar into the app's internal shape:
  // columns are sorted TWA values, rows are sorted TWS values, and row values are reordered to match.
  const indexedTwa = twa
    .map((v, idx) => ({v: Number(v), idx}))
    .filter(o => Number.isFinite(o.v))
    .sort((a,b) => a.v - b.v);
  const cleanTwa = indexedTwa.map(o => o.v);
  const cleanRows = rows
    .filter(r => Number.isFinite(Number(r.tws)) && Array.isArray(r.values))
    .map(r => ({
      tws: Number(r.tws),
      values: indexedTwa.map(o => {
        const raw = r.values[o.idx];
        if(raw == null || raw === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      })
    }))
    .filter(r => r.values.some(v => v != null))
    .sort((a,b)=>a.tws-b.tws);
  return {twa: cleanTwa, rows: cleanRows};
}
function transposePolar(input){
  const tws = input.twa;
  const twa = input.rows.map(r => r.tws);
  const rows = tws.map((ws, colIdx) => ({
    tws: ws,
    values: input.rows.map(r => r.values[colIdx] ?? null)
  }));
  return makePolar(twa, rows);
}
function parseMatrixPolar(lines){
  const tokenRows = lines.map(splitPolarLine).filter(r => r.length >= 2);
  if(!tokenRows.length) throw new Error('No polar table found');
  const headerIdx = tokenRows.findIndex(r => /twa|tws|windspeed|wind|angle|deg/i.test(r[0]) && r.slice(1).some(v => Number.isFinite(numToken(v))));
  const start = headerIdx >= 0 ? headerIdx : 0;
  const header = tokenRows[start];
  const cols = header.slice(1).map(numToken).filter(Number.isFinite);
  const rows = tokenRows.slice(start+1).map(r => ({
    tws: numToken(r[0]),
    values: r.slice(1, cols.length+1).map(numToken).map(v => Number.isFinite(v) ? v : null)
  })).filter(r => Number.isFinite(r.tws) && r.values.some(v => v != null));
  if(cols.length < 2 || rows.length < 2) throw new Error('Polar matrix needs at least two wind speeds and two angle rows');

  // Common MaxSea / Adrena / SailGrib / ORC-style layout: first column is TWA, header row is TWS.
  // The internal app format is rows=TWS and columns=TWA, so transpose it when header max looks like wind speed.
  const looksHeaderIsTws = Math.max(...cols) <= 80 && Math.max(...rows.map(r=>r.tws)) > 80;
  const matrix = makePolar(cols, rows);
  return looksHeaderIsTws ? transposePolar(matrix) : matrix;
}
function numericTokensFromLine(line){
  // Expedition .txt files are often whitespace/tab separated, sometimes with odd
  // spacing and comments.  Extract numbers directly rather than relying on one
  // delimiter style.  This also tolerates decimal commas when present.
  const matches = String(line).match(/[-+]?\d+(?:[.,]\d+)?/g) || [];
  return matches.map(numToken).filter(Number.isFinite);
}
function parseExpeditionPairsPolar(lines){
  // Expedition/Deckman text polar:
  // TWS  TWA BSP  TWA BSP  TWA BSP ...
  // Example row: 10  0 0.00  40 8.5  75 10.3 ... 180 5.71
  const rows = [];
  const twaSet = new Set();

  for(const line of lines){
    const nums = numericTokensFromLine(line);
    if(nums.length < 5) continue;

    const tws = nums[0];
    if(!Number.isFinite(tws) || tws <= 0 || tws > 80) continue;

    const points = [];
    for(let i = 1; i < nums.length - 1; i += 2){
      const twa = nums[i];
      const bsp = nums[i + 1];

      // In pair format the angle must be an angle and the speed must look like a boat speed.
      // This rejects accidental matrix/header rows while keeping 0°/0.00 and 180° rows.
      if(Number.isFinite(twa) && Number.isFinite(bsp) &&
         twa >= 0 && twa <= 180 &&
         bsp >= 0 && bsp <= 80){
        points.push({twa, bsp});
        twaSet.add(twa);
      }
    }

    if(points.length >= 2){
      // If a row contains duplicate TWAs, keep the last value.  This is safer
      // than creating duplicate columns in the union table.
      const dedup = new Map();
      points.forEach(p => dedup.set(p.twa, p.bsp));
      rows.push({tws, points: [...dedup.entries()].map(([twa,bsp]) => ({twa, bsp}))});
    }
  }

  if(rows.length < 2 || twaSet.size < 2) {
    throw new Error('No Expedition pair-format polar found');
  }

  const twa = [...twaSet].sort((a,b) => a - b);
  const outRows = rows
    .sort((a,b) => a.tws - b.tws)
    .map(row => {
      const pointMap = new Map(row.points.map(p => [p.twa, p.bsp]));
      return {
        tws: row.tws,
        values: twa.map(a => pointMap.has(a) ? pointMap.get(a) : null)
      };
    });

  const parsed = makePolar(twa, outRows);
  parsed.debug = {
    parser: 'expedition_pairs',
    twsRows: parsed.rows.length,
    twaColumns: parsed.twa.length,
    populatedCells: parsed.rows.reduce((n,r) => n + (r.values || []).filter(v => Number.isFinite(Number(v))).length, 0)
  };
  return parsed;
}
function parseSeapilotFormat2(lines){
  // Format 2: each row starts with TWS, followed by repeating TWA,BSP pairs.
  // This is structurally the same as Expedition pair format, so keep as an alias for clarity.
  return parseExpeditionPairsPolar(lines);
}
function parsePolarFile(text, filename='polar'){
  const rawLines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const hasExpeditionMarker = rawLines.some(l => /^\s*!?\s*expedition\b/i.test(l));
  const lines = cleanPolarText(text);
  if(!lines.length) throw new Error('Polar file is empty');

  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const first = lines[0] || '';
  const matrixHeaderLikely = /^\s*(twa|tws|wind|angle|deg)\b/i.test(first);
  const errors = [];

  const tryParser = (name, fn) => {
    try {
      const p = fn(lines);
      if(p?.twa?.length >= 2 && p?.rows?.length >= 2) {
        return {...p, sourceFormat:name};
      }
    } catch(err) {
      errors.push(`${name}: ${err.message}`);
    }
    return null;
  };

  let parsed = null;

  // .txt with !Expedition polar should always be interpreted as TWS + TWA/BSP pairs.
  // Do this before trying the matrix parser, because the first data row can otherwise
  // be mistaken for a headerless matrix.
  if(hasExpeditionMarker || ext === 'txt') {
    parsed = tryParser('Expedition .txt: TWS + repeated TWA/BSP pairs', parseExpeditionPairsPolar);
  }

  // .pol files from your sample parse correctly as matrix files, so preserve that path.
  if(!parsed && matrixHeaderLikely) {
    parsed = tryParser('Matrix table', parseMatrixPolar);
  }

  if(!parsed && ext === 'pol') {
    parsed = tryParser('Matrix table', parseMatrixPolar);
  }

  if(!parsed) parsed = tryParser('Matrix table', parseMatrixPolar);
  if(!parsed) parsed = tryParser('Expedition .txt: TWS + repeated TWA/BSP pairs', parseExpeditionPairsPolar);

  if(!parsed) {
    throw new Error(`Unsupported polar format. Tried: ${errors.join(' | ')}`);
  }

  // Store a compact debug summary so the Loaded Polar tab can reveal what the app actually loaded.
  const validCells = parsed.rows.reduce((n,r) => n + (r.values || []).filter(v => Number.isFinite(Number(v))).length, 0);
  parsed.debug = {
    ...(parsed.debug || {}),
    filename,
    extension: ext,
    validCells,
    totalCells: parsed.rows.length * parsed.twa.length
  };

  return parsed;
}

$('addMark').onclick = () => { const m = marks[Number($('markSelect').value)]; if(m){ course.push(m); updateAll(); } };
$('addCustomStart') && ($('addCustomStart').onclick = insertCustomStart);
$('addCustomFinish') && ($('addCustomFinish').onclick = insertCustomFinish);
$('pickStart') && ($('pickStart').onclick = () => { pickMode = 'start'; refreshPickButtons(); setPickHint('Click the chart to place the custom start.'); map?.getContainer().classList.add('crosshair'); });
$('pickFinish') && ($('pickFinish').onclick = () => { pickMode = 'finish'; refreshPickButtons(); setPickHint('Click the chart to place the custom finish.'); map?.getContainer().classList.add('crosshair'); });
$('clearCourse').onclick = () => { course=[]; updateAll(); };
$('recalc').onclick = updateAll;
$('polarDiagramTab').onclick = () => setPolarTab('diagram');
$('polarTableTab').onclick = () => setPolarTab('table');
document.querySelectorAll('input,select').forEach(el => el.addEventListener('change', updateAll));
$('gpxFile').onchange = async e => { const f=e.target.files[0]; if(!f) return; marks=parseGpx(await f.text()); course=[]; populateMarks(); updateAll(); };
$('polarFile').onchange = async e => { const f=e.target.files[0]; if(!f) return; try { polar=parsePolarFile(await f.text(), f.name); $('usePolar').value='Yes'; updateAll(); alert(`Loaded polar: ${polar.sourceFormat} (${polar.rows.length} TWS rows × ${polar.twa.length} TWA columns)`); } catch(err) { alert(err.message); } };

let deferredPrompt; window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt=e; $('installBtn').hidden=false; });
$('installBtn').onclick = async () => { if(deferredPrompt){ deferredPrompt.prompt(); deferredPrompt=null; $('installBtn').hidden=true; } };
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});


async function loadDefaultMarksFromGpx(){
  try {
    const response = await fetch('default_marks.gpx', {cache: 'no-store'});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const parsed = parseGpx(text);
    if(parsed && parsed.length){
      marks = parsed;
      course = [];
      populateMarks();
      updateAll();
      setPickHint(`Loaded ${marks.length} marks from default GPX. Click chart marks or use the list to build a course.`);
      return;
    }
    throw new Error('No marks parsed');
  } catch(e) {
    console.warn('Default GPX marks failed to load; falling back to embedded marks if available.', e);
    populateMarks();
    updateAll();
  }
}

loadDefaultMarksFromGpx();


// Zoom map to selected course extents
function zoomToSelectedCourseExtents() {
    try {
        if (typeof map === 'undefined' || !map || typeof L === 'undefined') return;

        const pts = [];

        function addPoint(p) {
            if (!p) return;
            const lat = Number(p.lat ?? p.latitude ?? p.Latitude ?? p.y);
            const lon = Number(p.lon ?? p.lng ?? p.longitude ?? p.Longitude ?? p.x);
            if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lat, lon]);
        }

        function addArray(arr) {
            if (!Array.isArray(arr)) return;
            arr.forEach(item => {
                if (!item) return;
                if (Array.isArray(item) && item.length >= 2) {
                    const lat = Number(item[0]);
                    const lon = Number(item[1]);
                    if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lat, lon]);
                } else {
                    addPoint(item);
                    addPoint(item.mark);
                    addPoint(item.from);
                    addPoint(item.to);
                }
            });
        }

        // Common course state names used across previous builds.
        if (typeof course !== 'undefined') addArray(course);
        if (typeof selectedCourse !== 'undefined') addArray(selectedCourse);
        if (typeof courseMarks !== 'undefined') addArray(courseMarks);
        if (typeof selectedMarks !== 'undefined') addArray(selectedMarks);
        if (typeof currentCourse !== 'undefined') addArray(currentCourse);

        // If the app stores course as mark names/IDs, resolve against marks arrays.
        const courseNames = [];
        const possibleNameArrays = [
            (typeof course !== 'undefined' ? course : null),
            (typeof selectedCourse !== 'undefined' ? selectedCourse : null),
            (typeof courseMarks !== 'undefined' ? courseMarks : null),
            (typeof selectedMarks !== 'undefined' ? selectedMarks : null),
            (typeof currentCourse !== 'undefined' ? currentCourse : null)
        ];
        possibleNameArrays.forEach(arr => {
            if (Array.isArray(arr)) {
                arr.forEach(v => {
                    if (typeof v === 'string') courseNames.push(v);
                    else if (v && typeof v.name === 'string' && !Number.isFinite(Number(v.lat))) courseNames.push(v.name);
                });
            }
        });

        const allMarks = [];
        if (typeof marks !== 'undefined') addArrayToResolver(marks);
        if (typeof MARKS !== 'undefined') addArrayToResolver(MARKS);
        if (typeof loadedMarks !== 'undefined') addArrayToResolver(loadedMarks);
        if (typeof markList !== 'undefined') addArrayToResolver(markList);

        function addArrayToResolver(arr) {
            if (Array.isArray(arr)) arr.forEach(m => allMarks.push(m));
        }

        if (courseNames.length && allMarks.length) {
            courseNames.forEach(name => {
                const m = allMarks.find(x => String(x.name ?? x.id ?? '').trim() === String(name).trim());
                addPoint(m);
            });
        }

        // Prefer visible course polyline/layer if available.
        if (!pts.length && typeof courseLine !== 'undefined' && courseLine && courseLine.getBounds) {
            const b = courseLine.getBounds();
            if (b && b.isValid && b.isValid()) {
                map.fitBounds(b.pad(0.18));
                return;
            }
        }
        if (!pts.length && typeof coursePolyline !== 'undefined' && coursePolyline && coursePolyline.getBounds) {
            const b = coursePolyline.getBounds();
            if (b && b.isValid && b.isValid()) {
                map.fitBounds(b.pad(0.18));
                return;
            }
        }

        // Fallback: zoom to all mark markers if no course selected.
        if (!pts.length) {
            const markerPts = [];
            map.eachLayer(layer => {
                if (layer && layer.getLatLng && !(layer instanceof L.TileLayer)) {
                    const ll = layer.getLatLng();
                    if (ll && Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) markerPts.push([ll.lat, ll.lng]);
                }
            });
            markerPts.forEach(p => pts.push(p));
        }

        if (!pts.length) return;
        const bounds = L.latLngBounds(pts);
        if (bounds.isValid()) {
            map.fitBounds(bounds.pad(0.18), { animate: true, maxZoom: 15 });
        }
    } catch (err) {
        console.warn('Zoom to course failed', err);
    }
}

function bindZoomToCourseButton() {
    const btn = document.getElementById('zoomCourseBtn');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', zoomToSelectedCourseExtents);
}

window.addEventListener('load', bindZoomToCourseButton);
document.addEventListener('DOMContentLoaded', bindZoomToCourseButton);



// ---------------- Two-page setup/course flow ----------------
function showPage(page){
  const setup = page === 'setup';
  document.body.classList.toggle('show-setup', setup);
  document.body.classList.toggle('show-course', !setup);
  $('setupPageBtn')?.classList.toggle('active-tab', setup);
  $('setupPageBtn')?.classList.toggle('secondary', !setup);
  $('coursePageBtn')?.classList.toggle('active-tab', !setup);
  $('coursePageBtn')?.classList.toggle('secondary', setup);
  if(!setup && map){
    setTimeout(() => {
      map.invalidateSize();
      if(course?.length) zoomToSelectedCourseExtents();
    }, 120);
  }
}
function bindPageTabs(){
  $('setupPageBtn')?.addEventListener('click', () => showPage('setup'));
  $('coursePageBtn')?.addEventListener('click', () => showPage('course'));
  $('continueToCourse')?.addEventListener('click', () => showPage('course'));
}

// ---------------- Solent Currents / Portsmouth tide setup ----------------
let tideDb = null;
let loadedTdmFileName = null;
let portsmouthTides = null;

function setTideStatus(message, isWarn=false){
  const el = $('tideStatus');
  if(!el) return;
  el.textContent = message;
  el.classList.toggle('warn-text', !!isWarn);
}
function signedInt32LE(dv, off){ return dv.getInt32(off, true); }
function signedInt16LE(dv, off){ return dv.getInt16(off, true); }

function decodeSolentCurrentsTdm(arrayBuffer){
  const bytes = new Uint8Array(arrayBuffer);
  const text = Array.from(bytes, b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '\0').join('');
  const wtMatches = [...text.matchAll(/WT\d{4}\0/g)];
  const areas = [...text.matchAll(/WTArea[A-Z]/g)].map(m => ({offset:m.index, name:m[0]}));
  areas.push({offset:bytes.length, name:'__END__'});

  const dv = new DataView(arrayBuffer);
  const records = [];

  for(let i=0; i<wtMatches.length; i++){
    const off = wtMatches[i].index;
    if(off == null || off + 70 > bytes.length) continue;
    const id = wtMatches[i][0].replace(/\0/g,'');
    let area = null;
    for(let a=0; a<areas.length-1; a++){
      if(areas[a].offset <= off && off < areas[a+1].offset){
        area = areas[a].name;
        break;
      }
    }

    const lon = signedInt32LE(dv, off + 10) / 360000.0;
    const lat = signedInt32LE(dv, off + 14) / 360000.0;
    if(!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

    const vectors = [];
    for(let slot=0; slot<13; slot++){
      // TDM stores components as north/east, not east/north.
      // Example validation: north=-3.091, east=-3.348 -> set 227.285635°T, drift 4.556686 kt.
      const northKt = signedInt16LE(dv, off + 18 + slot*4) / 1000.0;
      const eastKt = signedInt16LE(dv, off + 20 + slot*4) / 1000.0;
      const driftKt = Math.hypot(eastKt, northKt);
      const setDegTo = norm360(Math.atan2(eastKt, northKt) * DEG);
      vectors.push({
        slot,
        hoursFromHwGuess: slot - 6,
        eastKt,
        northKt,
        setDegTo,
        driftKt
      });
    }

    records.push({id, area, lat, lon, vectors});
  }

  if(records.length < 5) throw new Error('No Solent Currents points were decoded.');
  return {source:'Solent Currents', records};
}

function updateTideModeUi(){
  const mode = $('currentSource')?.value || 'manual';
  const tdmMode = mode === 'tdm';
  
  
  
  if(!tdmMode){
    setTideStatus('Manual current mode: use Current set/drift in Inputs.');
  } else if(tideDb){
    setTideStatus(`Solent Currents loaded: ${loadedTdmFileName || 'Solent Currents'} · ${tideDb.records.length} stream points. Use EasyTide Portsmouth to enter HW and align HW slots.`);
  } else {
    setTideStatus('Solent Currents mode: use EasyTide Portsmouth to enter HW time.');
  }
}
function renderTideTable(events){
  const tbody = $('tideTable')?.querySelector('tbody');
  if(!tbody) return;
  if(!Array.isArray(events) || !events.length){
    tbody.innerHTML = '<tr><td colspan="3">No tide data loaded.</td></tr>';
    return;
  }
  tbody.innerHTML = events.map(ev => {
    const t = ev.time || ev.DateTime || ev.dateTime || ev.eventDateTime || ev.Time || '—';
    const h = ev.height ?? ev.Height ?? ev.tidalHeight ?? ev.TidalHeight ?? ev.predictedHeight ?? '—';
    const type = ev.type || ev.EventType || ev.eventType || ev.tideType || ev.TideType || '';
    let displayTime = t;
    try { displayTime = new Date(t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); } catch(e){}
    const heightText = Number.isFinite(Number(h)) ? `${Number(h).toFixed(2)} m` : String(h);
    return `<tr><td>${displayTime}</td><td>${heightText}</td><td>${type || '—'}</td></tr>`;
  }).join('');
}
function normaliseUkhoEvents(payload){
  if(Array.isArray(payload)) return payload;
  if(Array.isArray(payload?.features)) return payload.features.map(f => ({...(f.properties || {}), geometry:f.geometry}));
  for(const key of ['events','tidalEvents','TidalEvents','items','Items','data','Data','values','Values']){
    if(Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}
async function fetchPortsmouthTides(){
  const mode = $('currentSource')?.value || 'manual';
  if(mode !== 'tdm'){
    setTideStatus('Manual current mode selected: no Portsmouth tide API fetch required.');
    return;
  }
  if(!tideDb){
    setTideStatus('Load the Solent Currents model before fetching Portsmouth tides.', true);
    return;
  }

  const key = $('ukhoApiKey')?.value?.trim();
  const station = $('tideStation')?.value?.trim() || '0065';
  if(!key){
    setTideStatus('Use EasyTide Portsmouth and enter the relevant HW time.', true);
    return;
  }

  setTideStatus('Opening EasyTide Portsmouth…');

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth()+1).padStart(2,'0');
  const dd = String(today.getDate()).padStart(2,'0');
  const date = `${yyyy}-${mm}-${dd}`;

  // Different UKHO subscription products have historically exposed slightly different paths.
  // Try the most common station-event paths, all with the supplied subscription key.
  const urls = [
    `https://admiraltyapi.azure-api.net/uktidalapi/api/V1/Stations/${encodeURIComponent(station)}/TidalEvents?date=${date}&duration=1`,
    `https://admiraltyapi.azure-api.net/uktidalapi/api/V1/Stations/${encodeURIComponent(station)}/TidalHeightEvents?date=${date}&duration=1`,
    `https://admiraltyapi.azure-api.net/uktidalapi/api/V1/TidalEvents?stationId=${encodeURIComponent(station)}&date=${date}&duration=1`
  ];

  let lastErr = null;
  for(const url of urls){
    try{
      const res = await fetch(url, {
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Accept': 'application/json'
        }
      });
      if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const payload = await res.json();
      const events = normaliseUkhoEvents(payload);
      portsmouthTides = events;
      renderTideTable(events);
      setTideStatus(`Loaded ${events.length} Portsmouth tide events for ${date}. Station ${station}.`);
      return;
    }catch(err){
      lastErr = err;
    }
  }

  setTideStatus(`UKHO fetch failed: ${lastErr?.message || 'unknown error'}. Check subscription key/CORS, or use EasyTide fallback.`, true);
}
// Embedded Solent Currents only.

function bindTideSetup(){
  $('currentSource')?.addEventListener('change', updateTideModeUi);
  
  $('fetchPortsmouthTides')?.addEventListener('click', fetchPortsmouthTides);
  $('openEasyTide')?.addEventListener('click', () => window.open('https://easytide.admiralty.co.uk/?PortID=0065', '_blank', 'noopener'));
  updateTideModeUi();
}

// Bind after the original app has created DOM event handlers.
window.addEventListener('DOMContentLoaded', () => {
  bindPageTabs();
  bindTideSetup();
  showPage('setup');
});


// ---------------- EasyTide-only Portsmouth tide setup override ----------------
// The ADMIRALTY/UKHO API flow has been removed. Use EasyTide Portsmouth manually:
// 1) open EasyTide Portsmouth
// 2) copy today's relevant Portsmouth HW time
// 3) enter it here to align Solent Currents HW-6..HW+6 slots.

let portsmouthHwTime = null;

function updateHwDisplay(){
  const el = $('hwDisplay');
  if(!el) return;
  if(!portsmouthHwTime){
    el.textContent = 'Not set';
    return;
  }
  el.textContent = portsmouthHwTime.toLocaleString([], {
    weekday:'short',
    hour:'2-digit',
    minute:'2-digit',
    day:'2-digit',
    month:'short'
  });
}

function applyEasyTideHwTime(){
  const input = $('portsmouthHwTime');
  const value = input?.value;
  if(!value){
    setTideStatus('Open EasyTide Portsmouth, copy the relevant Portsmouth HW time, then enter it here.', true);
    return;
  }
  const dt = new Date(value);
  if(Number.isNaN(dt.getTime())){
    setTideStatus('Portsmouth HW time is not valid.', true);
    return;
  }
  portsmouthHwTime = dt;
  updateHwDisplay();
  if(tideDb){
    setTideStatus(`Portsmouth HW set from EasyTide: ${dt.toLocaleString([], {hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short'})}. TDM HW slots can now be aligned manually.`);
  } else {
    setTideStatus(`Portsmouth HW set from EasyTide. Load the Solent Currents model to use HW± current slots.`);
  }
}

// Override old API function name so any existing button/reference cannot call UKHO.
fetchPortsmouthTides = function(){
  window.open('https://easytide.admiralty.co.uk/?PortID=0065', '_blank', 'noopener');
  setTideStatus('EasyTide Portsmouth opened. Enter the relevant Portsmouth HW time in the setup box.');
};

function bindEasyTideOnlySetup(){
  const oldFetchBtn = $('fetchPortsmouthTides');
  if(oldFetchBtn){
    oldFetchBtn.id = 'openEasyTide';
    oldFetchBtn.textContent = 'Open EasyTide Portsmouth';
  }
  $('ukhoApiKey')?.closest('label')?.remove();
  $('openEasyTide')?.addEventListener('click', () => {
    window.open('https://easytide.admiralty.co.uk/?PortID=0065', '_blank', 'noopener');
    setTideStatus('EasyTide Portsmouth opened. Enter the relevant Portsmouth HW time from EasyTide.');
  });
  $('applyEasyTideHw')?.addEventListener('click', applyEasyTideHwTime);
  $('portsmouthHwTime')?.addEventListener('change', applyEasyTideHwTime);
  updateHwDisplay();
}

window.addEventListener('DOMContentLoaded', bindEasyTideOnlySetup);


// ---------------- 1-minute deterministic leg simulator ----------------
let lastSimulation = null;
let simLayer = null;

function readSimulationInputs(){
  const raceStartEl = $('raceStartTime');
  const hwEl = $('portsmouthHwTime');
  const now = new Date();
  const raceStart = raceStartEl?.value ? new Date(raceStartEl.value) : now;
  const hw = hwEl?.value ? new Date(hwEl.value) : (portsmouthHwTime || null);
  const stepSec = Math.max(15, Math.min(300, Number($('simStepSec')?.value || 60)));
  const minTackSec = Math.max(0, Number($('minTackMin')?.value || 2) * 60);
  const tackPenaltySec = Math.max(0, Number($('tackPenaltySec')?.value || 5));
  return {raceStart, hw, stepSec, minTackSec, tackPenaltySec};
}
function destinationPointNm(p, bearing, distNm){
  const Rnm = 3440.065;
  const δ = distNm / Rnm;
  const θ = bearing * RAD;
  const φ1 = p.lat * RAD;
  const λ1 = p.lon * RAD;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(Math.max(-1, Math.min(1, sinφ2)));
  const y = Math.sin(θ) * Math.sin(δ) * Math.cos(φ1);
  const x = Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2);
  const λ2 = λ1 + Math.atan2(y, x);
  return {lat: φ2 * DEG, lon: norm180(λ2 * DEG)};
}
function getTdmCurrentAt(lat, lon, time){
  const mode = $('currentSource')?.value || 'manual';
  const inputs = readInputs();
  if(mode !== 'tdm' || !tideDb || !tideDb.records?.length || !portsmouthHwTime){
    return {set: inputs.set, drift: inputs.drift, source:'manual'};
  }

  const hoursFromHw = (time.getTime() - portsmouthHwTime.getTime()) / 3600000;
  const slotFloat = Math.max(0, Math.min(12, hoursFromHw + 6));
  const lo = Math.floor(slotFloat);
  const hi = Math.min(12, lo + 1);
  const ft = slotFloat - lo;

  const weighted = [];
  for(const p of tideDb.records){
    const dy = (p.lat - lat) * 60;
    const dx = (p.lon - lon) * 60 * Math.cos(lat * RAD);
    const d = Math.hypot(dx, dy);
    weighted.push({p, d});
  }
  weighted.sort((a,b)=>a.d-b.d);
  const nearest = weighted.slice(0, 5);
  let sw = 0, east = 0, north = 0, nearestId = nearest[0]?.p?.id || '';

  for(const item of nearest){
    const v0 = item.p.vectors?.[lo], v1 = item.p.vectors?.[hi] || v0;
    if(!v0) continue;
    const e = v0.eastKt + ((v1?.eastKt ?? v0.eastKt) - v0.eastKt) * ft;
    const n = v0.northKt + ((v1?.northKt ?? v0.northKt) - v0.northKt) * ft;
    const w = 1 / Math.max(item.d, 0.05) ** 2;
    east += e * w; north += n * w; sw += w;
  }

  if(sw <= 0) return {set: inputs.set, drift: inputs.drift, source:'manual-fallback'};
  east /= sw; north /= sw;
  const drift = Math.hypot(east, north);
  const set = norm360(Math.atan2(east, north) * DEG);
  return {set, drift, east, north, source:'tdm', hoursFromHw, nearestId};
}
function scoreCandidate(state, to, cand, inputs, simCfg){
  const distNow = distanceNm(state, to);
  const after = cand.next;
  const distAfter = distanceNm(after, to);
  const progressNm = distNow - distAfter;
  const bearingToMark = bearingDeg(state, to);
  const ground = cand.ground;
  const along = vecProject(ground, bearingToMark);
  const cross = Math.abs(vecCross(ground, bearingToMark));

  let score = progressNm * 1000 + along * 5 - cross * 0.8;
  if(state.mode && cand.mode !== state.mode){
    if((state.tackAgeSec || 0) < simCfg.minTackSec) score -= 10000;
    score -= simCfg.tackPenaltySec / 10;
  }
  if(distAfter > distNow + 0.02) score -= 5000;
  return score;
}
function candidateModesForLeg(mode, bearing, target, inputs){
  if(mode === 'reach'){
    const signedTwa = norm180(bearing - inputs.twd);
    const tack = signedTwa < 0 ? 'port' : 'stbd';
    return [{mode:tack, heading:bearing, twa:Math.abs(signedTwa), bsp:target.bsp}];
  }
  const hdg = tackHeadings(mode, inputs.twd, target.twa);
  return [
    {mode:'port', heading:hdg.port, twa:target.twa, bsp:target.bsp},
    {mode:'stbd', heading:hdg.stbd, twa:target.twa, bsp:target.bsp}
  ];
}
function simulateCourse(){
  readCustomPoints();
  const inputs = readInputs();
  const simCfg = readSimulationInputs();

  if(!course || course.length < 2){
    lastSimulation = null;
    renderTable(predict());
    renderMap(predict());
    return null;
  }
  if(Number.isNaN(simCfg.raceStart.getTime())){
    alert('Enter a valid race start time.');
    return null;
  }
  if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
    alert('TDM current mode needs a Portsmouth HW time from EasyTide.');
    return null;
  }

  let state = {
    lat: course[0].lat,
    lon: course[0].lon,
    time: new Date(simCfg.raceStart.getTime()),
    mode: null,
    tackAgeSec: 99999
  };

  const legSims = [];
  const fullTrack = [];
  const maxStepsPerLeg = 360; // 6 hours at 1-min steps; protects browser.

  for(let i=0; i<course.length-1; i++){
    const from = {...state};
    const to = course[i+1];
    const legStartTime = new Date(state.time.getTime());
    let portSec = 0, stbdSec = 0, directSec = 0;
    const legTrack = [{lat:state.lat, lon:state.lon, time:new Date(state.time.getTime()), mode:state.mode || 'start'}];

    for(let step=0; step<maxStepsPerLeg; step++){
      const dist = distanceNm(state, to);
      if(dist < 0.015) break; // about 28 m

      const bearing = bearingDeg(state, to);
      const signed = norm180(bearing - inputs.twd);
      const mode = legMode(Math.abs(signed));
      const target = targetFor(mode, inputs, signed);
      const current = getTdmCurrentAt(state.lat, state.lon, state.time);
      const currentVec = currentToVector(current.set, current.drift);

      const candidates = candidateModesForLeg(mode, bearing, target, inputs).map(c => {
        const boat = vecFrom(c.heading, c.bsp);
        const ground = addVec(boat, currentVec);
        const cog = norm360(Math.atan2(ground.x, ground.y) * DEG);
        const sog = Math.hypot(ground.x, ground.y);
        const stepNm = sog * (simCfg.stepSec / 3600);
        const next = destinationPointNm(state, cog, stepNm);
        return {...c, ground, cog, sog, current, next};
      });

      let best = candidates[0];
      let bestScore = -Infinity;
      for(const c of candidates){
        const s = scoreCandidate(state, to, c, inputs, simCfg);
        if(s > bestScore){ bestScore = s; best = c; }
      }

      let dt = simCfg.stepSec;
      const distBefore = distanceNm(state, to);
      const distAfter = distanceNm(best.next, to);
      const made = distBefore - distAfter;
      if(made > 0 && distBefore <= made){
        dt = simCfg.stepSec * (distBefore / made);
      }

      if(state.mode && best.mode !== state.mode){
        state.time = new Date(state.time.getTime() + simCfg.tackPenaltySec * 1000);
        if(best.mode === 'port') portSec += simCfg.tackPenaltySec;
        else if(best.mode === 'stbd') stbdSec += simCfg.tackPenaltySec;
        else directSec += simCfg.tackPenaltySec;
      }

      if(best.mode === 'port') portSec += dt;
      else if(best.mode === 'stbd') stbdSec += dt;
      else directSec += dt;

      state = {
        lat: best.next.lat,
        lon: best.next.lon,
        time: new Date(state.time.getTime() + dt * 1000),
        mode: best.mode,
        tackAgeSec: (state.mode === best.mode ? (state.tackAgeSec || 0) + dt : dt),
        cog: best.cog,
        sog: best.sog,
        bsp: best.bsp,
        current: best.current
      };
      legTrack.push({...state, time:new Date(state.time.getTime())});
      fullTrack.push({...state, legIndex:i});
      if(dt < simCfg.stepSec) break;
    }

    // Snap to mark at rounding.
    state.lat = to.lat;
    state.lon = to.lon;

    legSims.push({
      legIndex:i,
      from: course[i],
      to,
      startTime: legStartTime,
      finishTime: new Date(state.time.getTime()),
      elapsedSec: (state.time.getTime() - legStartTime.getTime()) / 1000,
      portSec,
      stbdSec,
      directSec,
      track: legTrack
    });
  }

  lastSimulation = {
    startTime: simCfg.raceStart,
    finishTime: new Date(state.time.getTime()),
    elapsedSec: (state.time.getTime() - simCfg.raceStart.getTime()) / 1000,
    legs: legSims,
    track: fullTrack
  };
  const staticResults = predict();
  renderTable(staticResults);
  renderMap(staticResults);
  return lastSimulation;
}

const __staticRenderTable = renderTable;
renderTable = function(results){
  const body = $('legsTable')?.querySelector('tbody');
  if(!body) return __staticRenderTable(results);

  body.innerHTML = results.map((r, idx) => {
    const sim = lastSimulation?.legs?.[idx];
    return `<tr>
      <td>${r.from.name} → ${r.to.name}</td><td>${fmt(r.dist,2)} nm</td><td>${fmt(r.brg,0)}</td>
      <td class="mode-${r.mode}">${r.mode}</td><td>${fmt(r.target.twa,0)}° / ${fmt(r.target.bsp,2)} kn</td>
      <td class="port-time">${fmtTime(r.portHours*3600)}</td><td class="stbd-time">${fmtTime(r.stbdHours*3600)}</td><td><b>${fmtTime(r.totalHours*3600)}</b></td>
      <td class="port-time sim-time">${sim ? fmtTime(sim.portSec) : '—'}</td>
      <td class="stbd-time sim-time">${sim ? fmtTime(sim.stbdSec) : '—'}</td>
      <td class="sim-time"><b>${sim ? fmtTime(sim.elapsedSec) : '—'}</b></td>
      <td>${r.cts}</td>
    </tr>`;
  }).join('');

  const nm = results.reduce((s,r)=>s+r.dist,0), h=results.reduce((s,r)=>s+r.totalHours,0);
  const inputs = readInputs();
  const fallback = inputs.usePolar && results.some(r => !Number.isFinite(polarSpeed(inputs.tws, r.target.twa)));
  const simHtml = lastSimulation ? `<div class="kpi sim"><b>${fmtTime(lastSimulation.elapsedSec)}</b><span>1-min simulated elapsed</span></div>` : '';
  $('summary').innerHTML = `<div class="kpi"><b>${fmt(nm,2)} nm</b><span>Course distance</span></div><div class="kpi"><b>${fmtTime(h*3600)}</b><span>Static predicted elapsed</span></div>${simHtml}<div class="kpi"><b>${results.length}</b><span>Legs</span></div><div class="kpi"><b>${fmt(nm/Math.max(h,.001),2)} kn</b><span>Static course VMG/SOG</span></div>${fallback ? '<div class="kpi warn"><b>Polar fallback</b><span>Manual BSP used where polar lookup was invalid</span></div>' : ''}`;
};

const __staticRenderMap = renderMap;
renderMap = function(results=[]){
  __staticRenderMap(results);
  if(!map) return;
  if(!simLayer) simLayer = L.layerGroup().addTo(map);
  simLayer.clearLayers();
  if(!lastSimulation?.legs?.length) return;

  lastSimulation.legs.forEach(leg => {
    const points = leg.track || [];
    for(let i=1; i<points.length; i++){
      const a = points[i-1], b = points[i];
      const mode = b.mode || a.mode || 'direct';
      const color = mode === 'port' ? '#ff4d4d' : mode === 'stbd' ? '#28d17c' : '#5db7ff';
      L.polyline([[a.lat,a.lon],[b.lat,b.lon]], {weight:5, opacity:0.9, color}).addTo(simLayer);
    }
    if(points.length){
      const end = points[points.length-1];
      L.circleMarker([end.lat,end.lon], {radius:4, weight:2, fillOpacity:0.9})
        .bindTooltip(`${leg.to.name}: ${fmtTime(leg.elapsedSec)}`)
        .addTo(simLayer);
    }
  });
};

function bindSimulationControls(){
  $('runSimulation')?.addEventListener('click', simulateCourse);
  $('raceStartTime')?.addEventListener('change', () => { lastSimulation = null; updateAll(); });
  $('simStepSec')?.addEventListener('change', () => { lastSimulation = null; updateAll(); });
  $('minTackMin')?.addEventListener('change', () => { lastSimulation = null; updateAll(); });
  $('tackPenaltySec')?.addEventListener('change', () => { lastSimulation = null; updateAll(); });

  // Helpful defaults: set race start to current local rounded next hour if blank.
  const rs = $('raceStartTime');
  if(rs && !rs.value){
    const d = new Date();
    d.setMinutes(0,0,0);
    d.setHours(d.getHours()+1);
    const local = new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,16);
    rs.value = local;
  }
}
window.addEventListener('DOMContentLoaded', bindSimulationControls);


// ---------------- Portsmouth tide range / spring-neap scaling ----------------
// TDM atlas vectors are HW-relative. These fields scale the vector strength
// by Portsmouth tidal range so springs/neaps are represented.
// Default mean range is deliberately editable in code; 4.1 m is a practical
// Solent/Portsmouth mean-range starting point for this MVP.
const PORTSMOUTH_MEAN_RANGE_M = 4.10;

function clamp(v, lo, hi){
  return Math.max(lo, Math.min(hi, v));
}

function readTideStrengthFactor(){
  const manual = Number($('tideFactor')?.value);
  return Number.isFinite(manual) ? clamp(manual, 0.50, 1.60) : 1.0;
}

function calculateTideStrengthFactorFromHeights(){
  const hw = Number($('portsmouthHwHeight')?.value);
  const lw = Number($('portsmouthLwHeight')?.value);
  if(!Number.isFinite(hw) || !Number.isFinite(lw)) return null;
  const range = Math.abs(hw - lw);
  if(range <= 0.05) return null;
  const factor = clamp(range / PORTSMOUTH_MEAN_RANGE_M, 0.50, 1.60);
  return {range, factor};
}

function classifyTideFactor(factor){
  if(factor < 0.78) return 'neapy';
  if(factor > 1.22) return 'springy';
  return 'mean-ish';
}

function updateTideStrengthUi(){
  const calc = calculateTideStrengthFactorFromHeights();
  const factorEl = $('tideFactor');

  if(calc && factorEl){
    factorEl.value = calc.factor.toFixed(2);
  }

  const factor = readTideStrengthFactor();
  const rangeEl = $('rangeDisplay');
  const displayEl = $('factorDisplay');

  if(rangeEl){
    rangeEl.textContent = calc ? `${calc.range.toFixed(2)} m` : 'Not set';
  }
  if(displayEl){
    displayEl.textContent = `${factor.toFixed(2)} × mean (${classifyTideFactor(factor)})`;
  }

  const mode = $('currentSource')?.value || 'manual';
  if(mode === 'tdm' && tideDb){
    const rangeText = calc ? ` Portsmouth range ${calc.range.toFixed(2)} m.` : '';
    setTideStatus(`Solent Currents loaded: ${loadedTdmFileName || 'Solent Currents'} · ${tideDb.records.length} stream points. Tide strength ${factor.toFixed(2)}×.${rangeText}`);
  }
}

// Wrap TDM current function so scaling is applied to TDM vectors only.
if(typeof getTdmCurrentAt === 'function' && !getTdmCurrentAt.__tideStrengthWrapped){
  const __getTdmCurrentAtBase = getTdmCurrentAt;
  getTdmCurrentAt = function(lat, lon, time){
    const c = __getTdmCurrentAtBase(lat, lon, time);
    if(c && c.source === 'tdm'){
      const factor = readTideStrengthFactor();
      const east = Number.isFinite(c.east) ? c.east * factor : null;
      const north = Number.isFinite(c.north) ? c.north * factor : null;
      if(east !== null && north !== null){
        const drift = Math.hypot(east, north);
        const set = norm360(Math.atan2(east, north) * DEG);
        return {...c, east, north, drift, set, tideFactor:factor};
      }
      return {...c, drift:c.drift * factor, tideFactor:factor};
    }
    return c;
  };
  getTdmCurrentAt.__tideStrengthWrapped = true;
}

function bindTideStrengthInputs(){
  ['portsmouthHwHeight','portsmouthLwHeight','tideFactor'].forEach(id => {
    $(id)?.addEventListener('input', () => {
      updateTideStrengthUi();
      lastSimulation = null;
      updateAll();
    });
    $(id)?.addEventListener('change', () => {
      updateTideStrengthUi();
      lastSimulation = null;
      updateAll();
    });
  });
  $('currentSource')?.addEventListener('change', updateTideStrengthUi);
  
  updateTideStrengthUi();
}
window.addEventListener('DOMContentLoaded', bindTideStrengthInputs);


// ---------------- Simulation maths fix: wind-aware scheduled tack split ----------------
// The original simulator used TWD/TWS, but selected the best tack greedily by one-minute
// distance reduction. In tide, that can make the current dominate the board choice.
// This replacement keeps the static solver's wind-derived port/starboard split as the
// deterministic plan, while still stepping through time/position/current each minute.
function simulateCourse(){
  readCustomPoints();
  const inputs = readInputs();
  const simCfg = readSimulationInputs();

  if(!course || course.length < 2){
    lastSimulation = null;
    renderTable(predict());
    renderMap(predict());
    return null;
  }
  if(Number.isNaN(simCfg.raceStart.getTime())){
    alert('Enter a valid race start time.');
    return null;
  }
  if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
    alert('TDM current mode needs a Portsmouth HW time from EasyTide.');
    return null;
  }

  let state = {
    lat: course[0].lat,
    lon: course[0].lon,
    time: new Date(simCfg.raceStart.getTime()),
    mode: null,
    tackAgeSec: 99999
  };

  const legSims = [];
  const fullTrack = [];
  const maxStepsPerLeg = 480; // 8 hours at 1-min steps.

  for(let i=0; i<course.length-1; i++){
    const legStartPoint = course[i];
    const to = course[i+1];
    const legDist = distanceNm(legStartPoint, to);
    const legBearing = bearingDeg(legStartPoint, to);
    const signedAtLegStart = norm180(legBearing - inputs.twd);
    const legModeFixed = legMode(Math.abs(signedAtLegStart));
    const targetFixed = targetFor(legModeFixed, inputs, signedAtLegStart);
    const staticPlan = legModeFixed === 'reach'
      ? solveReachLeg(legDist, legBearing, targetFixed, inputs)
      : solveTwoBoardLeg(legDist, legBearing, legModeFixed, targetFixed, inputs);

    const plannedTotal = Math.max(0.0001, staticPlan.totalHours || 0.0001);
    const desiredPortFraction = Math.max(0, staticPlan.portHours || 0) / plannedTotal;
    const desiredStbdFraction = Math.max(0, staticPlan.stbdHours || 0) / plannedTotal;

    const legStartTime = new Date(state.time.getTime());
    let portSec = 0, stbdSec = 0, directSec = 0, elapsedSec = 0;
    let currentBoard = null;
    let tackAgeSec = 99999;
    const legTrack = [{lat:state.lat, lon:state.lon, time:new Date(state.time.getTime()), mode:state.mode || 'start'}];

    for(let step=0; step<maxStepsPerLeg; step++){
      const dist = distanceNm(state, to);
      if(dist < 0.015) break; // about 28 m

      const bearingNow = bearingDeg(state, to);
      const current = getTdmCurrentAt(state.lat, state.lon, state.time);
      const currentVec = currentToVector(current.set, current.drift);

      let board;
      let heading;
      let bsp;
      let twa;

      if(legModeFixed === 'reach'){
        // Direct/reaching leg: wind sets the speed/TWA, current changes COG/SOG.
        const signedNow = norm180(bearingNow - inputs.twd);
        board = signedNow < 0 ? 'port' : 'stbd';
        heading = bearingNow;
        twa = Math.abs(signedNow);
        bsp = targetFor('reach', inputs, signedNow).bsp;
      } else {
        // Scheduled two-board leg: preserve the wind-derived static tack split,
        // rather than a one-step greedy current-biased choice.
        const hdg = tackHeadings(legModeFixed, inputs.twd, targetFixed.twa);
        const actualPortFraction = elapsedSec > 0 ? portSec / elapsedSec : 0;
        const actualStbdFraction = elapsedSec > 0 ? stbdSec / elapsedSec : 0;

        if(desiredPortFraction <= 0.001) board = 'stbd';
        else if(desiredStbdFraction <= 0.001) board = 'port';
        else {
          // Maintain the static proportion, with a minimum tack duration guard.
          const desiredBoard = actualPortFraction < desiredPortFraction ? 'port' : 'stbd';
          if(currentBoard && desiredBoard !== currentBoard && tackAgeSec < simCfg.minTackSec){
            board = currentBoard;
          } else {
            board = desiredBoard;
          }
        }

        heading = board === 'port' ? hdg.port : hdg.stbd;
        twa = targetFixed.twa;
        bsp = targetFixed.bsp;
      }

      if(currentBoard && board !== currentBoard){
        state.time = new Date(state.time.getTime() + simCfg.tackPenaltySec * 1000);
        if(board === 'port') portSec += simCfg.tackPenaltySec;
        else if(board === 'stbd') stbdSec += simCfg.tackPenaltySec;
        else directSec += simCfg.tackPenaltySec;
        elapsedSec += simCfg.tackPenaltySec;
        tackAgeSec = 0;
      }

      const boat = vecFrom(heading, bsp);
      const ground = addVec(boat, currentVec);
      const cog = norm360(Math.atan2(ground.x, ground.y) * DEG);
      const sog = Math.hypot(ground.x, ground.y);
      const stepNm = sog * (simCfg.stepSec / 3600);
      const next = destinationPointNm(state, cog, stepNm);

      let dt = simCfg.stepSec;
      const distBefore = distanceNm(state, to);
      const distAfter = distanceNm(next, to);
      const made = distBefore - distAfter;
      if(made > 0 && distBefore <= made){
        dt = simCfg.stepSec * (distBefore / made);
      }

      if(board === 'port') portSec += dt;
      else if(board === 'stbd') stbdSec += dt;
      else directSec += dt;
      elapsedSec += dt;

      state = {
        lat: next.lat,
        lon: next.lon,
        time: new Date(state.time.getTime() + dt * 1000),
        mode: board,
        tackAgeSec: currentBoard === board ? tackAgeSec + dt : dt,
        cog,
        sog,
        bsp,
        twa,
        current
      };
      currentBoard = board;
      tackAgeSec = state.tackAgeSec;

      legTrack.push({...state, time:new Date(state.time.getTime())});
      fullTrack.push({...state, legIndex:i});

      if(dt < simCfg.stepSec) break;
    }

    // Snap to the rounding mark for the next leg.
    state.lat = to.lat;
    state.lon = to.lon;

    legSims.push({
      legIndex:i,
      from: course[i],
      to,
      mode: legModeFixed,
      startTime: legStartTime,
      finishTime: new Date(state.time.getTime()),
      elapsedSec: (state.time.getTime() - legStartTime.getTime()) / 1000,
      portSec,
      stbdSec,
      directSec,
      staticPortFraction: desiredPortFraction,
      staticStbdFraction: desiredStbdFraction,
      track: legTrack
    });
  }

  lastSimulation = {
    startTime: simCfg.raceStart,
    finishTime: new Date(state.time.getTime()),
    elapsedSec: (state.time.getTime() - simCfg.raceStart.getTime()) / 1000,
    legs: legSims,
    track: fullTrack,
    note: 'scheduled-static-split'
  };

  const staticResults = predict();
  renderTable(staticResults);
  renderMap(staticResults);
  return lastSimulation;
}


// ---------------- Tack colour convention fix ----------------
// Tack is determined by the side the TRUE wind is coming FROM relative to boat heading:
// Wind from port side  => port tack (RED)
// Wind from starboard  => starboard tack (GREEN)
if(typeof renderMap === 'function' && !renderMap.__tackColourWrapped){
  const __renderMapPrev = renderMap;

  renderMap = function(results=[]){
    __renderMapPrev(results);

    if(!map || !lastSimulation?.legs?.length || !simLayer) return;

    // Remove previously-added sim polylines so we can redraw with corrected colours.
    simLayer.clearLayers();

    const twd = Number($('twd')?.value || 0);

    lastSimulation.legs.forEach(leg => {
      const points = leg.track || [];

      for(let i=1; i<points.length; i++){
        const a = points[i-1];
        const b = points[i];

        const heading = Number.isFinite(b.cog) ? b.cog :
                        Number.isFinite(a.cog) ? a.cog : 0;

        // Signed TWA:
        // positive => wind from starboard side
        // negative => wind from port side
        const signedTwa = norm180(twd - heading);

        const isPortTack = signedTwa < 0;
        const color = isPortTack ? '#ff4d4d' : '#28d17c';

        L.polyline(
          [[a.lat,a.lon],[b.lat,b.lon]],
          {
            weight:5,
            opacity:0.92,
            color
          }
        ).addTo(simLayer);
      }

      if(points.length){
        const end = points[points.length-1];
        L.circleMarker(
          [end.lat,end.lon],
          {radius:4, weight:2, fillOpacity:0.9}
        )
        .bindTooltip(`${leg.to.name}: ${fmtTime(leg.elapsedSec)}`)
        .addTo(simLayer);
      }
    });
  };

  renderMap.__tackColourWrapped = true;
}


// ---------------- Waypoint immutability fix for simulation ----------------
// The simulator must never mutate selected course waypoints.  It now clones the
// course at run time, runs the whole simulation against the clone, and then
// restores the original course object references before rendering.
if(typeof simulateCourse === 'function' && !simulateCourse.__immutableWaypointsWrapped){
  const __simulateCoursePrev = simulateCourse;

  simulateCourse = function(){
    if(!Array.isArray(course) || course.length < 2){
      return __simulateCoursePrev();
    }

    const originalCourseRefs = course.slice();

    // Clone only the fields needed by the simulator. This prevents any accidental
    // lat/lon writes from moving real waypoint markers or custom start/finish points.
    const clonedCourse = originalCourseRefs.map((m, i) => ({
      id: m?.id ?? `course_${i}`,
      name: m?.name ?? `Mark ${i + 1}`,
      lat: Number(m?.lat),
      lon: Number(m?.lon),
      custom: !!m?.custom
    }));

    try{
      course = clonedCourse;
      const sim = __simulateCoursePrev();

      // Replace sim leg from/to labels with original refs for display consistency,
      // but keep track coordinates independent.
      if(sim?.legs?.length){
        sim.legs.forEach((leg, i) => {
          leg.from = originalCourseRefs[i];
          leg.to = originalCourseRefs[i + 1];
        });
      }

      return sim;
    } finally {
      course = originalCourseRefs;
      // Redraw the UI using the original, unmodified course objects.
      const results = predict();
      renderCourseList();
      renderTable(results);
      renderMap(results);
    }
  };

  simulateCourse.__immutableWaypointsWrapped = true;
}

// Extra guard: freeze selected waypoint coordinates during map rendering after sim.
function assertCourseCoordinatesUnchanged(before){
  if(!Array.isArray(before) || !Array.isArray(course)) return;
  before.forEach((b, i) => {
    if(!course[i]) return;
    if(Number.isFinite(b.lat)) course[i].lat = b.lat;
    if(Number.isFinite(b.lon)) course[i].lon = b.lon;
  });
}
if(typeof renderMap === 'function' && !renderMap.__waypointGuardWrapped){
  const __renderMapWaypointGuardPrev = renderMap;
  renderMap = function(results=[]){
    const before = Array.isArray(course) ? course.map(m => ({lat:Number(m?.lat), lon:Number(m?.lon)})) : [];
    __renderMapWaypointGuardPrev(results);
    assertCourseCoordinatesUnchanged(before);
  };
  renderMap.__waypointGuardWrapped = true;
}


// ---------------- Embedded Solent Currents startup load ----------------
async function loadEmbeddedSolentCurrentsTdm(){
  try{
    if(tideDb?.records?.length) return;

    const candidates = ['SolentCurrents.tdm', 'WinningTides.tdm'];
    let buffer = null;
    let loadedName = null;
    let lastError = null;

    for(const name of candidates){
      try{
        const res = await fetch(name, {cache:'no-store'});
        if(!res.ok) throw new Error(`${name}: ${res.status} ${res.statusText}`);
        buffer = await res.arrayBuffer();
        loadedName = name;
        break;
      }catch(err){
        lastError = err;
      }
    }

    if(!buffer) throw lastError || new Error('Solent Currents file not found');

    tideDb = decodeSolentCurrentsTdm(buffer);
    loadedTdmFileName = loadedName;

    const source = $('currentSource');
    if(source) source.value = 'tdm';

    updateTideModeUi?.();
    updateTideStrengthUi?.();

    setTideStatus(`Solent Currents model loaded: ${tideDb.records.length} stream points. Enter Portsmouth HW time/height from EasyTide.`);
  } catch(err){
    console.warn('Embedded Solent Currents load failed', err);
    setTideStatus?.('Solent Currents model could not be loaded. Check SolentCurrents.tdm is in the same folder as index.html.', true);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  // Delay slightly so the tide setup controls exist and earlier binders have run.
  setTimeout(loadEmbeddedSolentCurrentsTdm, 150);
});


// ---------------- Simulation guardrail fix: scalar leg progress ----------------
// The previous sim could sail past/miss the mark and continue to the max-step timeout.
// This replacement uses the same wind/polar/tack maths, but advances each leg by scalar
// progress toward the fixed destination mark.  The simulated track can no longer move or
// relabel waypoints, and every leg terminates exactly at the selected waypoint.
function interpolatePointOnLeg(from, bearing, progressNm){
  return destinationPointNm(from, bearing, Math.max(0, progressNm));
}

function simulateCourse(){
  readCustomPoints();
  const inputs = readInputs();
  const simCfg = readSimulationInputs();

  if(!course || course.length < 2){
    lastSimulation = null;
    renderTable(predict());
    renderMap(predict());
    return null;
  }
  if(Number.isNaN(simCfg.raceStart.getTime())){
    alert('Enter a valid race start time.');
    return null;
  }
  if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
    alert('Solent Currents mode needs a Portsmouth HW time from EasyTide.');
    return null;
  }

  const courseClone = course.map((m, i) => ({
    id: m?.id ?? `course_${i}`,
    name: m?.name ?? `Mark ${i+1}`,
    lat: Number(m?.lat),
    lon: Number(m?.lon),
    custom: !!m?.custom
  }));

  let simTime = new Date(simCfg.raceStart.getTime());
  const legSims = [];
  const fullTrack = [];

  for(let i=0; i<courseClone.length-1; i++){
    const from = courseClone[i];
    const to = courseClone[i+1];
    const legDist = distanceNm(from, to);
    const legBearing = bearingDeg(from, to);
    const signedAtLegStart = norm180(legBearing - inputs.twd);
    const mode = legMode(Math.abs(signedAtLegStart));
    const target = targetFor(mode, inputs, signedAtLegStart);

    const staticPlan = mode === 'reach'
      ? solveReachLeg(legDist, legBearing, target, inputs)
      : solveTwoBoardLeg(legDist, legBearing, mode, target, inputs);

    const staticTotalSec = Math.max(1, staticPlan.totalHours * 3600);
    const staticPortSec = Math.max(0, staticPlan.portHours * 3600);
    const staticStbdSec = Math.max(0, staticPlan.stbdHours * 3600);

    const legStartTime = new Date(simTime.getTime());
    let elapsedSec = 0;
    let progressNm = 0;
    let portSec = 0;
    let stbdSec = 0;
    let directSec = 0;
    let lastBoard = null;
    let tackAgeSec = 999999;
    const track = [{lat:from.lat, lon:from.lon, time:new Date(simTime.getTime()), mode:'start'}];

    // Hard guard: no simulated leg may exceed 3x static time or static + 30 min.
    // This is a safety net only; normal termination is progressNm >= legDist.
    const maxLegSec = Math.max(staticTotalSec * 3, staticTotalSec + 1800);
    let guard = 0;

    while(progressNm < legDist - 0.0005 && elapsedSec < maxLegSec && guard < 1440){
      guard += 1;
      const pos = interpolatePointOnLeg(from, legBearing, progressNm);
      const current = getTdmCurrentAt(pos.lat, pos.lon, simTime);
      const currentVec = currentToVector(current.set, current.drift);

      let board;
      let heading;
      let bsp;

      if(mode === 'reach'){
        heading = legBearing;
        const signedNow = norm180(heading - inputs.twd);
        board = signedNow < 0 ? 'port' : 'stbd';
        bsp = targetFor('reach', inputs, signedNow).bsp;
      } else {
        const hdg = tackHeadings(mode, inputs.twd, target.twa);

        // Follow the static split as a schedule, but move by along-track progress.
        // This preserves the conventional tack math and prevents runaway cross-track errors.
        if(staticPortSec <= 1) board = 'stbd';
        else if(staticStbdSec <= 1) board = 'port';
        else {
          const plannedPortRatio = staticPortSec / staticTotalSec;
          const actualPortRatio = elapsedSec > 0 ? portSec / elapsedSec : 0;
          const wanted = actualPortRatio < plannedPortRatio ? 'port' : 'stbd';
          board = (lastBoard && wanted !== lastBoard && tackAgeSec < simCfg.minTackSec) ? lastBoard : wanted;
        }

        heading = board === 'port' ? hdg.port : hdg.stbd;
        bsp = target.bsp;
      }

      if(lastBoard && board !== lastBoard && simCfg.tackPenaltySec > 0){
        simTime = new Date(simTime.getTime() + simCfg.tackPenaltySec * 1000);
        elapsedSec += simCfg.tackPenaltySec;
        if(board === 'port') portSec += simCfg.tackPenaltySec;
        else if(board === 'stbd') stbdSec += simCfg.tackPenaltySec;
        else directSec += simCfg.tackPenaltySec;
        tackAgeSec = 0;
      }

      const boatVec = vecFrom(heading, bsp);
      const ground = addVec(boatVec, currentVec);
      const alongKt = Math.max(0.01, vecProject(ground, legBearing));

      let dt = Math.min(simCfg.stepSec, maxLegSec - elapsedSec);
      const stepNm = alongKt * dt / 3600;
      if(progressNm + stepNm >= legDist){
        dt = (legDist - progressNm) / alongKt * 3600;
      }

      progressNm = Math.min(legDist, progressNm + alongKt * dt / 3600);
      simTime = new Date(simTime.getTime() + dt * 1000);
      elapsedSec += dt;
      tackAgeSec = lastBoard === board ? tackAgeSec + dt : dt;
      lastBoard = board;

      if(board === 'port') portSec += dt;
      else if(board === 'stbd') stbdSec += dt;
      else directSec += dt;

      const newPos = interpolatePointOnLeg(from, legBearing, progressNm);
      const sog = Math.hypot(ground.x, ground.y);
      const cog = norm360(Math.atan2(ground.x, ground.y) * DEG);
      const point = {
        lat:newPos.lat,
        lon:newPos.lon,
        time:new Date(simTime.getTime()),
        mode:board,
        heading,
        cog,
        sog,
        bsp,
        current
      };
      track.push(point);
      fullTrack.push({...point, legIndex:i});
    }

    // Force exact waypoint endpoint. This fixes the visual "moving waypoint" illusion.
    const exactEnd = {
      lat: to.lat,
      lon: to.lon,
      time: new Date(simTime.getTime()),
      mode: lastBoard || 'finish'
    };
    track.push(exactEnd);
    fullTrack.push({...exactEnd, legIndex:i});

    legSims.push({
      legIndex:i,
      from: course[i],
      to: course[i+1],
      mode,
      startTime: legStartTime,
      finishTime: new Date(simTime.getTime()),
      elapsedSec,
      portSec,
      stbdSec,
      directSec,
      guardLimited: elapsedSec >= maxLegSec,
      track
    });
  }

  lastSimulation = {
    startTime: simCfg.raceStart,
    finishTime: new Date(simTime.getTime()),
    elapsedSec: (simTime.getTime() - simCfg.raceStart.getTime()) / 1000,
    legs: legSims,
    track: fullTrack,
    note: 'scalar-progress-sim'
  };

  const staticResults = predict();
  renderCourseList();
  renderTable(staticResults);
  renderMap(staticResults);
  return lastSimulation;
}


// ---------------- Startup 0,0 waypoint + simulated track shape fix ----------------
// 1) Prevent default/custom Start/Finish at 0,0 from being treated as valid points.
// 2) The previous guardrail sim forced the drawn track onto the rhumb line. This version
//    records the actual ground track from wind + BSP/polar + current, but uses a crossing
//    detector and cross-track guard so it cannot run away for 8 hours after missing a mark.

function isNullIslandPoint(p){
  return p && Math.abs(Number(p.lat || 0)) < 1e-9 && Math.abs(Number(p.lon || 0)) < 1e-9;
}

if(typeof validPoint === 'function' && !validPoint.__nullIslandWrapped){
  const __validPointBase = validPoint;
  validPoint = function(m){
    return __validPointBase(m) && !isNullIslandPoint(m);
  };
  validPoint.__nullIslandWrapped = true;
}

function clearNullIslandCustomPoints(){
  ['start','finish'].forEach(which => {
    const latEl = which === 'start' ? $('startLat') : $('finishLat');
    const lonEl = which === 'start' ? $('startLon') : $('finishLon');
    const lat = Number(latEl?.value);
    const lon = Number(lonEl?.value);
    if(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9){
      if(latEl) latEl.value = '';
      if(lonEl) lonEl.value = '';
    }
  });
  if(typeof customFinish !== 'undefined' && isNullIslandPoint(customFinish)){
    customFinish.lat = NaN; customFinish.lon = NaN;
  }
  if(typeof customStart !== 'undefined' && isNullIslandPoint(customStart)){
    customStart.lat = NaN; customStart.lon = NaN;
  }
  if(Array.isArray(course)){
    course = course.filter(m => !isNullIslandPoint(m));
  }
}

function legFrame(from, to){
  const brg = bearingDeg(from, to);
  const dist = distanceNm(from, to);
  return {brg, dist};
}

function alongCrossFromStart(from, bearing, p){
  const d = distanceNm(from, p);
  const b = bearingDeg(from, p);
  const delta = norm180(b - bearing) * RAD;
  return {
    along: d * Math.cos(delta),
    cross: d * Math.sin(delta)
  };
}

function simulationTrackModeForSegment(heading){
  const signed = norm180(Number($('twd')?.value || 0) - heading);
  return signed < 0 ? 'port' : 'stbd';
}

function simulateCourse(){
  clearNullIslandCustomPoints();
  readCustomPoints();

  const inputs = readInputs();
  const simCfg = readSimulationInputs();

  if(!course || course.length < 2){
    lastSimulation = null;
    renderTable(predict());
    renderMap(predict());
    return null;
  }
  if(Number.isNaN(simCfg.raceStart.getTime())){
    alert('Enter a valid race start time.');
    return null;
  }
  if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
    alert('Solent Currents mode needs a Portsmouth HW time from EasyTide.');
    return null;
  }

  const courseClone = course
    .filter(m => validPoint(m))
    .map((m, i) => ({
      id: m?.id ?? `course_${i}`,
      name: m?.name ?? `Mark ${i+1}`,
      lat: Number(m?.lat),
      lon: Number(m?.lon),
      custom: !!m?.custom
    }));

  if(courseClone.length < 2){
    lastSimulation = null;
    renderTable(predict());
    renderMap(predict());
    return null;
  }

  let state = {
    lat: courseClone[0].lat,
    lon: courseClone[0].lon,
    time: new Date(simCfg.raceStart.getTime()),
    mode: null,
    tackAgeSec: 999999
  };

  let simTime = new Date(simCfg.raceStart.getTime());
  const legSims = [];
  const fullTrack = [];

  for(let i=0; i<courseClone.length-1; i++){
    const from = courseClone[i];
    const to = courseClone[i+1];
    const {brg: legBearing, dist: legDist} = legFrame(from, to);

    const signedAtLegStart = norm180(legBearing - inputs.twd);
    const mode = legMode(Math.abs(signedAtLegStart));
    const target = targetFor(mode, inputs, signedAtLegStart);

    const staticPlan = mode === 'reach'
      ? solveReachLeg(legDist, legBearing, target, inputs)
      : solveTwoBoardLeg(legDist, legBearing, mode, target, inputs);

    const staticTotalSec = Math.max(1, staticPlan.totalHours * 3600);
    const staticPortSec = Math.max(0, staticPlan.portHours * 3600);
    const staticStbdSec = Math.max(0, staticPlan.stbdHours * 3600);
    const plannedPortRatio = staticPortSec / staticTotalSec;

    const legStartTime = new Date(simTime.getTime());
    let portSec = 0, stbdSec = 0, directSec = 0, elapsedSec = 0;
    let lastBoard = null;
    let tackAgeSec = 999999;
    let lastAlong = alongCrossFromStart(from, legBearing, state).along;
    let bestDistToMark = distanceNm(state, to);
    let noProgressSteps = 0;

    const track = [{lat:state.lat, lon:state.lon, time:new Date(simTime.getTime()), mode:'start'}];

    // Guardrails: generous but not 8-hour runaway.
    const maxLegSec = Math.max(staticTotalSec * 2.2, staticTotalSec + 1200);
    const maxCrossNm = Math.max(0.25, legDist * 0.45);
    let guard = 0;

    while(elapsedSec < maxLegSec && guard < 1440){
      guard += 1;

      const distToMark = distanceNm(state, to);
      const frame = alongCrossFromStart(from, legBearing, state);

      if(distToMark < 0.015 || frame.along >= legDist){
        break;
      }

      const current = getTdmCurrentAt(state.lat, state.lon, simTime);
      const currentVec = currentToVector(current.set, current.drift);

      let board, heading, bsp;

      if(mode === 'reach'){
        // Direct reach: heading at the mark from current position; current makes the track curve.
        heading = bearingDeg(state, to);
        const signedNow = norm180(heading - inputs.twd);
        board = signedNow < 0 ? 'port' : 'stbd';
        bsp = targetFor('reach', inputs, signedNow).bsp;
      } else {
        const hdg = tackHeadings(mode, inputs.twd, target.twa);

        // Mostly follow the static tack split, but use cross-track error to stop the
        // simulated path from drifting indefinitely away from the layline corridor.
        if(staticPortSec <= 1) board = 'stbd';
        else if(staticStbdSec <= 1) board = 'port';
        else if(frame.cross > maxCrossNm && tackAgeSec >= simCfg.minTackSec) board = 'stbd';
        else if(frame.cross < -maxCrossNm && tackAgeSec >= simCfg.minTackSec) board = 'port';
        else {
          const actualPortRatio = elapsedSec > 0 ? portSec / elapsedSec : 0;
          const wanted = actualPortRatio < plannedPortRatio ? 'port' : 'stbd';
          board = (lastBoard && wanted !== lastBoard && tackAgeSec < simCfg.minTackSec) ? lastBoard : wanted;
        }

        heading = board === 'port' ? hdg.port : hdg.stbd;
        bsp = target.bsp;
      }

      if(lastBoard && board !== lastBoard && simCfg.tackPenaltySec > 0){
        simTime = new Date(simTime.getTime() + simCfg.tackPenaltySec * 1000);
        elapsedSec += simCfg.tackPenaltySec;
        if(board === 'port') portSec += simCfg.tackPenaltySec;
        else if(board === 'stbd') stbdSec += simCfg.tackPenaltySec;
        else directSec += simCfg.tackPenaltySec;
        tackAgeSec = 0;
      }

      const boatVec = vecFrom(heading, bsp);
      const ground = addVec(boatVec, currentVec);
      const cog = norm360(Math.atan2(ground.x, ground.y) * DEG);
      const sog = Math.hypot(ground.x, ground.y);

      let dt = Math.min(simCfg.stepSec, maxLegSec - elapsedSec);
      const stepNm = sog * dt / 3600;
      let next = destinationPointNm(state, cog, stepNm);

      const nextFrame = alongCrossFromStart(from, legBearing, next);
      const nextDist = distanceNm(next, to);

      // If we crossed the perpendicular through the mark, interpolate to exact mark.
      // This preserves the sailed track up to the crossing and avoids runaway.
      if(nextFrame.along >= legDist || nextDist < 0.015){
        const denom = Math.max(1e-6, nextFrame.along - frame.along);
        const frac = Math.max(0, Math.min(1, (legDist - frame.along) / denom));
        dt = dt * frac;
        next = {lat:to.lat, lon:to.lon};
      } else if(nextDist > bestDistToMark + 0.05 && nextFrame.along <= frame.along + 0.005){
        // Not making useful progress: fall back to steering directly at mark for this step.
        noProgressSteps += 1;
        if(noProgressSteps >= 3){
          const directBearing = bearingDeg(state, to);
          const directSigned = norm180(directBearing - inputs.twd);
          const directBsp = targetFor('reach', inputs, directSigned).bsp || target.bsp;
          const directGround = addVec(vecFrom(directBearing, directBsp), currentVec);
          const directCog = norm360(Math.atan2(directGround.x, directGround.y) * DEG);
          const directSog = Math.hypot(directGround.x, directGround.y);
          next = destinationPointNm(state, directCog, directSog * dt / 3600);
          board = directSigned < 0 ? 'port' : 'stbd';
          heading = directBearing;
        }
      } else {
        noProgressSteps = 0;
      }

      simTime = new Date(simTime.getTime() + dt * 1000);
      elapsedSec += dt;
      tackAgeSec = lastBoard === board ? tackAgeSec + dt : dt;
      lastBoard = board;

      if(board === 'port') portSec += dt;
      else if(board === 'stbd') stbdSec += dt;
      else directSec += dt;

      const point = {
        lat: next.lat,
        lon: next.lon,
        time: new Date(simTime.getTime()),
        mode: board,
        heading,
        cog,
        sog,
        bsp,
        current
      };

      state = {...point, tackAgeSec};
      track.push(point);
      fullTrack.push({...point, legIndex:i});

      lastAlong = nextFrame.along;
      bestDistToMark = Math.min(bestDistToMark, nextDist);

      if(Math.abs(next.lat - to.lat) < 1e-10 && Math.abs(next.lon - to.lon) < 1e-10){
        break;
      }
    }

    // Force final exact waypoint only if the last point is close/crossed; otherwise still close it
    // but mark as guard-limited so the table/status exposes it.
    const finalPoint = track[track.length - 1];
    const endedAtMark = distanceNm(finalPoint, to) < 0.02;
    if(!endedAtMark){
      track.push({lat:to.lat, lon:to.lon, time:new Date(simTime.getTime()), mode:lastBoard || 'finish', guardSnap:true});
    }

    state = {
      lat: to.lat,
      lon: to.lon,
      time: new Date(simTime.getTime()),
      mode: lastBoard,
      tackAgeSec
    };

    legSims.push({
      legIndex:i,
      from: course[i],
      to: course[i+1],
      mode,
      startTime: legStartTime,
      finishTime: new Date(simTime.getTime()),
      elapsedSec,
      portSec,
      stbdSec,
      directSec,
      guardLimited: elapsedSec >= maxLegSec || !endedAtMark,
      track
    });
  }

  lastSimulation = {
    startTime: simCfg.raceStart,
    finishTime: new Date(simTime.getTime()),
    elapsedSec: (simTime.getTime() - simCfg.raceStart.getTime()) / 1000,
    legs: legSims,
    track: fullTrack,
    note: 'ground-track-guarded-sim'
  };

  const staticResults = predict();
  renderCourseList();
  renderTable(staticResults);
  renderMap(staticResults);
  return lastSimulation;
}

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    clearNullIslandCustomPoints();
    updateAll?.();
  }, 250);
});


// ---------------- Auto-fill Portsmouth tide times/heights ----------------
// Uses public Portsmouth tide table pages where available. KHM Portsmouth is preferred
// because it publishes today's local tide times/heights with UKHO permission. Browser
// CORS may block direct fetch; if so, the app opens EasyTide for manual entry.
function parsePortsmouthTideText(text){
  const events = [];
  const clean = String(text || '').replace(/\s+/g, ' ');

  const khmRe = /\b(HW|LW)\s*([0-2]?\d[:.][0-5]\d)\s*([0-9]+(?:\.[0-9]+)?)\s*m\b/gi;
  let m;
  while((m = khmRe.exec(clean))){
    events.push({
      type:m[1].toUpperCase(),
      time:m[2].replace('.', ':').padStart(5, '0'),
      height:Number(m[3])
    });
  }

  const genericRe = /\b(High tide|Low tide)\s*([0-2]?\d[:.][0-5]\d)\s*(am|pm)?\s*([0-9]+(?:\.[0-9]+)?)\s*m\b/gi;
  while((m = genericRe.exec(clean))){
    let hhmm = m[2].replace('.', ':');
    const ap = (m[3] || '').toLowerCase();
    if(ap){
      let [h, mi] = hhmm.split(':').map(Number);
      if(ap === 'pm' && h < 12) h += 12;
      if(ap === 'am' && h === 12) h = 0;
      hhmm = `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
    }
    events.push({
      type:/High/i.test(m[1]) ? 'HW' : 'LW',
      time:hhmm.padStart(5, '0'),
      height:Number(m[4])
    });
  }

  const seen = new Set();
  return events.filter(e => {
    const k = `${e.type}-${e.time}`;
    if(seen.has(k)) return false;
    seen.add(k);
    return Number.isFinite(e.height);
  }).sort((a,b)=>a.time.localeCompare(b.time));
}

function localDateTimeValueForToday(hhmm){
  const now = new Date();
  const [h, m] = hhmm.split(':').map(Number);
  now.setHours(h, m, 0, 0);
  return new Date(now.getTime() - now.getTimezoneOffset()*60000).toISOString().slice(0,16);
}

function applyPortsmouthTideEvents(events){
  if(!events || !events.length) throw new Error('No tide events found');

  const firstHw = events.find(e => e.type === 'HW');
  const highestHw = events.filter(e=>e.type==='HW').sort((a,b)=>b.height-a.height)[0] || firstHw;
  const lowestLw = events.filter(e=>e.type==='LW').sort((a,b)=>a.height-b.height)[0];

  if(firstHw && $('portsmouthHwTime')) $('portsmouthHwTime').value = localDateTimeValueForToday(firstHw.time);
  if(highestHw && $('portsmouthHwHeight')) $('portsmouthHwHeight').value = highestHw.height.toFixed(2);
  if(lowestLw && $('portsmouthLwHeight')) $('portsmouthLwHeight').value = lowestLw.height.toFixed(2);

  if(typeof applyEasyTideHwTime === 'function') applyEasyTideHwTime();
  if(typeof updateTideStrengthUi === 'function') updateTideStrengthUi();

  const summary = events.map(e => `${e.type} ${e.time} ${e.height.toFixed(2)}m`).join(' · ');
  setTideStatus(`Auto-filled Portsmouth tides: ${summary}`);
}

async function autoFillPortsmouthTides(){
  const urls = [
    'https://www.royalnavy.mod.uk/khm/portsmouth/port-information/tide-tables',
    'https://www.tideschart.com/United-Kingdom/England/Portsmouth/'
  ];
  let lastErr = null;

  for(const url of urls){
    try{
      const res = await fetch(url, {cache:'no-store'});
      if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const txt = await res.text();
      const events = parsePortsmouthTideText(txt);
      if(events.length){
        applyPortsmouthTideEvents(events);
        return;
      }
      lastErr = new Error('No parseable tide events found');
    }catch(err){
      lastErr = err;
    }
  }

  setTideStatus(`Auto-fill blocked or unavailable (${lastErr?.message || 'unknown'}). Open EasyTide and enter HW/LW manually.`, true);
  window.open('https://easytide.admiralty.co.uk/?PortID=0065', '_blank', 'noopener');
}

function bindAutoPortsmouthTides(){
  $('autoPortsmouthTides')?.addEventListener('click', autoFillPortsmouthTides);
}
window.addEventListener('DOMContentLoaded', bindAutoPortsmouthTides);


// ---------------- Course tab map fit fix ----------------
// When switching from Setup to Course, Leaflet may initialise while hidden and show
// max/world extents.  Force a fit after the tab is visible:
// - selected course bounds if a course exists
// - otherwise all loaded waypoint bounds
function fitMapToLoadedWaypointsOrCourse(){
  try{
    if(!map || typeof L === 'undefined') return;

    setTimeout(() => {
      map.invalidateSize();

      const coursePts = (Array.isArray(course) ? course : [])
        .filter(validPoint)
        .map(m => [Number(m.lat), Number(m.lon)]);

      if(coursePts.length >= 2){
        map.fitBounds(L.latLngBounds(coursePts).pad(0.18), {maxZoom:15});
        return;
      }

      const markPts = (Array.isArray(marks) ? marks : [])
        .filter(validPoint)
        .map(m => [Number(m.lat), Number(m.lon)]);

      if(markPts.length){
        map.fitBounds(L.latLngBounds(markPts).pad(0.10), {maxZoom:14});
      }
    }, 180);
  }catch(err){
    console.warn('fitMapToLoadedWaypointsOrCourse failed', err);
  }
}

// Wrap showPage so Course always opens on useful Solent/waypoint extents.
if(typeof showPage === 'function' && !showPage.__fitMarksWrapped){
  const __showPagePrev = showPage;
  showPage = function(page){
    __showPagePrev(page);
    if(page === 'course'){
      fitMapToLoadedWaypointsOrCourse();
    }
  };
  showPage.__fitMarksWrapped = true;
}

// Also re-fit after GPX/default marks load and after first render.
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if(document.body.classList.contains('show-course')){
      fitMapToLoadedWaypointsOrCourse();
    }
  }, 600);
});


// ---------------- Solent Currents chart arrow overlay ----------------
let currentArrowLayer = null;
let currentArrowsVisible = false;

function currentOverlayDate(){
  const el = $('currentOverlayTime');
  if(el?.value){
    const d = new Date(el.value);
    if(!Number.isNaN(d.getTime())) return d;
  }
  const sim = readSimulationInputs?.();
  if(sim?.raceStart && !Number.isNaN(sim.raceStart.getTime())) return sim.raceStart;
  return new Date();
}

function setCurrentOverlayDate(d){
  const el = $('currentOverlayTime');
  if(!el || !d || Number.isNaN(d.getTime())) return;
  el.value = new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,16);
}

function initCurrentOverlayTime(){
  const el = $('currentOverlayTime');
  if(!el || el.value) return;
  const raceEl = $('raceStartTime');
  if(raceEl?.value) {
    el.value = raceEl.value;
  } else {
    const d = new Date();
    d.setSeconds(0,0);
    setCurrentOverlayDate(d);
  }
}

function currentVectorAtPointRecord(point, time){
  if(!point?.vectors?.length) return null;

  let slotFloat = 6; // default HW if no HW time entered
  if(portsmouthHwTime && !Number.isNaN(portsmouthHwTime.getTime())){
    const hoursFromHw = (time.getTime() - portsmouthHwTime.getTime()) / 3600000;
    slotFloat = Math.max(0, Math.min(12, hoursFromHw + 6));
  }

  const lo = Math.floor(slotFloat);
  const hi = Math.min(12, lo + 1);
  const t = slotFloat - lo;

  const v0 = point.vectors[lo];
  const v1 = point.vectors[hi] || v0;
  if(!v0) return null;

  let east = v0.eastKt + ((v1.eastKt ?? v0.eastKt) - v0.eastKt) * t;
  let north = v0.northKt + ((v1.northKt ?? v0.northKt) - v0.northKt) * t;

  const factor = typeof readTideStrengthFactor === 'function' ? readTideStrengthFactor() : 1.0;
  east *= factor;
  north *= factor;

  const drift = Math.hypot(east, north);
  const set = norm360(Math.atan2(east, north) * DEG);
  return {east, north, drift, set, slotFloat, hoursFromHw: slotFloat - 6};
}

function arrowEndLatLng(lat, lon, setDegTo, driftKt){
  // Visual scale only. 1 kt = approx 0.035 degrees/min-map-ish at Solent zoom.
  // Use geographic destination so arrows point correctly on the chart.
  const lengthNm = Math.max(0.0075, driftKt * 0.07);
  return destinationPointNm({lat, lon}, setDegTo, lengthNm);
}

function currentArrowColour(drift){
  if(drift >= 3.0) return '#ff5a3c';
  if(drift >= 1.5) return '#ffc247';
  return '#54d8ff';
}

function drawArrowHead(layer, start, end, colour){
  const bearing = bearingDeg(start, end);
  const lenNm = Math.min(0.045, Math.max(0.018, distanceNm(start, end) * 0.28));
  const left = destinationPointNm(end, norm360(bearing + 155), lenNm);
  const right = destinationPointNm(end, norm360(bearing - 155), lenNm);
  L.polyline([[left.lat,left.lon],[end.lat,end.lon],[right.lat,right.lon]], {
    color: colour,
    weight: 3,
    opacity: 0.95
  }).addTo(layer);
}

function updateCurrentOverlayStatus(count, time, visible){
  const el = $('currentOverlayStatus');
  if(!el) return;

  if(!tideDb?.records?.length){
    el.textContent = 'Solent Currents not loaded.';
    return;
  }

  const hwText = portsmouthHwTime && !Number.isNaN(portsmouthHwTime.getTime())
    ? ` · HW offset ${((time.getTime() - portsmouthHwTime.getTime())/3600000).toFixed(1)}h`
    : ' · HW time not set, showing nominal HW slot';

  const factor = typeof readTideStrengthFactor === 'function' ? readTideStrengthFactor() : 1;
  el.textContent = visible
    ? `${count} current arrows · ${time.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}${hwText} · tide factor ${factor.toFixed(2)}`
    : `Current arrows hidden · ${tideDb.records.length} Solent Currents points available.`;
}

function drawCurrentArrows(){
  if(!map) return;
  if(!currentArrowLayer) currentArrowLayer = L.layerGroup().addTo(map);
  currentArrowLayer.clearLayers();

  const time = currentOverlayDate();

  if(!currentArrowsVisible || !tideDb?.records?.length){
    updateCurrentOverlayStatus(0, time, false);
    return;
  }

  const bounds = map.getBounds();
  const zoom = map.getZoom();
  const maxArrows = zoom >= 13 ? 240 : zoom >= 11 ? 160 : 90;

  const visible = tideDb.records
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && bounds.pad(0.25).contains([p.lat, p.lon]))
    .sort((a,b) => (a.lat-b.lat) || (a.lon-b.lon));

  const step = Math.max(1, Math.ceil(visible.length / maxArrows));
  let count = 0;

  for(let i=0; i<visible.length; i+=step){
    const p = visible[i];
    const v = currentVectorAtPointRecord(p, time);
    if(!v || v.drift < 0.03) continue;

    const end = arrowEndLatLng(p.lat, p.lon, v.set, v.drift);
    const colour = currentArrowColour(v.drift);

    L.polyline([[p.lat,p.lon],[end.lat,end.lon]], {
      color: colour,
      weight: Math.min(7.5, 2.25 + v.drift * 1.5),
      opacity: 0.86
    }).bindTooltip(
      `${p.id || 'Current'}<br>${v.set.toFixed(0)}°T @ ${v.drift.toFixed(2)} kn<br>${v.hoursFromHw.toFixed(1)}h from Portsmouth HW`,
      {sticky:true}
    ).addTo(currentArrowLayer);

    drawArrowHead(currentArrowLayer, {lat:p.lat, lon:p.lon}, end, colour);

    L.circleMarker([p.lat,p.lon], {
      radius: 3,
      color: colour,
      fillColor: colour,
      fillOpacity: 0.7,
      weight: 1
    }).addTo(currentArrowLayer);

    count += 1;
  }

  updateCurrentOverlayStatus(count, time, true);
}

function stepCurrentOverlay(minutes){
  const d = currentOverlayDate();
  d.setMinutes(d.getMinutes() + minutes);
  setCurrentOverlayDate(d);
  drawCurrentArrows();
}

function bindCurrentArrowOverlay(){
  initCurrentOverlayTime();

  $('toggleCurrentArrows')?.addEventListener('click', () => {
    currentArrowsVisible = !currentArrowsVisible;
    const btn = $('toggleCurrentArrows');
    if(btn) btn.textContent = currentArrowsVisible ? 'Hide currents' : 'Show currents';
    drawCurrentArrows();
  });

  $('currentBack30')?.addEventListener('click', () => stepCurrentOverlay(-30));
  $('currentForward30')?.addEventListener('click', () => stepCurrentOverlay(30));
  $('currentOverlayTime')?.addEventListener('change', drawCurrentArrows);
  $('raceStartTime')?.addEventListener('change', () => {
    const raceEl = $('raceStartTime');
    if(raceEl?.value && !$('currentOverlayTime')?.dataset.manual){
      $('currentOverlayTime').value = raceEl.value;
      drawCurrentArrows();
    }
  });
  $('portsmouthHwTime')?.addEventListener('change', drawCurrentArrows);
  $('tideFactor')?.addEventListener('change', drawCurrentArrows);
  $('portsmouthHwHeight')?.addEventListener('change', drawCurrentArrows);
  $('portsmouthLwHeight')?.addEventListener('change', drawCurrentArrows);

  // Redraw on pan/zoom.
  const waitForMap = () => {
    if(map){
      map.on('moveend zoomend', drawCurrentArrows);
      drawCurrentArrows();
    } else {
      setTimeout(waitForMap, 250);
    }
  };
  waitForMap();
}

window.addEventListener('DOMContentLoaded', bindCurrentArrowOverlay);


// ---------------- Cubic interpolation for sparse Expedition .txt polars ----------------
// Expedition .txt rows are sparse: 0, upwind VMG angle, 75, 100, 115, downwind VMG angle, 180.
// For lookup and diagram display we need a smooth curve between those points.
// This uses a monotone cubic Hermite interpolation. It behaves like a cubic spline for the
// visual curve, but limits overshoot so boat speed does not go negative or spike unrealistically.

function polarRowPoints(row){
  return polar.twa
    .map((angle, i) => ({x:Number(angle), y:Number(row.values?.[i])}))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a,b)=>a.x-b.x);
}

function cubicMonotoneInterp(points, x){
  const pts = points
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a,b)=>a.x-b.x);

  if(!pts.length) return NaN;
  if(pts.length === 1) return pts[0].y;
  if(pts.length < 4) return interp1(pts, x);

  if(x <= pts[0].x) return pts[0].y;
  if(x >= pts[pts.length-1].x) return pts[pts.length-1].y;

  const n = pts.length;
  const h = new Array(n-1);
  const d = new Array(n-1);

  for(let i=0; i<n-1; i++){
    h[i] = pts[i+1].x - pts[i].x;
    d[i] = (pts[i+1].y - pts[i].y) / (h[i] || 1);
  }

  const m = new Array(n);
  m[0] = d[0];
  m[n-1] = d[n-2];

  for(let i=1; i<n-1; i++){
    if(d[i-1] === 0 || d[i] === 0 || Math.sign(d[i-1]) !== Math.sign(d[i])){
      m[i] = 0;
    } else {
      const w1 = 2*h[i] + h[i-1];
      const w2 = h[i] + 2*h[i-1];
      m[i] = (w1 + w2) / ((w1 / d[i-1]) + (w2 / d[i]));
    }
  }

  let k = 0;
  while(k < n-2 && x > pts[k+1].x) k++;

  const t = (x - pts[k].x) / h[k];
  const t2 = t*t;
  const t3 = t2*t;

  const h00 = 2*t3 - 3*t2 + 1;
  const h10 = t3 - 2*t2 + t;
  const h01 = -2*t3 + 3*t2;
  const h11 = t3 - t2;

  const y = h00*pts[k].y + h10*h[k]*m[k] + h01*pts[k+1].y + h11*h[k]*m[k+1];

  // Conservative clamp to the local segment range to prevent spline overshoot.
  const lo = Math.min(pts[k].y, pts[k+1].y);
  const hi = Math.max(pts[k].y, pts[k+1].y);
  return Math.max(lo, Math.min(hi, y));
}

function polarRowSpeedAtTwa(row, twaAbs){
  const pts = polarRowPoints(row);
  if(pts.length >= 4) return cubicMonotoneInterp(pts, Math.abs(Number(twaAbs)));
  return interp1(pts, Math.abs(Number(twaAbs)));
}

function densePolarPointsForRow(row, stepDeg=5){
  const pts = polarRowPoints(row);
  if(!pts.length) return [];
  const out = [];

  for(let a=0; a<=180; a+=stepDeg){
    const y = pts.length >= 4 ? cubicMonotoneInterp(pts, a) : interp1(pts, a);
    if(Number.isFinite(y)) out.push({twa:a, bsp:y});
  }

  // Ensure exact sparse source points are also included, then sort/dedupe.
  pts.forEach(p => out.push({twa:p.x, bsp:p.y, source:true}));
  const byAngle = new Map();
  out.forEach(p => byAngle.set(Number(p.twa), p));
  return [...byAngle.values()].sort((a,b)=>a.twa-b.twa);
}

if(typeof polarSpeed === 'function' && !polarSpeed.__cubicSparseWrapped){
  polarSpeed = function(tws, twaAbs){
    if(!polar || !polar.rows?.length || !polar.twa?.length) return NaN;
    const twa = Math.abs(Number(twaAbs));
    const wind = Number(tws);
    if(!Number.isFinite(twa) || !Number.isFinite(wind)) return NaN;

    const rowPoints = polar.rows.map(row => {
      const bspAtTwa = polarRowSpeedAtTwa(row, twa);
      return {x:Number(row.tws), y:bspAtTwa};
    }).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));

    // TWS interpolation remains cubic when there are enough wind-speed rows.
    return rowPoints.length >= 4 ? cubicMonotoneInterp(rowPoints, wind) : interp1(rowPoints, wind);
  };
  polarSpeed.__cubicSparseWrapped = true;
}

if(typeof renderPolarDiagram === 'function' && !renderPolarDiagram.__cubicSparseWrapped){
  renderPolarDiagram = function(){
    const canvas = $('polarCanvas');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = '#07101a'; ctx.fillRect(0,0,w,h);
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    if(!polar || !polar.rows?.length || !polar.twa?.length){
      ctx.fillStyle = '#90a0b4';
      ctx.fillText('No polar loaded', w/2, h/2);
      return;
    }

    const rows = polar.rows.slice().sort((a,b)=>Number(a.tws)-Number(b.tws));
    const denseRows = rows.map(row => ({row, points:densePolarPointsForRow(row, 5)}));
    const allBsp = denseRows.flatMap(r => r.points.map(p => p.bsp).filter(Number.isFinite));

    const cx = w/2, cy = h*0.52;
    const maxBsp = Math.max(1, ...allBsp);
    const radius = Math.min(w*0.43, h*0.40);
    const scale = radius / maxBsp;

    ctx.strokeStyle = '#26364a';
    ctx.lineWidth = 1;

    const ringStep = maxBsp <= 8 ? 1 : maxBsp <= 16 ? 2 : 5;
    for(let sp=ringStep; sp<=maxBsp+0.0001; sp+=ringStep){
      ctx.beginPath();
      ctx.arc(cx, cy, sp*scale, 0, Math.PI*2);
      ctx.stroke();
      ctx.fillStyle = '#90a0b4';
      ctx.textAlign='left';
      ctx.fillText(`${sp} kn`, cx + 4, cy - sp*scale);
    }

    for(const deg of [-180,-150,-120,-90,-60,-30,0,30,60,90,120,150,180]){
      const theta = deg * RAD;
      const x = cx + Math.sin(theta) * radius;
      const y = cy - Math.cos(theta) * radius;
      ctx.beginPath();
      ctx.moveTo(cx,cy);
      ctx.lineTo(x,y);
      ctx.stroke();

      ctx.fillStyle = '#90a0b4';
      ctx.textAlign='center';
      const label = Math.abs(deg).toString() + '°';
      const lx = cx + Math.sin(theta)*(radius+18);
      const ly = cy - Math.cos(theta)*(radius+18);
      ctx.fillText(label, lx, ly);
    }

    ctx.fillStyle = '#eaf0f8';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('TWA 0° / upwind', cx, cy-radius-34);
    ctx.fillText('TWA 180° / downwind', cx, cy+radius+28);

    const palette = ['#62d2ff','#8cffb3','#ffca66','#ff8c8c','#c7a0ff','#7ad7c7','#f0f48d','#9cb7ff','#ff9ed8','#b9f1ff','#d5ffb8','#ffd0a6'];

    denseRows.forEach(({row, points}, idx) => {
      drawPolarCurve(ctx,cx,cy,scale,points,palette[idx % palette.length]);

      // Mark the original sparse points subtly so we can visually verify the .txt source data.
      const rawPts = polarRowPoints(row);
      ctx.fillStyle = palette[idx % palette.length];
      rawPts.forEach(p => {
        const theta = p.x * RAD;
        const r = p.y * scale;
        const x1 = cx + Math.sin(theta) * r;
        const y1 = cy - Math.cos(theta) * r;
        const x2 = cx - Math.sin(theta) * r;
        ctx.beginPath(); ctx.arc(x1,y1,2.2,0,Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(x2,y1,2.2,0,Math.PI*2); ctx.fill();
      });
    });

    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign='left';
    ctx.textBaseline='middle';
    const lx = 16, ly = 18, rowH = 18;
    rows.forEach((row, idx) => {
      const y = ly + idx*rowH;
      if(y > h-12) return;
      ctx.strokeStyle = palette[idx % palette.length];
      ctx.lineWidth=3;
      ctx.beginPath();
      ctx.moveTo(lx,y);
      ctx.lineTo(lx+22,y);
      ctx.stroke();
      ctx.fillStyle = '#d8e3f0';
      ctx.fillText(`${fmt(row.tws,1)} kn TWS`, lx+30, y);
    });

    ctx.fillStyle = '#90a0b4';
    ctx.textAlign = 'right';
    ctx.fillText('cubic 5° display interpolation', w - 14, h - 14);
  };
  renderPolarDiagram.__cubicSparseWrapped = true;
}

if(typeof renderPolarMeta === 'function' && !renderPolarMeta.__cubicSparseWrapped){
  const __renderPolarMetaPrev = renderPolarMeta;
  renderPolarMeta = function(){
    __renderPolarMetaPrev();
    const el = $('polarMeta');
    if(el && polar?.debug?.parser === 'expedition_pairs'){
      el.textContent += ' · sparse .txt expanded with cubic interpolation for lookup/diagram';
    }
  };
  renderPolarMeta.__cubicSparseWrapped = true;
}


// ---------------- Mobile-safe Portsmouth tide paste parser ----------------
// A phone-deployed static PWA cannot scrape EasyTide/KHM pages directly because of
// browser same-origin/CORS restrictions. This workflow is mobile-safe:
// open the tide page, copy the visible HW/LW text, paste it here, and parse locally.
function parsePortsmouthTideTextMobile(text){
  const events = [];
  const clean = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ');

  let m;

  // KHM / compact formats: HW05:42 4.7m, LW 11:21 1.0 m
  const hwLwCompact = /\b(HW|LW)\s*([0-2]?\d[:.][0-5]\d)\s*(?:BST|GMT|UTC)?\s*([0-9]+(?:\.[0-9]+)?)\s*m\b/gi;
  while((m = hwLwCompact.exec(clean))){
    events.push({
      type:m[1].toUpperCase(),
      time:m[2].replace('.', ':').padStart(5, '0'),
      height:Number(m[3])
    });
  }

  // Generic formats: High Water 05:42 4.7m / Low Water 11:21 1.0m
  const highLowWater = /\b(High Water|Low Water|High Tide|Low Tide|HW|LW)\b[^0-9]{0,30}([0-2]?\d[:.][0-5]\d)\s*(am|pm)?[^0-9]{0,20}([0-9]+(?:\.[0-9]+)?)\s*m\b/gi;
  while((m = highLowWater.exec(clean))){
    let hhmm = m[2].replace('.', ':');
    const ap = (m[3] || '').toLowerCase();
    if(ap){
      let [h, mi] = hhmm.split(':').map(Number);
      if(ap === 'pm' && h < 12) h += 12;
      if(ap === 'am' && h === 12) h = 0;
      hhmm = `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
    }
    events.push({
      type:/^(HW|High)/i.test(m[1]) ? 'HW' : 'LW',
      time:hhmm.padStart(5, '0'),
      height:Number(m[4])
    });
  }

  // EasyTide copied-table-ish fallback: time height type may be separated.
  // Example fragments often contain "05:42 4.7 High" or "11:21 1.0 Low".
  const timeHeightType = /\b([0-2]?\d[:.][0-5]\d)\s*(am|pm)?\s*([0-9]+(?:\.[0-9]+)?)\s*m?\s*(High|Low|HW|LW)\b/gi;
  while((m = timeHeightType.exec(clean))){
    let hhmm = m[1].replace('.', ':');
    const ap = (m[2] || '').toLowerCase();
    if(ap){
      let [h, mi] = hhmm.split(':').map(Number);
      if(ap === 'pm' && h < 12) h += 12;
      if(ap === 'am' && h === 12) h = 0;
      hhmm = `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
    }
    events.push({
      type:/^(High|HW)$/i.test(m[4]) ? 'HW' : 'LW',
      time:hhmm.padStart(5, '0'),
      height:Number(m[3])
    });
  }

  const dedup = new Map();
  events
    .filter(e => e && /^(HW|LW)$/.test(e.type) && /^\d{2}:\d{2}$/.test(e.time) && Number.isFinite(e.height))
    .forEach(e => dedup.set(`${e.type}-${e.time}`, e));

  return [...dedup.values()].sort((a,b)=>a.time.localeCompare(b.time));
}

function localDateTimeValueForTodayMobile(hhmm){
  const d = new Date();
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,16);
}

function applyParsedPortsmouthTidesMobile(events){
  if(!events?.length){
    setTideStatus('No HW/LW tide events found in pasted text. Try copying the tide table text including times and heights.', true);
    return;
  }

  const firstHw = events.find(e => e.type === 'HW');
  const highestHw = events.filter(e => e.type === 'HW').sort((a,b)=>b.height-a.height)[0] || firstHw;
  const lowestLw = events.filter(e => e.type === 'LW').sort((a,b)=>a.height-b.height)[0];

  if(firstHw && $('portsmouthHwTime')) $('portsmouthHwTime').value = localDateTimeValueForTodayMobile(firstHw.time);
  if(highestHw && $('portsmouthHwHeight')) $('portsmouthHwHeight').value = highestHw.height.toFixed(2);
  if(lowestLw && $('portsmouthLwHeight')) $('portsmouthLwHeight').value = lowestLw.height.toFixed(2);

  if(typeof applyEasyTideHwTime === 'function') applyEasyTideHwTime();
  if(typeof updateTideStrengthUi === 'function') updateTideStrengthUi();
  if(typeof drawCurrentArrows === 'function') drawCurrentArrows();

  const summary = events.map(e => `${e.type} ${e.time} ${e.height.toFixed(2)}m`).join(' · ');
  setTideStatus(`Parsed Portsmouth tides from pasted text: ${summary}`);
}

function parsePastedPortsmouthTides(){
  const text = $('pasteTideText')?.value || '';
  const events = parsePortsmouthTideTextMobile(text);
  applyParsedPortsmouthTidesMobile(events);
}

function bindMobileTidePasteParser(){
  $('parsePastedTides')?.addEventListener('click', parsePastedPortsmouthTides);
  $('openKhmTides')?.addEventListener('click', () => {
    window.open('https://www.royalnavy.mod.uk/khm/portsmouth/port-information/tide-tables', '_blank', 'noopener');
  });

  // Override the old auto-fill button if present. It cannot scrape on mobile.
  const autoBtn = $('autoPortsmouthTides');
  if(autoBtn){
    autoBtn.textContent = 'Parse pasted tide text';
    autoBtn.onclick = parsePastedPortsmouthTides;
  }
}

window.addEventListener('DOMContentLoaded', bindMobileTidePasteParser);


// TDM component-order validation:
// north=-3.091, east=-3.348 => drift 4.556685747 kt, set 227.285635°T.
function validateTdmComponentOrderExample(){
  const north = -3.091, east = -3.348;
  return {
    drift: Math.hypot(east, north),
    setDegTo: norm360(Math.atan2(east, north) * DEG)
  };
}


// ---------------- Free-leg current-corrected CTS fix ----------------
// On free/reaching legs, the boat should not simply point at the mark.
// It should steer a heading through the water that offsets current so COG is toward the mark.
// This solves for heading H where cross-track(boat_vector(H) + current_vector, legBearing) = 0.
function solveCurrentCorrectedHeadingToMark(legBearing, bsp, currentSet, currentDrift){
  const current = currentToVector(currentSet, currentDrift);
  const bearingRad = legBearing * RAD;

  // Unit vectors: along leg and cross-track left/right in the app's x=east, y=north frame.
  const along = {x: Math.sin(bearingRad), y: Math.cos(bearingRad)};
  const cross = {x: Math.sin((legBearing + 90) * RAD), y: Math.cos((legBearing + 90) * RAD)};

  const currentCross = current.x * cross.x + current.y * cross.y;
  const ratio = Math.max(-0.98, Math.min(0.98, -currentCross / Math.max(0.01, bsp)));

  // Two possible water headings can zero cross-track. Pick the one with positive along-track VMG.
  const offset = Math.asin(ratio) * DEG;
  const candidates = [norm360(legBearing + offset), norm360(legBearing + (180 - offset))];

  let best = {heading: legBearing, sogAlong: -Infinity, cog: legBearing, sog: 0};
  for(const hdg of candidates){
    const boat = vecFrom(hdg, bsp);
    const ground = addVec(boat, current);
    const sogAlong = ground.x * along.x + ground.y * along.y;
    const sog = Math.hypot(ground.x, ground.y);
    const cog = norm360(Math.atan2(ground.x, ground.y) * DEG);
    if(sogAlong > best.sogAlong){
      best = {heading: hdg, sogAlong, cog, sog};
    }
  }

  // If the current is too strong for a true zero-cross solution, fall back to aiming up-current
  // with the best possible heading near the leg bearing.
  if(best.sogAlong <= 0){
    let bestScan = best;
    for(let d=-80; d<=80; d+=2){
      const hdg = norm360(legBearing + d);
      const boat = vecFrom(hdg, bsp);
      const ground = addVec(boat, current);
      const crossErr = Math.abs(ground.x * cross.x + ground.y * cross.y);
      const sogAlong = ground.x * along.x + ground.y * along.y;
      const score = sogAlong - crossErr * 2;
      if(score > (bestScan.score ?? -Infinity)){
        const sog = Math.hypot(ground.x, ground.y);
        const cog = norm360(Math.atan2(ground.x, ground.y) * DEG);
        bestScan = {heading: hdg, sogAlong, cog, sog, score};
      }
    }
    best = bestScan;
  }

  return best;
}

// Patch static reaching solver too, so table CTS and time reflect current-offset steering.
if(typeof solveReachLeg === 'function' && !solveReachLeg.__ctsCorrectedWrapped){
  solveReachLeg = function(distNm, bearing, target, inputs){
    const cts = solveCurrentCorrectedHeadingToMark(bearing, target.bsp, inputs.set, inputs.drift);
    const totalHours = distNm / Math.max(cts.sogAlong, 0.01);

    // Tack side from wind relative to the heading being steered, not the mark bearing.
    const signedTwa = norm180(cts.heading - inputs.twd);
    const portHours = signedTwa < 0 ? totalHours : 0;
    const stbdHours = signedTwa >= 0 ? totalHours : 0;

    return {
      portHours,
      stbdHours,
      totalHours,
      headings:{direct:cts.heading},
      cts: fmt(cts.heading,0),
      cog: cts.cog,
      sog: cts.sog
    };
  };
  solveReachLeg.__ctsCorrectedWrapped = true;
}

// Patch whichever simulateCourse implementation is currently active by overriding reach/free-leg branch.
if(typeof simulateCourse === 'function' && !simulateCourse.__freeLegCtsWrapped){
  const __simulateCourseBeforeFreeLegPatch = simulateCourse;

  // Rather than trying to surgically edit older generated versions, override with a guarded
  // simulator that keeps the current tack/gybe behaviour but fixes free-leg CTS.
  simulateCourse = function(){
    if(typeof clearNullIslandCustomPoints === 'function') clearNullIslandCustomPoints();
    readCustomPoints();

    const inputs = readInputs();
    const simCfg = readSimulationInputs();

    if(!course || course.length < 2){
      lastSimulation = null;
      renderTable(predict());
      renderMap(predict());
      return null;
    }
    if(Number.isNaN(simCfg.raceStart.getTime())){
      alert('Enter a valid race start time.');
      return null;
    }
    if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
      alert('Solent Currents mode needs a Portsmouth HW time from EasyTide.');
      return null;
    }

    const courseClone = course
      .filter(m => validPoint(m))
      .map((m, i) => ({
        id: m?.id ?? `course_${i}`,
        name: m?.name ?? `Mark ${i+1}`,
        lat: Number(m?.lat),
        lon: Number(m?.lon),
        custom: !!m?.custom
      }));

    if(courseClone.length < 2){
      lastSimulation = null;
      renderTable(predict());
      renderMap(predict());
      return null;
    }

    let state = {
      lat: courseClone[0].lat,
      lon: courseClone[0].lon,
      time: new Date(simCfg.raceStart.getTime()),
      mode: null,
      tackAgeSec: 999999
    };

    let simTime = new Date(simCfg.raceStart.getTime());
    const legSims = [];
    const fullTrack = [];

    for(let i=0; i<courseClone.length-1; i++){
      const from = courseClone[i];
      const to = courseClone[i+1];
      const legBearing = bearingDeg(from, to);
      const legDist = distanceNm(from, to);
      const signedAtLegStart = norm180(legBearing - inputs.twd);
      const mode = legMode(Math.abs(signedAtLegStart));
      const target = targetFor(mode, inputs, signedAtLegStart);

      const staticPlan = mode === 'reach'
        ? solveReachLeg(legDist, legBearing, target, inputs)
        : solveTwoBoardLeg(legDist, legBearing, mode, target, inputs);

      const staticTotalSec = Math.max(1, staticPlan.totalHours * 3600);
      const staticPortSec = Math.max(0, staticPlan.portHours * 3600);
      const staticStbdSec = Math.max(0, staticPlan.stbdHours * 3600);
      const plannedPortRatio = staticPortSec / staticTotalSec;

      const legStartTime = new Date(simTime.getTime());
      let portSec = 0, stbdSec = 0, directSec = 0, elapsedSec = 0;
      let lastBoard = null;
      let tackAgeSec = 999999;
      let bestDistToMark = distanceNm(state, to);
      let noProgressSteps = 0;
      const track = [{lat:state.lat, lon:state.lon, time:new Date(simTime.getTime()), mode:'start'}];

      const maxLegSec = Math.max(staticTotalSec * 2.2, staticTotalSec + 1200);
      const maxCrossNm = Math.max(0.25, legDist * 0.45);
      let guard = 0;

      while(elapsedSec < maxLegSec && guard < 1440){
        guard += 1;

        const distToMark = distanceNm(state, to);
        if(distToMark < 0.015) break;

        const current = getTdmCurrentAt(state.lat, state.lon, simTime);
        const currentVec = currentToVector(current.set, current.drift);

        let board, heading, bsp, sog, cog;
        let targetBearingNow = bearingDeg(state, to);

        if(mode === 'reach'){
          const signedNowForSpeed = norm180(targetBearingNow - inputs.twd);
          bsp = targetFor('reach', inputs, signedNowForSpeed).bsp;

          const cts = solveCurrentCorrectedHeadingToMark(targetBearingNow, bsp, current.set, current.drift);
          heading = cts.heading;
          cog = cts.cog;
          sog = cts.sog;

          const signedTwaFromHeading = norm180(heading - inputs.twd);
          board = signedTwaFromHeading < 0 ? 'port' : 'stbd';
        } else {
          const frame = alongCrossFromStart(from, legBearing, state);
          const hdg = tackHeadings(mode, inputs.twd, target.twa);

          if(staticPortSec <= 1) board = 'stbd';
          else if(staticStbdSec <= 1) board = 'port';
          else if(frame.cross > maxCrossNm && tackAgeSec >= simCfg.minTackSec) board = 'stbd';
          else if(frame.cross < -maxCrossNm && tackAgeSec >= simCfg.minTackSec) board = 'port';
          else {
            const actualPortRatio = elapsedSec > 0 ? portSec / elapsedSec : 0;
            const wanted = actualPortRatio < plannedPortRatio ? 'port' : 'stbd';
            board = (lastBoard && wanted !== lastBoard && tackAgeSec < simCfg.minTackSec) ? lastBoard : wanted;
          }

          heading = board === 'port' ? hdg.port : hdg.stbd;
          bsp = target.bsp;
          const boatVec = vecFrom(heading, bsp);
          const ground = addVec(boatVec, currentVec);
          cog = norm360(Math.atan2(ground.x, ground.y) * DEG);
          sog = Math.hypot(ground.x, ground.y);
        }

        if(lastBoard && board !== lastBoard && simCfg.tackPenaltySec > 0){
          simTime = new Date(simTime.getTime() + simCfg.tackPenaltySec * 1000);
          elapsedSec += simCfg.tackPenaltySec;
          if(board === 'port') portSec += simCfg.tackPenaltySec;
          else if(board === 'stbd') stbdSec += simCfg.tackPenaltySec;
          else directSec += simCfg.tackPenaltySec;
          tackAgeSec = 0;
        }

        let dt = Math.min(simCfg.stepSec, maxLegSec - elapsedSec);
        const stepNm = sog * dt / 3600;
        let next = destinationPointNm(state, cog, stepNm);

        const nextDist = distanceNm(next, to);
        const made = distToMark - nextDist;
        if(made > 0 && distToMark <= made){
          dt = dt * (distToMark / made);
          next = {lat:to.lat, lon:to.lon};
        } else if(nextDist > bestDistToMark + 0.03){
          noProgressSteps += 1;
          if(noProgressSteps >= 3){
            // If tide/wind/CTS numerical edge case fails, snap to final fraction along leg rather than run away.
            dt = Math.min(dt, distToMark / Math.max(0.01, sog) * 3600);
            next = destinationPointNm(state, targetBearingNow, Math.min(distToMark, sog * dt / 3600));
          }
        } else {
          noProgressSteps = 0;
        }

        simTime = new Date(simTime.getTime() + dt * 1000);
        elapsedSec += dt;
        tackAgeSec = lastBoard === board ? tackAgeSec + dt : dt;
        lastBoard = board;

        if(board === 'port') portSec += dt;
        else if(board === 'stbd') stbdSec += dt;
        else directSec += dt;

        const point = {
          lat: next.lat,
          lon: next.lon,
          time: new Date(simTime.getTime()),
          mode: board,
          heading,
          cog,
          sog,
          bsp,
          current
        };

        state = {...point, tackAgeSec};
        track.push(point);
        fullTrack.push({...point, legIndex:i});
        bestDistToMark = Math.min(bestDistToMark, nextDist);

        if(Math.abs(next.lat - to.lat) < 1e-10 && Math.abs(next.lon - to.lon) < 1e-10) break;
      }

      const finalPoint = track[track.length - 1];
      const endedAtMark = distanceNm(finalPoint, to) < 0.02;
      if(!endedAtMark){
        track.push({lat:to.lat, lon:to.lon, time:new Date(simTime.getTime()), mode:lastBoard || 'finish', guardSnap:true});
      }

      state = {lat: to.lat, lon: to.lon, time: new Date(simTime.getTime()), mode: lastBoard, tackAgeSec};

      legSims.push({
        legIndex:i,
        from: course[i],
        to: course[i+1],
        mode,
        startTime: legStartTime,
        finishTime: new Date(simTime.getTime()),
        elapsedSec,
        portSec,
        stbdSec,
        directSec,
        guardLimited: elapsedSec >= maxLegSec || !endedAtMark,
        track
      });
    }

    lastSimulation = {
      startTime: simCfg.raceStart,
      finishTime: new Date(simTime.getTime()),
      elapsedSec: (simTime.getTime() - simCfg.raceStart.getTime()) / 1000,
      legs: legSims,
      track: fullTrack,
      note: 'free-leg-current-corrected-cts'
    };

    const staticResults = predict();
    renderCourseList();
    renderTable(staticResults);
    renderMap(staticResults);
    return lastSimulation;
  };

  simulateCourse.__freeLegCtsWrapped = true;
}


// ---------------- Current-solved tacking/gybing leg fix ----------------
// For upwind/downwind legs, target headings are still set by wind/TWA/polar.
// The optimisation is the board choice and split.  This helper solves the remaining
// two-board problem using the LOCAL current at the boat's current position/time.
function solveCurrentAwareTwoBoardRemaining(distNm, bearing, mode, target, inputs, currentSet, currentDrift){
  const current = currentToVector(currentSet, currentDrift);
  const hdg = tackHeadings(mode, inputs.twd, target.twa);

  const vp = addVec(vecFrom(hdg.port, target.bsp), current);
  const vs = addVec(vecFrom(hdg.stbd, target.bsp), current);

  const ap = vecProject(vp, bearing);
  const as = vecProject(vs, bearing);
  const xp = vecCross(vp, bearing);
  const xs = vecCross(vs, bearing);

  const denom = (ap * xs - as * xp);
  let tp = NaN, ts = NaN;

  if(Math.abs(denom) > 1e-9){
    tp = distNm * xs / denom;
    ts = -distNm * xp / denom;
  }

  if(!Number.isFinite(tp) || !Number.isFinite(ts) || tp < -1e-6 || ts < -1e-6){
    // If the pure cross-track cancellation solution is not available, choose the board
    // with the best positive progress while penalising cross-track growth.
    const portScore = ap - Math.abs(xp) * 0.65;
    const stbdScore = as - Math.abs(xs) * 0.65;
    if(portScore >= stbdScore){
      tp = distNm / Math.max(ap, 0.01);
      ts = 0;
    } else {
      tp = 0;
      ts = distNm / Math.max(as, 0.01);
    }
  }

  tp = Math.max(0, tp);
  ts = Math.max(0, ts);

  return {
    portHours: tp,
    stbdHours: ts,
    totalHours: tp + ts,
    headings: hdg,
    portGround: vp,
    stbdGround: vs,
    portAlong: ap,
    stbdAlong: as,
    portCross: xp,
    stbdCross: xs,
    cts: `${fmt(hdg.port,0)} / ${fmt(hdg.stbd,0)}`
  };
}

// Patch conventional/static two-board solver to make its structure explicit and reusable.
// It still uses manual/set input current in the static table; the sim uses local TDM current.
if(typeof solveTwoBoardLeg === 'function' && !solveTwoBoardLeg.__currentSolvedWrapped){
  solveTwoBoardLeg = function(distNm, bearing, mode, target, inputs){
    return solveCurrentAwareTwoBoardRemaining(distNm, bearing, mode, target, inputs, inputs.set, inputs.drift);
  };
  solveTwoBoardLeg.__currentSolvedWrapped = true;
}

function chooseCurrentSolvedBoard(state, to, mode, target, inputs, current, simCfg, lastBoard, tackAgeSec, portSec, stbdSec, elapsedSec){
  const bearingNow = bearingDeg(state, to);
  const distNow = distanceNm(state, to);
  const plan = solveCurrentAwareTwoBoardRemaining(distNow, bearingNow, mode, target, inputs, current.set, current.drift);

  const remainingTotal = Math.max(0.0001, plan.totalHours * 3600);
  const desiredPortRatio = (plan.portHours * 3600) / remainingTotal;

  let wanted;
  if(plan.portHours <= 0.0002) wanted = 'stbd';
  else if(plan.stbdHours <= 0.0002) wanted = 'port';
  else {
    // If we are currently under-consuming port relative to the local solution, sail port;
    // otherwise sail starboard. This is re-solved every step as current changes.
    const recentPortRatio = elapsedSec > 0 ? portSec / Math.max(1, elapsedSec) : 0;
    wanted = recentPortRatio < desiredPortRatio ? 'port' : 'stbd';
  }

  if(lastBoard && wanted !== lastBoard && tackAgeSec < simCfg.minTackSec){
    wanted = lastBoard;
  }

  const hdg = wanted === 'port' ? plan.headings.port : plan.headings.stbd;
  const ground = wanted === 'port' ? plan.portGround : plan.stbdGround;
  const sog = Math.hypot(ground.x, ground.y);
  const cog = norm360(Math.atan2(ground.x, ground.y) * DEG);

  return {
    board: wanted,
    heading: hdg,
    bsp: target.bsp,
    sog,
    cog,
    plan
  };
}

// Override sim again: free legs use current-corrected CTS; tack/gybe legs re-solve board split
// from the live position with live Solent Currents.
if(typeof simulateCourse === 'function' && !simulateCourse.__currentSolvedTacksWrapped){
  simulateCourse = function(){
    if(typeof clearNullIslandCustomPoints === 'function') clearNullIslandCustomPoints();
    readCustomPoints();

    const inputs = readInputs();
    const simCfg = readSimulationInputs();

    if(!course || course.length < 2){
      lastSimulation = null;
      renderTable(predict());
      renderMap(predict());
      return null;
    }
    if(Number.isNaN(simCfg.raceStart.getTime())){
      alert('Enter a valid race start time.');
      return null;
    }
    if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
      alert('Solent Currents mode needs a Portsmouth HW time from EasyTide.');
      return null;
    }

    const courseClone = course
      .filter(m => validPoint(m))
      .map((m, i) => ({
        id: m?.id ?? `course_${i}`,
        name: m?.name ?? `Mark ${i+1}`,
        lat: Number(m?.lat),
        lon: Number(m?.lon),
        custom: !!m?.custom
      }));

    if(courseClone.length < 2){
      lastSimulation = null;
      renderTable(predict());
      renderMap(predict());
      return null;
    }

    let state = {
      lat: courseClone[0].lat,
      lon: courseClone[0].lon,
      time: new Date(simCfg.raceStart.getTime()),
      mode: null,
      tackAgeSec: 999999
    };

    let simTime = new Date(simCfg.raceStart.getTime());
    const legSims = [];
    const fullTrack = [];

    for(let i=0; i<courseClone.length-1; i++){
      const from = courseClone[i];
      const to = courseClone[i+1];

      const initialBearing = bearingDeg(from, to);
      const initialDist = distanceNm(from, to);
      const signedAtLegStart = norm180(initialBearing - inputs.twd);
      const mode = legMode(Math.abs(signedAtLegStart));
      const target = targetFor(mode, inputs, signedAtLegStart);

      const staticPlan = mode === 'reach'
        ? solveReachLeg(initialDist, initialBearing, target, inputs)
        : solveTwoBoardLeg(initialDist, initialBearing, mode, target, inputs);

      const staticTotalSec = Math.max(1, staticPlan.totalHours * 3600);
      const legStartTime = new Date(simTime.getTime());

      let portSec = 0, stbdSec = 0, directSec = 0, elapsedSec = 0;
      let lastBoard = null;
      let tackAgeSec = 999999;
      let bestDistToMark = distanceNm(state, to);
      let noProgressSteps = 0;

      const track = [{lat:state.lat, lon:state.lon, time:new Date(simTime.getTime()), mode:'start'}];

      const maxLegSec = Math.max(staticTotalSec * 2.4, staticTotalSec + 1500);
      let guard = 0;

      while(elapsedSec < maxLegSec && guard < 1440){
        guard += 1;

        const distToMark = distanceNm(state, to);
        if(distToMark < 0.015) break;

        const bearingNow = bearingDeg(state, to);
        const current = getTdmCurrentAt(state.lat, state.lon, simTime);

        let board, heading, bsp, sog, cog;

        if(mode === 'reach'){
          const signedNowForSpeed = norm180(bearingNow - inputs.twd);
          bsp = targetFor('reach', inputs, signedNowForSpeed).bsp;

          const cts = solveCurrentCorrectedHeadingToMark(bearingNow, bsp, current.set, current.drift);
          heading = cts.heading;
          cog = cts.cog;
          sog = cts.sog;

          const signedTwaFromHeading = norm180(heading - inputs.twd);
          board = signedTwaFromHeading < 0 ? 'port' : 'stbd';
        } else {
          const localTarget = targetFor(mode, inputs, norm180(bearingNow - inputs.twd));
          const choice = chooseCurrentSolvedBoard(
            state, to, mode, localTarget, inputs, current, simCfg,
            lastBoard, tackAgeSec, portSec, stbdSec, elapsedSec
          );

          board = choice.board;
          heading = choice.heading;
          bsp = choice.bsp;
          cog = choice.cog;
          sog = choice.sog;
        }

        if(lastBoard && board !== lastBoard && simCfg.tackPenaltySec > 0){
          simTime = new Date(simTime.getTime() + simCfg.tackPenaltySec * 1000);
          elapsedSec += simCfg.tackPenaltySec;
          if(board === 'port') portSec += simCfg.tackPenaltySec;
          else if(board === 'stbd') stbdSec += simCfg.tackPenaltySec;
          else directSec += simCfg.tackPenaltySec;
          tackAgeSec = 0;
        }

        let dt = Math.min(simCfg.stepSec, maxLegSec - elapsedSec);
        const stepNm = sog * dt / 3600;
        let next = destinationPointNm(state, cog, stepNm);

        const nextDist = distanceNm(next, to);
        const made = distToMark - nextDist;

        // Finish interpolation.
        if(made > 0 && distToMark <= made){
          dt = dt * (distToMark / made);
          next = {lat:to.lat, lon:to.lon};
        } else if(nextDist > bestDistToMark + 0.04){
          noProgressSteps += 1;

          // If repeated non-progress occurs, solve current-corrected direct CTS for one step
          // to recover towards the mark rather than run away.
          if(noProgressSteps >= 3){
            const directBearing = bearingDeg(state, to);
            const directSigned = norm180(directBearing - inputs.twd);
            const directBsp = targetFor('reach', inputs, directSigned).bsp || bsp;
            const cts = solveCurrentCorrectedHeadingToMark(directBearing, directBsp, current.set, current.drift);
            heading = cts.heading;
            cog = cts.cog;
            sog = cts.sog;
            const recoveryNm = sog * dt / 3600;
            next = destinationPointNm(state, cog, recoveryNm);
            const recoverySigned = norm180(heading - inputs.twd);
            board = recoverySigned < 0 ? 'port' : 'stbd';
          }
        } else {
          noProgressSteps = 0;
        }

        simTime = new Date(simTime.getTime() + dt * 1000);
        elapsedSec += dt;
        tackAgeSec = lastBoard === board ? tackAgeSec + dt : dt;
        lastBoard = board;

        if(board === 'port') portSec += dt;
        else if(board === 'stbd') stbdSec += dt;
        else directSec += dt;

        const point = {
          lat: next.lat,
          lon: next.lon,
          time: new Date(simTime.getTime()),
          mode: board,
          heading,
          cog,
          sog,
          bsp,
          current
        };

        state = {...point, tackAgeSec};
        track.push(point);
        fullTrack.push({...point, legIndex:i});
        bestDistToMark = Math.min(bestDistToMark, nextDist);

        if(Math.abs(next.lat - to.lat) < 1e-10 && Math.abs(next.lon - to.lon) < 1e-10) break;
      }

      const finalPoint = track[track.length - 1];
      const endedAtMark = distanceNm(finalPoint, to) < 0.02;

      if(!endedAtMark){
        track.push({lat:to.lat, lon:to.lon, time:new Date(simTime.getTime()), mode:lastBoard || 'finish', guardSnap:true});
      }

      state = {lat: to.lat, lon: to.lon, time: new Date(simTime.getTime()), mode: lastBoard, tackAgeSec};

      legSims.push({
        legIndex:i,
        from: course[i],
        to: course[i+1],
        mode,
        startTime: legStartTime,
        finishTime: new Date(simTime.getTime()),
        elapsedSec,
        portSec,
        stbdSec,
        directSec,
        guardLimited: elapsedSec >= maxLegSec || !endedAtMark,
        track
      });
    }

    lastSimulation = {
      startTime: simCfg.raceStart,
      finishTime: new Date(simTime.getTime()),
      elapsedSec: (simTime.getTime() - simCfg.raceStart.getTime()) / 1000,
      legs: legSims,
      track: fullTrack,
      note: 'current-solved-tack-gybe-legs'
    };

    const staticResults = predict();
    renderCourseList();
    renderTable(staticResults);
    renderMap(staticResults);
    return lastSimulation;
  };

  simulateCourse.__currentSolvedTacksWrapped = true;
}


// ---------------- Inputs / polar UI tidy ----------------
function syncManualTargetsVisibility(){
  const usePolar = $('usePolar')?.value === 'Yes';
  const details = $('manualTargets');
  if(!details) return;
  if(usePolar){
    details.open = false;
    details.classList.add('manual-collapsed');
  } else {
    details.open = true;
    details.classList.remove('manual-collapsed');
  }
}
function bindInputsPolarUi(){
  $('usePolar')?.addEventListener('change', () => {
    syncManualTargetsVisibility();
    updateAll?.();
  });
  $('polarFactorPct')?.addEventListener('input', () => updateAll?.());
  $('polarFactorPct')?.addEventListener('change', () => updateAll?.());
  syncManualTargetsVisibility();
}
window.addEventListener('DOMContentLoaded', bindInputsPolarUi);


// ---------------- Two-pass tack/gybe simulator ----------------
// For tacking/gybing legs:
// Pass 1: compare two one-change routes:
//   A) port first, then tack/gybe once to starboard for the mark
//   B) starboard first, then tack/gybe once to port for the mark
// Pass 2: search earlier/later change fractions to see if a faster route exists.
// This avoids the old reactive stepper getting lost near the waypoint.

function groundVecForHeadingBspCurrent(heading, bsp, current){
  return addVec(vecFrom(heading, bsp), currentToVector(current.set, current.drift));
}

function advancePointByVec(point, groundVec, dtSec){
  const cog = norm360(Math.atan2(groundVec.x, groundVec.y) * DEG);
  const sog = Math.hypot(groundVec.x, groundVec.y);
  return {
    ...destinationPointNm(point, cog, sog * dtSec / 3600),
    cog,
    sog
  };
}

function signedCrossTrackToLine(from, bearing, p){
  const d = distanceNm(from, p);
  const b = bearingDeg(from, p);
  return d * Math.sin(norm180(b - bearing) * RAD);
}

function lineProgressNm(from, bearing, p){
  const d = distanceNm(from, p);
  const b = bearingDeg(from, p);
  return d * Math.cos(norm180(b - bearing) * RAD);
}

function oneBoardTimeToMarkByProjection(pos, to, heading, bsp, current){
  const bearing = bearingDeg(pos, to);
  const dist = distanceNm(pos, to);
  const ground = groundVecForHeadingBspCurrent(heading, bsp, current);
  const along = vecProject(ground, bearing);
  if(along <= 0.01) return Infinity;
  return dist / along * 3600;
}

function simulateOneBoardSegment(startPos, startTime, board, heading, bsp, durationSec, simCfg, currentProvider){
  const points = [];
  let p = {lat:startPos.lat, lon:startPos.lon};
  let t = new Date(startTime.getTime());
  let remaining = Math.max(0, durationSec);
  let elapsed = 0;

  while(remaining > 0.001){
    const dt = Math.min(simCfg.stepSec, remaining);
    const current = currentProvider(p, t);
    const ground = groundVecForHeadingBspCurrent(heading, bsp, current);
    const next = advancePointByVec(p, ground, dt);
    t = new Date(t.getTime() + dt * 1000);
    elapsed += dt;
    remaining -= dt;

    points.push({
      lat: next.lat,
      lon: next.lon,
      time: new Date(t.getTime()),
      mode: board,
      heading,
      cog: next.cog,
      sog: next.sog,
      bsp,
      current
    });

    p = {lat: next.lat, lon: next.lon};
  }

  return {end:p, endTime:t, elapsedSec:elapsed, points};
}

function estimateTwoBoardCandidate(start, to, mode, firstBoard, target, inputs, startTime, simCfg, currentProvider, firstFrac){
  const secondBoard = firstBoard === 'port' ? 'stbd' : 'port';
  const bearing0 = bearingDeg(start, to);
  const dist0 = distanceNm(start, to);
  const hdg = tackHeadings(mode, inputs.twd, target.twa);
  const h1 = firstBoard === 'port' ? hdg.port : hdg.stbd;
  const h2 = secondBoard === 'port' ? hdg.port : hdg.stbd;

  const initialCurrent = currentProvider(start, startTime);
  const initialPlan = solveCurrentAwareTwoBoardRemaining(dist0, bearing0, mode, target, inputs, initialCurrent.set, initialCurrent.drift);
  const total0 = Math.max(1, initialPlan.totalHours * 3600);
  const firstIdeal = firstBoard === 'port' ? initialPlan.portHours * 3600 : initialPlan.stbdHours * 3600;
  const firstSec = Math.max(0, firstIdeal * firstFrac);

  const firstSeg = simulateOneBoardSegment(start, startTime, firstBoard, h1, target.bsp, firstSec, simCfg, currentProvider);
  let switchTime = new Date(firstSeg.endTime.getTime());
  let tackPenalty = 0;

  if(firstSec > 1 && simCfg.tackPenaltySec > 0){
    switchTime = new Date(switchTime.getTime() + simCfg.tackPenaltySec * 1000);
    tackPenalty = simCfg.tackPenaltySec;
  }

  // Solve second-board duration from the switch point to the mark.
  const secondCurrent = currentProvider(firstSeg.end, switchTime);
  const secondTimeGuess = oneBoardTimeToMarkByProjection(firstSeg.end, to, h2, target.bsp, secondCurrent);
  if(!Number.isFinite(secondTimeGuess) || secondTimeGuess <= 0 || secondTimeGuess > total0 * 4){
    return null;
  }

  const secondSeg = simulateOneBoardSegment(firstSeg.end, switchTime, secondBoard, h2, target.bsp, secondTimeGuess, simCfg, currentProvider);
  const finalDist = distanceNm(secondSeg.end, to);
  const finalCross = Math.abs(signedCrossTrackToLine(start, bearing0, secondSeg.end));
  const finalProgress = lineProgressNm(start, bearing0, secondSeg.end);

  // We don't require perfect endpoint yet. Score penalises missing the mark so search can select best.
  const elapsed = firstSeg.elapsedSec + tackPenalty + secondSeg.elapsedSec;
  const missPenaltySec = finalDist * 3600 / Math.max(0.1, target.bsp) * 1.8;
  const overUnderPenalty = Math.abs(finalProgress - dist0) * 240;
  const scoreSec = elapsed + missPenaltySec + overUnderPenalty;

  const track = [
    {lat:start.lat, lon:start.lon, time:new Date(startTime.getTime()), mode:firstBoard, heading:h1},
    ...firstSeg.points,
    ...secondSeg.points
  ];

  // Force the last visual point to the mark only if acceptably close; otherwise add a snap marker
  // but keep penalty in score.
  const endedNear = finalDist < Math.max(0.04, dist0 * 0.05);
  if(!endedNear){
    track.push({
      lat: to.lat,
      lon: to.lon,
      time: new Date(secondSeg.endTime.getTime()),
      mode: secondBoard,
      heading:h2,
      guardSnap:true
    });
  } else {
    track.push({
      lat: to.lat,
      lon: to.lon,
      time: new Date(secondSeg.endTime.getTime()),
      mode: secondBoard,
      heading:h2
    });
  }

  return {
    firstBoard,
    secondBoard,
    firstSec:firstSeg.elapsedSec,
    secondSec:secondSeg.elapsedSec,
    tackPenaltySec:tackPenalty,
    elapsedSec:elapsed,
    scoreSec,
    finalDist,
    firstFrac,
    endTime:secondSeg.endTime,
    track
  };
}

function searchTwoPassTackRoute(start, to, mode, target, inputs, startTime, simCfg, currentProvider){
  const candidates = [];

  // Pass 1: the ideal static/local split, first on port and first on starboard.
  for(const firstBoard of ['port','stbd']){
    const c = estimateTwoBoardCandidate(start, to, mode, firstBoard, target, inputs, startTime, simCfg, currentProvider, 1.0);
    if(c) candidates.push({...c, pass:'corner'});
  }

  // Pass 2: tack/gybe earlier or later than the initial corner/layline plan.
  // Fractions <1 mean turn before the corner; >1 means hold longer.
  const fractions = [0.25,0.35,0.45,0.55,0.65,0.75,0.85,0.95,1.05,1.15,1.30,1.50];
  for(const firstBoard of ['port','stbd']){
    for(const frac of fractions){
      const c = estimateTwoBoardCandidate(start, to, mode, firstBoard, target, inputs, startTime, simCfg, currentProvider, frac);
      if(c) candidates.push({...c, pass:'search'});
    }
  }

  if(!candidates.length) return null;
  candidates.sort((a,b)=>a.scoreSec-b.scoreSec);
  return candidates[0];
}

if(typeof simulateCourse === 'function' && !simulateCourse.__twoPassTackWrapped){
  simulateCourse = function(){
    if(typeof clearNullIslandCustomPoints === 'function') clearNullIslandCustomPoints();
    readCustomPoints();

    const inputs = readInputs();
    const simCfg = readSimulationInputs();

    if(!course || course.length < 2){
      lastSimulation = null;
      renderTable(predict());
      renderMap(predict());
      return null;
    }
    if(Number.isNaN(simCfg.raceStart.getTime())){
      alert('Enter a valid race start time.');
      return null;
    }
    if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
      alert('Solent Currents mode needs a Portsmouth HW time from EasyTide.');
      return null;
    }

    const courseClone = course
      .filter(m => validPoint(m))
      .map((m, i) => ({
        id: m?.id ?? `course_${i}`,
        name: m?.name ?? `Mark ${i+1}`,
        lat: Number(m?.lat),
        lon: Number(m?.lon),
        custom: !!m?.custom
      }));

    let simTime = new Date(simCfg.raceStart.getTime());
    let state = {lat:courseClone[0].lat, lon:courseClone[0].lon};

    const legSims = [];
    const fullTrack = [];

    const currentProvider = (p, t) => getTdmCurrentAt(p.lat, p.lon, t);

    for(let i=0; i<courseClone.length-1; i++){
      const from = {lat:state.lat, lon:state.lon};
      const to = courseClone[i+1];
      const legBearing = bearingDeg(from, to);
      const legDist = distanceNm(from, to);
      const signed = norm180(legBearing - inputs.twd);
      const mode = legMode(Math.abs(signed));
      const target = targetFor(mode, inputs, signed);
      const legStartTime = new Date(simTime.getTime());

      let track = [];
      let portSec = 0, stbdSec = 0, directSec = 0, elapsedSec = 0;
      let guardLimited = false;

      if(mode === 'reach'){
        // Reaching/free leg remains current-corrected CTS stepper.
        let p = {lat:from.lat, lon:from.lon};
        track.push({lat:p.lat, lon:p.lon, time:new Date(simTime.getTime()), mode:'start'});
        let guard = 0;
        while(distanceNm(p, to) > 0.015 && guard < 720){
          guard += 1;
          const bearingNow = bearingDeg(p, to);
          const signedNow = norm180(bearingNow - inputs.twd);
          const bsp = targetFor('reach', inputs, signedNow).bsp;
          const current = currentProvider(p, simTime);
          const cts = solveCurrentCorrectedHeadingToMark(bearingNow, bsp, current.set, current.drift);

          let dt = simCfg.stepSec;
          const distBefore = distanceNm(p, to);
          const stepNm = cts.sog * dt / 3600;
          let next = destinationPointNm(p, cts.cog, stepNm);
          const distAfter = distanceNm(next, to);
          const made = distBefore - distAfter;
          if(made > 0 && distBefore <= made){
            dt *= distBefore / made;
            next = {lat:to.lat, lon:to.lon, cog:cts.cog, sog:cts.sog};
          }

          const board = norm180(cts.heading - inputs.twd) < 0 ? 'port' : 'stbd';
          if(board === 'port') portSec += dt; else stbdSec += dt;
          elapsedSec += dt;
          simTime = new Date(simTime.getTime() + dt*1000);

          const pt = {
            lat:next.lat,
            lon:next.lon,
            time:new Date(simTime.getTime()),
            mode:board,
            heading:cts.heading,
            cog:cts.cog,
            sog:cts.sog,
            bsp,
            current
          };
          track.push(pt);
          fullTrack.push({...pt, legIndex:i});
          p = {lat:next.lat, lon:next.lon};

          if(Math.abs(next.lat - to.lat) < 1e-10 && Math.abs(next.lon - to.lon) < 1e-10) break;
        }
        if(distanceNm(p, to) > 0.02){
          guardLimited = true;
          track.push({lat:to.lat, lon:to.lon, time:new Date(simTime.getTime()), mode:'finish', guardSnap:true});
        }
        state = {lat:to.lat, lon:to.lon};
      } else {
        const route = searchTwoPassTackRoute(from, to, mode, target, inputs, simTime, simCfg, currentProvider);
        if(route){
          track = route.track;
          elapsedSec = route.elapsedSec;
          portSec = (route.firstBoard === 'port' ? route.firstSec : 0) + (route.secondBoard === 'port' ? route.secondSec : 0);
          stbdSec = (route.firstBoard === 'stbd' ? route.firstSec : 0) + (route.secondBoard === 'stbd' ? route.secondSec : 0);
          if(route.secondBoard === 'port') portSec += route.tackPenaltySec; else stbdSec += route.tackPenaltySec;
          guardLimited = route.finalDist > Math.max(0.04, legDist * 0.05);
          simTime = new Date(route.endTime.getTime());

          route.track.forEach(pt => {
            if(pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lon)){
              fullTrack.push({...pt, legIndex:i});
            }
          });
        } else {
          // Fallback to previous sim if the two-pass route search fails.
          guardLimited = true;
          const staticPlan = solveTwoBoardLeg(legDist, legBearing, mode, target, inputs);
          elapsedSec = staticPlan.totalHours * 3600;
          portSec = staticPlan.portHours * 3600;
          stbdSec = staticPlan.stbdHours * 3600;
          simTime = new Date(simTime.getTime() + elapsedSec*1000);
          track = [
            {lat:from.lat, lon:from.lon, time:new Date(legStartTime.getTime()), mode:'start'},
            {lat:to.lat, lon:to.lon, time:new Date(simTime.getTime()), mode:'finish', guardSnap:true}
          ];
        }

        state = {lat:to.lat, lon:to.lon};
      }

      legSims.push({
        legIndex:i,
        from: course[i],
        to: course[i+1],
        mode,
        startTime: legStartTime,
        finishTime: new Date(simTime.getTime()),
        elapsedSec,
        portSec,
        stbdSec,
        directSec,
        guardLimited,
        track
      });
    }

    lastSimulation = {
      startTime: simCfg.raceStart,
      finishTime: new Date(simTime.getTime()),
      elapsedSec: (simTime.getTime() - simCfg.raceStart.getTime()) / 1000,
      legs: legSims,
      track: fullTrack,
      note: 'two-pass-tack-gybe-search'
    };

    const staticResults = predict();
    renderCourseList();
    renderTable(staticResults);
    renderMap(staticResults);
    return lastSimulation;
  };

  simulateCourse.__twoPassTackWrapped = true;
}


// ---------------- Prevent tight zoom on single course/start point ----------------
// Selecting the first waypoint or setting custom Start/Finish should not zoom tightly
// onto one point. Only fit to course bounds when there are at least two course points.
if(typeof renderMap === 'function' && !renderMap.__noSinglePointZoomWrapped){
  const __renderMapBeforeNoSingleZoom = renderMap;

  renderMap = function(results=[]){
    const beforeZoom = map ? map.getZoom() : null;
    const beforeCenter = map ? map.getCenter() : null;
    const courseCountBefore = Array.isArray(course) ? course.filter(validPoint).length : 0;

    __renderMapBeforeNoSingleZoom(results);

    if(!map) return;

    const coursePts = Array.isArray(course) ? course.filter(validPoint) : [];

    if(coursePts.length < 2){
      setTimeout(() => {
        try{
          const markPts = Array.isArray(marks) ? marks.filter(validPoint).map(m => [m.lat, m.lon]) : [];

          // If there is a previous sensible view, keep it.
          if(beforeCenter && Number.isFinite(beforeZoom) && beforeZoom > 7){
            map.setView(beforeCenter, beforeZoom, {animate:false});
            return;
          }

          // Otherwise use all loaded marks, not the single selected point.
          if(markPts.length){
            map.fitBounds(L.latLngBounds(markPts).pad(0.10), {maxZoom: 13, animate:false});
          }
        }catch(err){
          console.warn('No single point zoom guard failed', err);
        }
      }, 0);
    }
  };

  renderMap.__noSinglePointZoomWrapped = true;
}

// Also patch explicit course-tab fit helper if present.
if(typeof fitMapToLoadedWaypointsOrCourse === 'function' && !fitMapToLoadedWaypointsOrCourse.__noSinglePointZoomWrapped){
  fitMapToLoadedWaypointsOrCourse = function(){
    try{
      if(!map || typeof L === 'undefined') return;

      setTimeout(() => {
        map.invalidateSize();

        const coursePts = (Array.isArray(course) ? course : [])
          .filter(validPoint)
          .map(m => [Number(m.lat), Number(m.lon)]);

        if(coursePts.length >= 2){
          map.fitBounds(L.latLngBounds(coursePts).pad(0.18), {maxZoom:15});
          return;
        }

        const markPts = (Array.isArray(marks) ? marks : [])
          .filter(validPoint)
          .map(m => [Number(m.lat), Number(m.lon)]);

        if(markPts.length){
          map.fitBounds(L.latLngBounds(markPts).pad(0.10), {maxZoom:13});
        }
      }, 180);
    }catch(err){
      console.warn('fitMapToLoadedWaypointsOrCourse failed', err);
    }
  };

  fitMapToLoadedWaypointsOrCourse.__noSinglePointZoomWrapped = true;
}


// ---------------- Phone GPS / Geolocation overlay ----------------
let phoneGpsMarker = null;
let phoneGpsAccuracyCircle = null;
let phoneGpsWatchId = null;
let lastPhoneGps = null;

function setPhoneGpsStatus(message, isWarn=false){
  const el = $('phoneGpsStatus');
  if(!el) return;
  el.textContent = message;
  el.classList.toggle('warn-text', !!isWarn);
}

function ensurePhoneGpsLayers(){
  if(!map || typeof L === 'undefined') return false;

  if(!phoneGpsMarker){
    phoneGpsMarker = L.circleMarker([0,0], {
      radius: 8,
      weight: 3,
      color: '#ffffff',
      fillColor: '#3aa7ff',
      fillOpacity: 0.95,
      opacity: 1
    }).addTo(map);
  }

  if(!phoneGpsAccuracyCircle){
    phoneGpsAccuracyCircle = L.circle([0,0], {
      radius: 1,
      weight: 1,
      color: '#3aa7ff',
      fillColor: '#3aa7ff',
      fillOpacity: 0.12,
      opacity: 0.45
    }).addTo(map);
  }

  return true;
}

function updatePhoneGpsDisplay(pos){
  if(!ensurePhoneGpsLayers()) return;

  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const accuracy = Number(pos.coords.accuracy || 0);
  const speedMps = Number(pos.coords.speed);
  const headingDeg = Number(pos.coords.heading);

  lastPhoneGps = {
    lat,
    lon,
    accuracy,
    speedKt: Number.isFinite(speedMps) ? speedMps * 1.943844 : null,
    headingDeg: Number.isFinite(headingDeg) ? headingDeg : null,
    timestamp: pos.timestamp ? new Date(pos.timestamp) : new Date()
  };

  phoneGpsMarker.setLatLng([lat, lon]);
  phoneGpsAccuracyCircle.setLatLng([lat, lon]);
  if(Number.isFinite(accuracy) && accuracy > 0){
    phoneGpsAccuracyCircle.setRadius(accuracy);
  }

  const speedText = Number.isFinite(lastPhoneGps.speedKt) ? `<br>SOG ${lastPhoneGps.speedKt.toFixed(1)} kn` : '';
  const headingText = Number.isFinite(lastPhoneGps.headingDeg) ? `<br>COG ${lastPhoneGps.headingDeg.toFixed(0)}°` : '';

  phoneGpsMarker.bindTooltip(
    `Phone GPS<br>${lat.toFixed(6)}, ${lon.toFixed(6)}<br>±${accuracy.toFixed(0)} m${speedText}${headingText}`,
    {sticky:true}
  );

  setPhoneGpsStatus(
    `Phone GPS: ${lat.toFixed(5)}, ${lon.toFixed(5)} · accuracy ±${accuracy.toFixed(0)} m` +
    (Number.isFinite(lastPhoneGps.speedKt) ? ` · SOG ${lastPhoneGps.speedKt.toFixed(1)} kn` : '')
  );
}

function startPhoneGps(){
  if(!navigator.geolocation){
    setPhoneGpsStatus('This browser/device does not support GPS location.', true);
    return;
  }

  if(!window.isSecureContext){
    setPhoneGpsStatus('GPS requires HTTPS. Open the GitHub Pages / HTTPS version on the phone.', true);
    return;
  }

  if(!map){
    setPhoneGpsStatus('Open the Course page first so the chart is loaded.', true);
    return;
  }

  if(phoneGpsWatchId != null){
    setPhoneGpsStatus('Phone GPS is already running.');
    return;
  }

  setPhoneGpsStatus('Requesting phone GPS permission…');

  phoneGpsWatchId = navigator.geolocation.watchPosition(
    pos => {
      updatePhoneGpsDisplay(pos);
    },
    err => {
      let message = err.message || 'Unknown GPS error';
      if(err.code === 1) message = 'Location permission denied. Enable location access for this site in Safari/Chrome.';
      if(err.code === 2) message = 'Position unavailable. Check phone GPS/location services.';
      if(err.code === 3) message = 'GPS timeout. Try again with clear sky view.';
      setPhoneGpsStatus(message, true);
      stopPhoneGps(false);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000
    }
  );
}

function stopPhoneGps(updateStatus=true){
  if(phoneGpsWatchId != null && navigator.geolocation){
    navigator.geolocation.clearWatch(phoneGpsWatchId);
  }
  phoneGpsWatchId = null;

  if(updateStatus){
    setPhoneGpsStatus(lastPhoneGps ? 'Phone GPS stopped. Last position remains shown.' : 'Phone GPS stopped.');
  }
}

function centreOnPhoneGps(){
  if(!map){
    setPhoneGpsStatus('Chart not loaded yet.', true);
    return;
  }

  if(!lastPhoneGps){
    setPhoneGpsStatus('No phone position yet. Tap Show phone position first.', true);
    return;
  }

  map.setView([lastPhoneGps.lat, lastPhoneGps.lon], Math.max(map.getZoom() || 13, 14), {animate:true});
}

function usePhoneGpsAsStart(){
  if(!lastPhoneGps){
    setPhoneGpsStatus('No phone position yet. Tap Show phone position first.', true);
    return;
  }

  setCustomPoint('start', lastPhoneGps.lat, lastPhoneGps.lon);

  // Insert or replace first course point with custom start.
  readCustomPoints();
  if(validPoint(customStart)){
    if(Array.isArray(course) && course.length && course[0]?.id === 'custom_start'){
      course[0] = {...customStart};
    } else {
      course.unshift({...customStart});
    }
  }

  setPhoneGpsStatus(`Phone GPS set as Start: ${lastPhoneGps.lat.toFixed(6)}, ${lastPhoneGps.lon.toFixed(6)}`);
  updateAll?.();
}

function bindPhoneGpsControls(){
  $('startPhoneGps')?.addEventListener('click', startPhoneGps);
  $('stopPhoneGps')?.addEventListener('click', () => stopPhoneGps(true));
  $('centrePhoneGps')?.addEventListener('click', centreOnPhoneGps);
  $('usePhoneAsStart')?.addEventListener('click', usePhoneGpsAsStart);
}

window.addEventListener('DOMContentLoaded', bindPhoneGpsControls);


// ---------------- Candidate ground-track simulator ----------------
// This replaces the tidy scalar/ratio route with a route-candidate simulator.
// Each candidate is sailed over the ground at 1-minute steps using:
// heading through water + local Solent current = COG/SOG.
// The result is a curved ground track when tide changes across the leg.

function gtCurrentProvider(p, t){
  return getTdmCurrentAt(p.lat, p.lon, t);
}

function gtAdvance(p, heading, bsp, current, dtSec){
  const ground = addVec(vecFrom(heading, bsp), currentToVector(current.set, current.drift));
  const cog = norm360(Math.atan2(ground.x, ground.y) * DEG);
  const sog = Math.hypot(ground.x, ground.y);
  const next = destinationPointNm(p, cog, sog * dtSec / 3600);
  return {next, cog, sog, ground};
}

function gtCrossedMark(prev, next, mark, previousDist, currentDist){
  if(currentDist < 0.015) return true;
  // If the new point is farther away and the closest approach is very near,
  // treat as having crossed the rounding circle.
  return previousDist < 0.04 && currentDist > previousDist;
}

function gtBoardFromHeading(heading, twd){
  return norm180(heading - twd) < 0 ? 'port' : 'stbd';
}

function gtHeadingForFreeLeg(p, mark, bsp, current){
  const bearing = bearingDeg(p, mark);
  return solveCurrentCorrectedHeadingToMark(bearing, bsp, current.set, current.drift);
}

function gtSimFreeLeg(start, mark, inputs, simCfg, startTime, target){
  let p = {lat:start.lat, lon:start.lon};
  let t = new Date(startTime.getTime());
  let elapsed = 0, portSec = 0, stbdSec = 0;
  let lastDist = distanceNm(p, mark);
  const track = [{lat:p.lat, lon:p.lon, time:new Date(t.getTime()), mode:'start'}];
  const staticGuardSec = Math.max(900, lastDist / Math.max(0.1, target.bsp) * 3600 * 2.5);
  let guard = 0;

  while(elapsed < staticGuardSec && guard < 1440){
    guard += 1;
    const dist = distanceNm(p, mark);
    if(dist < 0.015) break;

    const current = gtCurrentProvider(p, t);
    const signedNow = norm180(bearingDeg(p, mark) - inputs.twd);
    const bsp = targetFor('reach', inputs, signedNow).bsp;
    const cts = gtHeadingForFreeLeg(p, mark, bsp, current);
    const board = gtBoardFromHeading(cts.heading, inputs.twd);

    let dt = simCfg.stepSec;
    const adv = gtAdvance(p, cts.heading, bsp, current, dt);
    let next = adv.next;
    const newDist = distanceNm(next, mark);

    if(gtCrossedMark(p, next, mark, dist, newDist)){
      // Interpolate roughly by distance-made.
      const made = Math.max(0.0001, dist - newDist);
      if(made > 0) dt = Math.max(1, Math.min(dt, dt * (dist / Math.max(dist, made))));
      next = {lat:mark.lat, lon:mark.lon};
    }

    elapsed += dt;
    t = new Date(t.getTime() + dt * 1000);
    if(board === 'port') portSec += dt; else stbdSec += dt;

    const pt = {
      lat:next.lat, lon:next.lon, time:new Date(t.getTime()),
      mode:board, heading:cts.heading, cog:adv.cog, sog:adv.sog,
      bsp, current
    };
    track.push(pt);
    p = {lat:next.lat, lon:next.lon};
    lastDist = newDist;

    if(Math.abs(next.lat - mark.lat) < 1e-10 && Math.abs(next.lon - mark.lon) < 1e-10) break;
  }

  const finalDist = distanceNm(p, mark);
  const guardLimited = finalDist > 0.04;
  if(guardLimited){
    track.push({lat:mark.lat, lon:mark.lon, time:new Date(t.getTime()), mode:'finish', guardSnap:true});
  }

  return {
    track, elapsedSec:elapsed, portSec, stbdSec, directSec:0,
    endTime:t, finalDist, guardLimited, scoreSec: elapsed + finalDist * 2400
  };
}

function gtSimTwoBoardCandidate(start, mark, mode, target, inputs, simCfg, startTime, firstBoard, firstPhaseSec){
  const hdg = tackHeadings(mode, inputs.twd, target.twa);
  const secondBoard = firstBoard === 'port' ? 'stbd' : 'port';
  const h1 = firstBoard === 'port' ? hdg.port : hdg.stbd;
  const h2 = secondBoard === 'port' ? hdg.port : hdg.stbd;

  let p = {lat:start.lat, lon:start.lon};
  let t = new Date(startTime.getTime());
  let elapsed = 0, portSec = 0, stbdSec = 0;
  let phase = 1;
  let previousDist = distanceNm(p, mark);
  let minDist = previousDist;

  const initialDist = previousDist;
  const maxSec = Math.max(1800, initialDist / Math.max(0.1, target.bsp) * 3600 * 3.0);
  const track = [{lat:p.lat, lon:p.lon, time:new Date(t.getTime()), mode:firstBoard, heading:h1}];

  let guard = 0;
  while(elapsed < maxSec && guard < 1440){
    guard += 1;

    const dist = distanceNm(p, mark);
    if(dist < 0.015) break;

    let board = phase === 1 ? firstBoard : secondBoard;
    let heading = phase === 1 ? h1 : h2;

    if(phase === 1 && elapsed >= firstPhaseSec){
      phase = 2;
      if(simCfg.tackPenaltySec > 0){
        elapsed += simCfg.tackPenaltySec;
        t = new Date(t.getTime() + simCfg.tackPenaltySec * 1000);
        if(secondBoard === 'port') portSec += simCfg.tackPenaltySec; else stbdSec += simCfg.tackPenaltySec;
      }
      board = secondBoard;
      heading = h2;
    }

    const current = gtCurrentProvider(p, t);
    let dt = simCfg.stepSec;
    const adv = gtAdvance(p, heading, target.bsp, current, dt);
    let next = adv.next;
    const newDist = distanceNm(next, mark);

    // If on second board and we have passed closest approach, finish at mark.
    if(phase === 2 && gtCrossedMark(p, next, mark, dist, newDist)){
      next = {lat:mark.lat, lon:mark.lon};
    }

    elapsed += dt;
    t = new Date(t.getTime() + dt * 1000);
    if(board === 'port') portSec += dt; else stbdSec += dt;

    const pt = {
      lat:next.lat, lon:next.lon, time:new Date(t.getTime()),
      mode:board, heading, cog:adv.cog, sog:adv.sog,
      bsp:target.bsp, current
    };
    track.push(pt);
    p = {lat:next.lat, lon:next.lon};

    previousDist = dist;
    minDist = Math.min(minDist, newDist);

    if(Math.abs(next.lat - mark.lat) < 1e-10 && Math.abs(next.lon - mark.lon) < 1e-10) break;
  }

  const finalDist = distanceNm(p, mark);
  const guardLimited = finalDist > Math.max(0.05, initialDist * 0.04);

  if(guardLimited){
    track.push({lat:mark.lat, lon:mark.lon, time:new Date(t.getTime()), mode:secondBoard, heading:h2, guardSnap:true});
  }

  const missPenalty = finalDist * 3600;
  const scoreSec = elapsed + missPenalty + (guardLimited ? 600 : 0);

  return {
    firstBoard, secondBoard, firstPhaseSec,
    track, elapsedSec:elapsed, portSec, stbdSec, directSec:0,
    endTime:t, finalDist, guardLimited, scoreSec
  };
}

function gtSearchTwoBoardRoute(start, mark, mode, target, inputs, simCfg, startTime){
  const bearing0 = bearingDeg(start, mark);
  const dist0 = distanceNm(start, mark);
  const current0 = gtCurrentProvider(start, startTime);
  const plan0 = solveCurrentAwareTwoBoardRemaining(dist0, bearing0, mode, target, inputs, current0.set, current0.drift);

  const candidates = [];
  for(const firstBoard of ['port','stbd']){
    const idealFirst = firstBoard === 'port' ? plan0.portHours * 3600 : plan0.stbdHours * 3600;
    const base = Math.max(simCfg.minTackSec || 0, idealFirst || (plan0.totalHours * 1800));

    // First pass: go to predicted corner.
    candidates.push(gtSimTwoBoardCandidate(start, mark, mode, target, inputs, simCfg, startTime, firstBoard, base));

    // Second pass: try earlier/later tack/gybe points.
    [0.25,0.35,0.45,0.55,0.65,0.75,0.85,0.95,1.10,1.25,1.45].forEach(f => {
      candidates.push(gtSimTwoBoardCandidate(start, mark, mode, target, inputs, simCfg, startTime, firstBoard, Math.max(0, base * f)));
    });
  }

  return candidates
    .filter(c => c && Number.isFinite(c.scoreSec))
    .sort((a,b)=>a.scoreSec-b.scoreSec)[0] || null;
}

if(typeof simulateCourse === 'function' && !simulateCourse.__groundTrackRouterWrapped){
  simulateCourse = function(){
    if(typeof clearNullIslandCustomPoints === 'function') clearNullIslandCustomPoints();
    readCustomPoints();

    const inputs = readInputs();
    const simCfg = readSimulationInputs();

    if(!course || course.length < 2){
      lastSimulation = null;
      renderTable(predict());
      renderMap(predict());
      return null;
    }
    if(Number.isNaN(simCfg.raceStart.getTime())){
      alert('Enter a valid race start time.');
      return null;
    }
    if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
      alert('Solent Currents mode needs a Portsmouth HW time from EasyTide.');
      return null;
    }

    const courseClone = course.filter(validPoint).map((m,i)=>({
      id:m.id || `course_${i}`, name:m.name || `Mark ${i+1}`, lat:Number(m.lat), lon:Number(m.lon), custom:!!m.custom
    }));

    let simTime = new Date(simCfg.raceStart.getTime());
    let state = {lat:courseClone[0].lat, lon:courseClone[0].lon};
    const legSims = [];
    const fullTrack = [];

    for(let i=0; i<courseClone.length-1; i++){
      const from = {lat:state.lat, lon:state.lon};
      const to = courseClone[i+1];
      const bearing = bearingDeg(from, to);
      const signed = norm180(bearing - inputs.twd);
      const mode = legMode(Math.abs(signed));
      const target = targetFor(mode, inputs, signed);
      const legStartTime = new Date(simTime.getTime());

      let sim;
      if(mode === 'reach'){
        sim = gtSimFreeLeg(from, to, inputs, simCfg, simTime, target);
      } else {
        sim = gtSearchTwoBoardRoute(from, to, mode, target, inputs, simCfg, simTime);
        if(!sim) sim = gtSimFreeLeg(from, to, inputs, simCfg, simTime, target);
      }

      simTime = new Date(sim.endTime.getTime());
      state = {lat:to.lat, lon:to.lon};

      sim.track.forEach(pt => {
        if(pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lon)){
          fullTrack.push({...pt, legIndex:i});
        }
      });

      legSims.push({
        legIndex:i,
        from:course[i],
        to:course[i+1],
        mode,
        startTime:legStartTime,
        finishTime:new Date(simTime.getTime()),
        elapsedSec:sim.elapsedSec,
        portSec:sim.portSec,
        stbdSec:sim.stbdSec,
        directSec:sim.directSec || 0,
        guardLimited:sim.guardLimited,
        track:sim.track
      });
    }

    lastSimulation = {
      startTime:simCfg.raceStart,
      finishTime:new Date(simTime.getTime()),
      elapsedSec:(simTime.getTime() - simCfg.raceStart.getTime()) / 1000,
      legs:legSims,
      track:fullTrack,
      note:'candidate-ground-track-router'
    };

    const staticResults = predict();
    renderCourseList();
    renderTable(staticResults);
    renderMap(staticResults);
    return lastSimulation;
  };

  simulateCourse.__groundTrackRouterWrapped = true;
}


// ---------------- Current arrow outline styling ----------------
if(typeof drawCurrentArrows === 'function' && !drawCurrentArrows.__outlinedArrowsWrapped){
  const __drawCurrentArrowsBase = drawCurrentArrows;

  // Replace by wrapping Leaflet polyline creation is awkward, so provide helper functions
  // used by the final override below if the original draw function remains available.
  function addOutlinedCurrentArrow(layer, start, end, colour, weight, tooltipHtml){
    L.polyline([[start.lat,start.lon],[end.lat,end.lon]], {
      color:'#050505',
      weight:weight + 2,
      opacity:0.9
    }).addTo(layer);

    L.polyline([[start.lat,start.lon],[end.lat,end.lon]], {
      color:colour,
      weight:weight,
      opacity:0.92
    }).bindTooltip(tooltipHtml, {sticky:true}).addTo(layer);
  }

  drawCurrentArrows = function(){
    if(!map) return;
    if(!currentArrowLayer) currentArrowLayer = L.layerGroup().addTo(map);
    currentArrowLayer.clearLayers();

    const time = currentOverlayDate();

    if(!currentArrowsVisible || !tideDb?.records?.length){
      updateCurrentOverlayStatus(0, time, false);
      return;
    }

    const bounds = map.getBounds();
    const zoom = map.getZoom();
    const maxArrows = zoom >= 13 ? 240 : zoom >= 11 ? 160 : 90;

    const visible = tideDb.records
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && bounds.pad(0.25).contains([p.lat, p.lon]))
      .sort((a,b) => (a.lat-b.lat) || (a.lon-b.lon));

    const step = Math.max(1, Math.ceil(visible.length / maxArrows));
    let count = 0;

    for(let i=0; i<visible.length; i+=step){
      const p = visible[i];
      const v = currentVectorAtPointRecord(p, time);
      if(!v || v.drift < 0.03) continue;

      const end = arrowEndLatLng(p.lat, p.lon, v.set, v.drift);
      const colour = currentArrowColour(v.drift);
      const weight = Math.min(11.25, 3.375 + v.drift * 2.25);

      const tip = `${p.id || 'Current'}<br>${v.set.toFixed(0)}°T @ ${v.drift.toFixed(2)} kn<br>${v.hoursFromHw.toFixed(1)}h from Portsmouth HW`;

      addOutlinedCurrentArrow(currentArrowLayer, {lat:p.lat, lon:p.lon}, end, colour, weight, tip);

      // Arrow head outline then colour
      const bearing = bearingDeg({lat:p.lat, lon:p.lon}, end);
      const lenNm = Math.min(0.032, Math.max(0.010, distanceNm({lat:p.lat, lon:p.lon}, end) * 0.28));
      const left = destinationPointNm(end, norm360(bearing + 155), lenNm);
      const right = destinationPointNm(end, norm360(bearing - 155), lenNm);

      L.polyline([[left.lat,left.lon],[end.lat,end.lon],[right.lat,right.lon]], {
        color:'#050505', weight:5, opacity:0.9
      }).addTo(currentArrowLayer);
      L.polyline([[left.lat,left.lon],[end.lat,end.lon],[right.lat,right.lon]], {
        color:colour, weight:3, opacity:0.95
      }).addTo(currentArrowLayer);

      L.circleMarker([p.lat,p.lon], {
        radius: 3,
        color: '#050505',
        fillColor: colour,
        fillOpacity: 0.85,
        weight: 1
      }).addTo(currentArrowLayer);

      count += 1;
    }

    updateCurrentOverlayStatus(count, time, true);
  };

  drawCurrentArrows.__outlinedArrowsWrapped = true;
}


// ---------------- Single-piece current arrow polygons ----------------
// Replace separate shaft/head current arrows with one filled arrow polygon.
// Compared with the previous build: 50% longer and 50% narrower, keeping a thin black border.
function buildCurrentArrowPolygon(start, setDegTo, driftKt){
  // Previous final scale was drift * 0.07. Restore +50% length => 0.105.
  const lengthNm = Math.max(0.011, driftKt * 0.105);

  // Width is visual in nautical miles. 50% narrower than previous fat line.
  const shaftHalfWidthNm = Math.max(0.00525, Math.min(0.018, (0.0028 + driftKt * 0.0018) * 1.5));
  const headLengthNm = Math.max(lengthNm * 0.28, 0.018);
  const headHalfWidthNm = shaftHalfWidthNm * 2.25;

  const brg = setDegTo;
  const left = norm360(brg - 90);
  const right = norm360(brg + 90);

  const tail = start;
  const tip = destinationPointNm(start, brg, lengthNm);
  const neck = destinationPointNm(start, brg, Math.max(0, lengthNm - headLengthNm));

  const tailL = destinationPointNm(tail, left, shaftHalfWidthNm);
  const neckL = destinationPointNm(neck, left, shaftHalfWidthNm);
  const headL = destinationPointNm(neck, left, headHalfWidthNm);
  const headR = destinationPointNm(neck, right, headHalfWidthNm);
  const neckR = destinationPointNm(neck, right, shaftHalfWidthNm);
  const tailR = destinationPointNm(tail, right, shaftHalfWidthNm);

  return [tailL, neckL, headL, tip, headR, neckR, tailR].map(p => [p.lat, p.lon]);
}

if(typeof drawCurrentArrows === 'function' && !drawCurrentArrows.__singlePolygonArrowWrapped){
  drawCurrentArrows = function(){
    if(!map) return;
    if(!currentArrowLayer) currentArrowLayer = L.layerGroup().addTo(map);
    currentArrowLayer.clearLayers();

    const time = currentOverlayDate();

    if(!currentArrowsVisible || !tideDb?.records?.length){
      updateCurrentOverlayStatus(0, time, false);
      return;
    }

    const bounds = map.getBounds();
    const zoom = map.getZoom();
    const maxArrows = zoom >= 13 ? 240 : zoom >= 11 ? 160 : 90;

    const visible = tideDb.records
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && bounds.pad(0.25).contains([p.lat, p.lon]))
      .sort((a,b) => (a.lat-b.lat) || (a.lon-b.lon));

    const step = Math.max(1, Math.ceil(visible.length / maxArrows));
    let count = 0;

    for(let i=0; i<visible.length; i+=step){
      const p = visible[i];
      const v = currentVectorAtPointRecord(p, time);
      if(!v || v.drift < 0.03) continue;

      const colour = currentArrowColour(v.drift);
      const poly = buildCurrentArrowPolygon({lat:p.lat, lon:p.lon}, v.set, v.drift);
      const tip = `${p.id || 'Current'}<br>${v.set.toFixed(0)}°T @ ${v.drift.toFixed(2)} kn<br>${v.hoursFromHw.toFixed(1)}h from Portsmouth HW`;

      L.polygon(poly, {
        color:'#050505',
        weight:1.6,
        opacity:0.96,
        fillColor:colour,
        fillOpacity:0.88,
        interactive:true
      }).bindTooltip(tip, {sticky:true}).addTo(currentArrowLayer);

      count += 1;
    }

    updateCurrentOverlayStatus(count, time, true);
  };

  drawCurrentArrows.__singlePolygonArrowWrapped = true;
}


// ---------------- Land-mask routing note ----------------
// A static mobile PWA should not live-query OSM/Overpass during routing.
// Correct future implementation:
// 1) ship a simplified Solent land/coastline GeoJSON generated from OSM/coastline data,
// 2) load it as a Leaflet layer,
// 3) test candidate route segments against those polygons,
// 4) reject or penalise any candidate crossing land.
// The simulator currently does not enforce a land mask.
let landMaskGeoJson = null;
function routeSegmentCrossesLand(a, b){
  // Placeholder for future local GeoJSON point/segment-in-polygon test.
  // Returns false until a simplified land mask is bundled.
  return false;
}


// ---------------- Local Solent land-mask routing ----------------
// Uses bundled solent_land_mask.geojson converted from the supplied Expedition Solent Outline XML. This local mask is suitable for
// mobile/PWA use. It rejects/penalises candidate simulation segments that cross obvious land.
let solentLandMask = null;
let solentLandMaskLayer = null;
let showLandMaskDebug = false;

async function loadSolentLandMask(){
  try{
    const res = await fetch('solent_land_mask.geojson', {cache:'no-store'});
    if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    solentLandMask = await res.json();
    if(showLandMaskDebug && map && typeof L !== 'undefined'){
      if(solentLandMaskLayer) solentLandMaskLayer.remove();
      solentLandMaskLayer = L.geoJSON(solentLandMask, {
        style:{color:'#111', weight:1, fillColor:'#000', fillOpacity:0.12}
      }).addTo(map);
    }
    console.log('Solent land mask loaded', solentLandMask?.features?.length || 0);
  }catch(err){
    console.warn('Solent land mask failed to load', err);
  }
}

function pointInRing(lon, lat, ring){
  let inside = false;
  for(let i=0, j=ring.length-1; i<ring.length; j=i++){
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
    if(intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonFeature(lat, lon, feature){
  const geom = feature?.geometry;
  if(!geom) return false;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] :
                geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for(const poly of polys){
    if(!poly?.length) continue;
    if(!pointInRing(lon, lat, poly[0])) continue;
    // holes
    let inHole = false;
    for(let i=1; i<poly.length; i++){
      if(pointInRing(lon, lat, poly[i])) { inHole = true; break; }
    }
    if(!inHole) return true;
  }
  return false;
}

function pointIsLand(lat, lon){
  if(!solentLandMask?.features?.length) return false;
  return solentLandMask.features.some(f => pointInPolygonFeature(lat, lon, f));
}

function segmentCrossesLand(a, b){
  if(!solentLandMask?.features?.length) return false;
  const dist = distanceNm(a, b);
  const n = Math.max(2, Math.ceil(dist / 0.03)); // sample every ~55m
  const brg = bearingDeg(a, b);
  for(let i=0; i<=n; i++){
    const p = destinationPointNm(a, brg, dist * i / n);
    if(pointIsLand(p.lat, p.lon)) return true;
  }
  return false;
}

// Override placeholder routeSegmentCrossesLand if present.
routeSegmentCrossesLand = function(a,b){
  return segmentCrossesLand(a,b);
};

// Penalise candidate route simulation if it crosses land.
// This wraps advance helpers and route scorers without hard-failing the UI.
if(typeof gtSimTwoBoardCandidate === 'function' && !gtSimTwoBoardCandidate.__landMaskWrapped){
  const __gtSimTwoBoardCandidateBase = gtSimTwoBoardCandidate;
  gtSimTwoBoardCandidate = function(...args){
    const c = __gtSimTwoBoardCandidateBase(...args);
    if(c?.track?.length){
      let crosses = false;
      for(let i=1; i<c.track.length; i++){
        const a = c.track[i-1], b = c.track[i];
        if(a?.guardSnap || b?.guardSnap) continue;
        if(segmentCrossesLand(a,b)){ crosses = true; break; }
      }
      if(crosses){
        c.crossesLand = true;
        c.scoreSec += 999999; // effectively reject if alternatives exist
        c.guardLimited = true;
      }
    }
    return c;
  };
  gtSimTwoBoardCandidate.__landMaskWrapped = true;
}

if(typeof gtSimFreeLeg === 'function' && !gtSimFreeLeg.__landMaskWrapped){
  const __gtSimFreeLegBase = gtSimFreeLeg;
  gtSimFreeLeg = function(...args){
    const c = __gtSimFreeLegBase(...args);
    if(c?.track?.length){
      let crosses = false;
      for(let i=1; i<c.track.length; i++){
        const a = c.track[i-1], b = c.track[i];
        if(a?.guardSnap || b?.guardSnap) continue;
        if(segmentCrossesLand(a,b)){ crosses = true; break; }
      }
      if(crosses){
        c.crossesLand = true;
        c.scoreSec = (c.scoreSec || c.elapsedSec || 0) + 999999;
        c.guardLimited = true;
      }
    }
    return c;
  };
  gtSimFreeLeg.__landMaskWrapped = true;
}

window.addEventListener('DOMContentLoaded', () => {
  loadSolentLandMask();
});


// ---------------- Waypoint overshoot guard + visible land mask ----------------
// The candidate ground-track router can overshoot the mark if the last step carries it
// beyond the finish circle. This guard clips each simulated leg at first closest approach
// and forces the visual end point exactly onto the waypoint, without allowing a jump beyond.

function closestPointFractionOnSegmentToPoint(a, b, p){
  // Equirectangular local projection in nautical-mile-ish coordinates.
  const lat0 = ((a.lat + b.lat + p.lat) / 3) * RAD;
  const ax = a.lon * 60 * Math.cos(lat0), ay = a.lat * 60;
  const bx = b.lon * 60 * Math.cos(lat0), by = b.lat * 60;
  const px = p.lon * 60 * Math.cos(lat0), py = p.lat * 60;
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const vv = vx*vx + vy*vy || 1e-12;
  return Math.max(0, Math.min(1, (wx*vx + wy*vy) / vv));
}

function interpolateLatLon(a, b, f){
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f
  };
}

function trackCrossesWaypoint(prev, next, mark, radiusNm=0.025){
  const f = closestPointFractionOnSegmentToPoint(prev, next, mark);
  const cp = interpolateLatLon(prev, next, f);
  const d = distanceNm(cp, mark);
  return d <= radiusNm || distanceNm(next, mark) <= radiusNm;
}

function trimTrackAtWaypoint(track, mark){
  if(!Array.isArray(track) || track.length < 2) return track || [];
  const out = [track[0]];

  for(let i=1; i<track.length; i++){
    const prev = out[out.length - 1];
    const next = track[i];

    if(prev?.guardSnap || next?.guardSnap){
      continue;
    }

    if(trackCrossesWaypoint(prev, next, mark)){
      out.push({
        ...next,
        lat: mark.lat,
        lon: mark.lon,
        guardSnap: false,
        clippedAtWaypoint: true
      });
      return out;
    }

    out.push(next);
  }

  // If never crossed, only snap if already very close; otherwise keep track but append mark.
  const last = out[out.length - 1];
  if(last && distanceNm(last, mark) <= 0.08){
    out.push({...last, lat:mark.lat, lon:mark.lon, clippedAtWaypoint:true});
  } else if(last) {
    out.push({...last, lat:mark.lat, lon:mark.lon, guardSnap:true});
  }
  return out;
}

if(typeof gtSimTwoBoardCandidate === 'function' && !gtSimTwoBoardCandidate.__overshootGuardWrapped){
  const __gtSimTwoBoardCandidateOvershootBase = gtSimTwoBoardCandidate;
  gtSimTwoBoardCandidate = function(start, mark, ...rest){
    const c = __gtSimTwoBoardCandidateOvershootBase(start, mark, ...rest);
    if(c?.track?.length){
      c.track = trimTrackAtWaypoint(c.track, mark);
      const last = c.track[c.track.length - 1];
      if(last){
        c.finalDist = distanceNm(last, mark);
        c.guardLimited = !!last.guardSnap;
        if(!c.guardLimited) c.scoreSec = Math.min(c.scoreSec || c.elapsedSec || 0, c.elapsedSec || c.scoreSec || 0);
      }
    }
    return c;
  };
  gtSimTwoBoardCandidate.__overshootGuardWrapped = true;
}

if(typeof gtSimFreeLeg === 'function' && !gtSimFreeLeg.__overshootGuardWrapped){
  const __gtSimFreeLegOvershootBase = gtSimFreeLeg;
  gtSimFreeLeg = function(start, mark, ...rest){
    const c = __gtSimFreeLegOvershootBase(start, mark, ...rest);
    if(c?.track?.length){
      c.track = trimTrackAtWaypoint(c.track, mark);
      const last = c.track[c.track.length - 1];
      if(last){
        c.finalDist = distanceNm(last, mark);
        c.guardLimited = !!last.guardSnap;
      }
    }
    return c;
  };
  gtSimFreeLeg.__overshootGuardWrapped = true;
}

// Make land mask visible by default once loaded.
function showSolentLandMaskOnChart(){
  try{
    if(!map || !solentLandMask || typeof L === 'undefined') return;
    if(solentLandMaskLayer) return;
    solentLandMaskLayer = L.geoJSON(solentLandMask, {
      pane: 'overlayPane',
      style: {
        color: '#050505',
        weight: 1,
        fillColor: '#111827',
        fillOpacity: 0.34,
        opacity: 0.8
      },
      interactive: false
    }).addTo(map);
  }catch(err){
    console.warn('showSolentLandMaskOnChart failed', err);
  }
}

if(typeof loadSolentLandMask === 'function' && !loadSolentLandMask.__visibleWrapped){
  const __loadSolentLandMaskVisibleBase = loadSolentLandMask;
  loadSolentLandMask = async function(){
    await __loadSolentLandMaskVisibleBase();
    setTimeout(showSolentLandMaskOnChart, 250);
  };
  loadSolentLandMask.__visibleWrapped = true;
}

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(showSolentLandMaskOnChart, 1000);
});


// ---------------- Hard route guard: no land crossing, no mark overshoot ----------------
// This final-stage guard fixes two failure modes:
// 1) route candidate can cross land because land rejection happened too late/softly
// 2) route drawing can overshoot the mark then append a snap-to-mark point
//
// The guard sanitises every candidate track immediately after generation.
// If a candidate crosses land it is rejected with infinite score.
// If a candidate crosses the waypoint circle it is clipped at the waypoint.

function hardLocalXY(ref, p){
  const lat0 = ref.lat * RAD;
  return {
    x: (p.lon - ref.lon) * 60 * Math.cos(lat0),
    y: (p.lat - ref.lat) * 60
  };
}

function hardClosestFraction(a, b, p){
  const ar = hardLocalXY(a, a);
  const br = hardLocalXY(a, b);
  const pr = hardLocalXY(a, p);
  const vx = br.x - ar.x, vy = br.y - ar.y;
  const wx = pr.x - ar.x, wy = pr.y - ar.y;
  const vv = vx*vx + vy*vy || 1e-12;
  return Math.max(0, Math.min(1, (wx*vx + wy*vy) / vv));
}

function hardInterp(a, b, f){
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f
  };
}

function hardSegmentMinDistNm(a, b, p){
  const f = hardClosestFraction(a, b, p);
  const q = hardInterp(a, b, f);
  return {dist: distanceNm(q, p), frac:f, point:q};
}

function hardSegmentCrossesWaypoint(a, b, mark, radiusNm=0.03){
  const closest = hardSegmentMinDistNm(a, b, mark);
  return closest.dist <= radiusNm || distanceNm(b, mark) <= radiusNm;
}

function hardSegmentCrossesLand(a, b){
  if(typeof segmentCrossesLand === 'function') return segmentCrossesLand(a, b);
  if(typeof routeSegmentCrossesLand === 'function') return routeSegmentCrossesLand(a, b);
  return false;
}

function hardTrackCrossesLand(track){
  if(!Array.isArray(track) || track.length < 2) return false;
  for(let i=1; i<track.length; i++){
    const a = track[i-1], b = track[i];
    if(!a || !b || a.guardSnap || b.guardSnap) continue;
    if(!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) continue;
    if(hardSegmentCrossesLand(a,b)) return true;
  }
  return false;
}

function hardTrimTrackAtMark(track, mark){
  if(!Array.isArray(track) || track.length < 2) return track || [];
  const out = [track[0]];

  for(let i=1; i<track.length; i++){
    const prev = out[out.length - 1];
    const next = track[i];
    if(!prev || !next) continue;

    if(hardSegmentCrossesWaypoint(prev, next, mark)){
      const closest = hardSegmentMinDistNm(prev, next, mark);
      const clipped = {
        ...next,
        lat: mark.lat,
        lon: mark.lon,
        clippedAtWaypoint: true,
        guardSnap: false
      };

      // Preserve approximate clipped time by interpolating between prev and next.
      if(prev.time && next.time){
        const t0 = new Date(prev.time).getTime();
        const t1 = new Date(next.time).getTime();
        if(Number.isFinite(t0) && Number.isFinite(t1)){
          clipped.time = new Date(t0 + (t1 - t0) * closest.frac);
        }
      }

      out.push(clipped);
      return out;
    }

    out.push(next);
  }

  // Do NOT draw a long snap line from a missed route to the mark.
  // Return the actual track only; candidate will be penalised/rejected by final distance.
  return out;
}

function hardSanitiseCandidate(candidate, mark){
  if(!candidate || !Array.isArray(candidate.track)) return candidate;

  candidate.track = hardTrimTrackAtMark(candidate.track, mark);

  const last = candidate.track[candidate.track.length - 1];
  const finalDist = last ? distanceNm(last, mark) : Infinity;
  const crossesLand = hardTrackCrossesLand(candidate.track);

  candidate.finalDist = finalDist;
  candidate.crossesLand = crossesLand;

  if(crossesLand){
    candidate.scoreSec = Infinity;
    candidate.guardLimited = true;
    candidate.rejectedReason = 'crosses land';
    return candidate;
  }

  if(finalDist > 0.05){
    candidate.scoreSec = (candidate.scoreSec || candidate.elapsedSec || 0) + finalDist * 7200 + 1800;
    candidate.guardLimited = true;
    candidate.rejectedReason = 'missed mark';
  } else {
    candidate.guardLimited = false;
    // If clipped, make elapsed roughly match clipped final point time.
    if(last?.time && candidate.track[0]?.time){
      const t0 = new Date(candidate.track[0].time).getTime();
      const t1 = new Date(last.time).getTime();
      if(Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0){
        candidate.elapsedSec = (t1 - t0) / 1000;
        candidate.endTime = new Date(t1);
      }
    }
  }

  return candidate;
}

if(typeof gtSimTwoBoardCandidate === 'function' && !gtSimTwoBoardCandidate.__hardRouteGuardWrapped){
  const __gtSimTwoBoardCandidateHardBase = gtSimTwoBoardCandidate;
  gtSimTwoBoardCandidate = function(start, mark, ...rest){
    const c = __gtSimTwoBoardCandidateHardBase(start, mark, ...rest);
    return hardSanitiseCandidate(c, mark);
  };
  gtSimTwoBoardCandidate.__hardRouteGuardWrapped = true;
}

if(typeof gtSimFreeLeg === 'function' && !gtSimFreeLeg.__hardRouteGuardWrapped){
  const __gtSimFreeLegHardBase = gtSimFreeLeg;
  gtSimFreeLeg = function(start, mark, ...rest){
    const c = __gtSimFreeLegHardBase(start, mark, ...rest);
    return hardSanitiseCandidate(c, mark);
  };
  gtSimFreeLeg.__hardRouteGuardWrapped = true;
}

if(typeof gtSearchTwoBoardRoute === 'function' && !gtSearchTwoBoardRoute.__hardRouteGuardWrapped){
  const __gtSearchTwoBoardRouteHardBase = gtSearchTwoBoardRoute;
  gtSearchTwoBoardRoute = function(start, mark, ...rest){
    const c = __gtSearchTwoBoardRouteHardBase(start, mark, ...rest);
    if(c && (!Number.isFinite(c.scoreSec) || c.crossesLand)){
      // Existing search selected a bad candidate; force a fallback by returning null.
      return null;
    }
    return hardSanitiseCandidate(c, mark);
  };
  gtSearchTwoBoardRoute.__hardRouteGuardWrapped = true;
}

// Final visual safety: never draw guardSnap long lines to a mark.
if(typeof renderMap === 'function' && !renderMap.__noGuardSnapLinesWrapped){
  const __renderMapNoSnapBase = renderMap;
  renderMap = function(results=[]){
    if(lastSimulation?.legs?.length){
      lastSimulation.legs.forEach(leg => {
        if(Array.isArray(leg.track)){
          leg.track = leg.track.filter((pt, idx, arr) => {
            // Remove snap points that create artificial long segments.
            if(pt?.guardSnap) return false;
            return true;
          });
        }
      });
    }
    __renderMapNoSnapBase(results);
  };
  renderMap.__noGuardSnapLinesWrapped = true;
}


// ---------------- Static/basic prediction uses selected current source ----------------
// If Current Source = Solent Currents, the basic table should use .tdm current for each leg,
// not the manual Current set/drift inputs. Manual current fields are hidden unless Current Source=manual.

function staticLegCurrentFor(from, to, legIndex, raceStartTime){
  const source = $('currentSource')?.value || 'manual';
  const inputs = readInputs();

  if(source !== 'tdm' || !tideDb?.records?.length || !portsmouthHwTime){
    return {set: inputs.set, drift: inputs.drift, source:'manual'};
  }

  const mid = {
    lat: (Number(from.lat) + Number(to.lat)) / 2,
    lon: (Number(from.lon) + Number(to.lon)) / 2
  };

  // Approximate static leg time reference:
  // use race start plus accumulated prior static leg estimate if available, otherwise race start.
  let t = raceStartTime || readSimulationInputs?.().raceStart || new Date();
  if(!(t instanceof Date) || Number.isNaN(t.getTime())) t = new Date();

  return getTdmCurrentAt(mid.lat, mid.lon, t);
}

function inputsWithCurrent(inputs, current){
  return {
    ...inputs,
    set: Number(current?.set ?? inputs.set),
    drift: Number(current?.drift ?? inputs.drift)
  };
}

// Override predict() so static/basic table current matches selected source.
if(typeof predict === 'function' && !predict.__selectedCurrentWrapped){
  predict = function(){
    const inputs = readInputs();
    if(!Array.isArray(course) || course.length < 2) return [];

    let t = readSimulationInputs?.().raceStart || new Date();
    if(!(t instanceof Date) || Number.isNaN(t.getTime())) t = new Date();

    const out = [];

    for(let i=0; i<course.length-1; i++){
      const from = course[i], to = course[i+1];
      const dist = distanceNm(from, to);
      const brg = bearingDeg(from, to);
      const signed = norm180(brg - inputs.twd);
      const mode = legMode(Math.abs(signed));

      const current = staticLegCurrentFor(from, to, i, t);
      const legInputs = inputsWithCurrent(inputs, current);

      const target = targetFor(mode, legInputs, signed);
      const sol = mode === 'reach'
        ? solveReachLeg(dist, brg, target, legInputs)
        : solveTwoBoardLeg(dist, brg, mode, target, legInputs);

      const totalSec = (sol.totalHours || 0) * 3600;
      t = new Date(t.getTime() + totalSec * 1000);

      out.push({
        from, to, dist, brg, mode, target,
        portHours: sol.portHours || 0,
        stbdHours: sol.stbdHours || 0,
        totalHours: sol.totalHours || 0,
        cts: sol.cts || '',
        current
      });
    }

    return out;
  };
  predict.__selectedCurrentWrapped = true;
}

function syncManualCurrentVisibility(){
  const manual = ($('currentSource')?.value || 'manual') !== 'tdm';
  document.querySelectorAll('.manual-current-field').forEach(el => {
    el.style.display = manual ? '' : 'none';
  });

  // Keep status clear for selected source.
  if(!manual && tideDb?.records?.length){
    setTideStatus?.(`Solent Currents selected: static/basic table and simulator use .tdm current. Manual current inputs hidden.`);
  }
}

function bindManualCurrentVisibility(){
  $('currentSource')?.addEventListener('change', () => {
    syncManualCurrentVisibility();
    updateAll?.();
  });
  setTimeout(syncManualCurrentVisibility, 250);
}

window.addEventListener('DOMContentLoaded', bindManualCurrentVisibility);


// ---------------- Two-board zero-current / symmetric split fix ----------------
// Bug: the ground-track candidate simulator could choose an all-starboard route on a
// normal upwind/downwind leg, especially when current=0, because candidate scoring allowed
// missed-mark/snap routes to survive. This patch adds an analytic zero/low-current route
// candidate that exactly follows the basic two-board solution and makes guard/snap routes
// unable to beat valid split routes.

function analyticTwoBoardTrack(start, mark, mode, target, inputs, startTime, simCfg, firstBoard, current){
  const bearing = bearingDeg(start, mark);
  const dist = distanceNm(start, mark);
  const plan = solveCurrentAwareTwoBoardRemaining(dist, bearing, mode, target, inputs, current.set, current.drift);
  const hdg = tackHeadings(mode, inputs.twd, target.twa);

  const firstSec = (firstBoard === 'port' ? plan.portHours : plan.stbdHours) * 3600;
  const secondBoard = firstBoard === 'port' ? 'stbd' : 'port';
  const secondSec = (secondBoard === 'port' ? plan.portHours : plan.stbdHours) * 3600;

  if(firstSec < 1 || secondSec < 1) return null;

  const h1 = firstBoard === 'port' ? hdg.port : hdg.stbd;
  const h2 = secondBoard === 'port' ? hdg.port : hdg.stbd;

  let t = new Date(startTime.getTime());
  let p = {lat:start.lat, lon:start.lon};
  const track = [{lat:p.lat, lon:p.lon, time:new Date(t.getTime()), mode:firstBoard, heading:h1}];

  function addSegment(board, heading, durationSec){
    let remaining = durationSec;
    while(remaining > 0.001){
      const dt = Math.min(simCfg.stepSec, remaining);
      const c = current; // analytic route assumes static current for the leg
      const adv = gtAdvance ? gtAdvance(p, heading, target.bsp, c, dt) : (function(){
        const g = addVec(vecFrom(heading, target.bsp), currentToVector(c.set, c.drift));
        const cog = norm360(Math.atan2(g.x, g.y) * DEG);
        const sog = Math.hypot(g.x, g.y);
        return {next:destinationPointNm(p, cog, sog * dt / 3600), cog, sog};
      })();

      t = new Date(t.getTime() + dt * 1000);
      p = {lat:adv.next.lat, lon:adv.next.lon};
      track.push({
        lat:p.lat, lon:p.lon, time:new Date(t.getTime()),
        mode:board, heading, cog:adv.cog, sog:adv.sog,
        bsp:target.bsp, current:c
      });
      remaining -= dt;
    }
  }

  addSegment(firstBoard, h1, firstSec);

  if(simCfg.tackPenaltySec > 0){
    t = new Date(t.getTime() + simCfg.tackPenaltySec * 1000);
  }

  addSegment(secondBoard, h2, secondSec);

  // Analytic solution should arrive at the mark; force final coordinate to remove tiny integration error.
  const last = track[track.length - 1];
  if(last){
    last.lat = mark.lat;
    last.lon = mark.lon;
    last.clippedAtWaypoint = true;
  }

  const elapsed = firstSec + secondSec + (simCfg.tackPenaltySec || 0);

  return {
    firstBoard,
    secondBoard,
    firstPhaseSec:firstSec,
    track,
    elapsedSec:elapsed,
    portSec:(firstBoard === 'port' ? firstSec : 0) + (secondBoard === 'port' ? secondSec : 0) + (secondBoard === 'port' ? (simCfg.tackPenaltySec || 0) : 0),
    stbdSec:(firstBoard === 'stbd' ? firstSec : 0) + (secondBoard === 'stbd' ? secondSec : 0) + (secondBoard === 'stbd' ? (simCfg.tackPenaltySec || 0) : 0),
    directSec:0,
    endTime:new Date(startTime.getTime() + elapsed * 1000),
    finalDist:0,
    guardLimited:false,
    scoreSec:elapsed,
    pass:'analytic'
  };
}

if(typeof gtSearchTwoBoardRoute === 'function' && !gtSearchTwoBoardRoute.__zeroCurrentSplitWrapped){
  const __gtSearchTwoBoardRoutePrev = gtSearchTwoBoardRoute;

  gtSearchTwoBoardRoute = function(start, mark, mode, target, inputs, simCfg, startTime){
    const current = getTdmCurrentAt(start.lat, start.lon, startTime);
    const bearing = bearingDeg(start, mark);
    const dist = distanceNm(start, mark);

    // Build analytic split candidates first. In zero current this should match the basic table.
    const analytic = ['port','stbd']
      .map(first => analyticTwoBoardTrack(start, mark, mode, target, inputs, startTime, simCfg, first, current))
      .filter(Boolean);

    // Also keep the previous curved candidate search for real tide/land cases.
    const oldCandidate = __gtSearchTwoBoardRoutePrev(start, mark, mode, target, inputs, simCfg, startTime);
    const candidates = [...analytic];

    if(oldCandidate && !oldCandidate.crossesLand && !oldCandidate.guardLimited && (oldCandidate.finalDist ?? 0) < 0.06){
      candidates.push(oldCandidate);
    }

    // Reject all-one-board results on two-board legs unless the analytic plan truly says one board.
    const valid = candidates.filter(c => {
      if(!c || !Number.isFinite(c.scoreSec)) return false;
      if(c.crossesLand || c.guardLimited) return false;
      const p = c.portSec || 0, s = c.stbdSec || 0;
      return p > 1 && s > 1;
    });

    if(!valid.length) return analytic.sort((a,b)=>a.scoreSec-b.scoreSec)[0] || oldCandidate || null;
    valid.sort((a,b)=>a.scoreSec-b.scoreSec);
    return valid[0];
  };

  gtSearchTwoBoardRoute.__zeroCurrentSplitWrapped = true;
}

// Final table/render safety: when sim result is a valid two-board leg, do not display
// a one-board-only artefact if basic predicts both boards.
if(typeof simulateCourse === 'function' && !simulateCourse.__twoBoardSanityWrapped){
  const __simulateCourseTwoBoardSanityPrev = simulateCourse;

  simulateCourse = function(){
    const sim = __simulateCourseTwoBoardSanityPrev();

    try{
      const inputs = readInputs();
      if(sim?.legs?.length){
        sim.legs.forEach((leg, idx) => {
          if(!leg || leg.mode === 'reach') return;
          const from = course[idx], to = course[idx+1];
          if(!from || !to) return;
          const dist = distanceNm(from,to);
          const brg = bearingDeg(from,to);
          const signed = norm180(brg - inputs.twd);
          const target = targetFor(leg.mode, inputs, signed);
          const current = staticLegCurrentFor ? staticLegCurrentFor(from,to,idx,leg.startTime) : {set:inputs.set, drift:inputs.drift};
          const legInputs = inputsWithCurrent ? inputsWithCurrent(inputs,current) : {...inputs,set:current.set,drift:current.drift};
          const basic = solveTwoBoardLeg(dist, brg, leg.mode, target, legInputs);

          if((basic.portHours || 0) > 0.001 && (basic.stbdHours || 0) > 0.001){
            if((leg.portSec || 0) < 1 || (leg.stbdSec || 0) < 1){
              const corrected = analyticTwoBoardTrack(
                {lat:from.lat, lon:from.lon},
                {lat:to.lat, lon:to.lon},
                leg.mode, target, legInputs, leg.startTime || sim.startTime,
                readSimulationInputs(), 'port', current
              );
              if(corrected){
                Object.assign(leg, {
                  elapsedSec: corrected.elapsedSec,
                  portSec: corrected.portSec,
                  stbdSec: corrected.stbdSec,
                  directSec:0,
                  finishTime: corrected.endTime,
                  guardLimited:false,
                  track: corrected.track
                });
              }
            }
          }
        });

        sim.elapsedSec = sim.legs.reduce((s,l)=>s+(l.elapsedSec||0),0);
        lastSimulation = sim;
        const staticResults = predict();
        renderTable(staticResults);
        renderMap(staticResults);
      }
    }catch(err){
      console.warn('two-board sanity correction failed', err);
    }

    return sim;
  };

  simulateCourse.__twoBoardSanityWrapped = true;
}


// ---------------- Constrained route-search simulator ----------------
// This replaces the unstable candidate-leg heuristic with a constrained search.
// It searches over boat states: position + time + board, rejects land-crossing moves
// immediately, and stops as soon as the route enters the mark capture radius.
// It is deliberately local and bounded so it remains phone/PWA-friendly.

class TinyPriorityQueue {
  constructor(){ this.items = []; }
  push(item, priority){
    this.items.push({item, priority});
    let i = this.items.length - 1;
    while(i > 0){
      const p = Math.floor((i - 1) / 2);
      if(this.items[p].priority <= priority) break;
      [this.items[i], this.items[p]] = [this.items[p], this.items[i]];
      i = p;
    }
  }
  pop(){
    if(!this.items.length) return null;
    const root = this.items[0].item;
    const last = this.items.pop();
    if(this.items.length && last){
      this.items[0] = last;
      let i = 0;
      while(true){
        let l = i * 2 + 1, r = l + 1, s = i;
        if(l < this.items.length && this.items[l].priority < this.items[s].priority) s = l;
        if(r < this.items.length && this.items[r].priority < this.items[s].priority) s = r;
        if(s === i) break;
        [this.items[i], this.items[s]] = [this.items[s], this.items[i]];
        i = s;
      }
    }
    return root;
  }
  get length(){ return this.items.length; }
}

function crsSafeSegment(a, b){
  if(!a || !b) return false;
  if(!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return false;

  // Start/end on land or segment crossing land is illegal.
  if(typeof pointIsLand === 'function'){
    if(pointIsLand(a.lat, a.lon) || pointIsLand(b.lat, b.lon)) return false;
  }
  if(typeof segmentCrossesLand === 'function' && segmentCrossesLand(a,b)) return false;
  if(typeof routeSegmentCrossesLand === 'function' && routeSegmentCrossesLand(a,b)) return false;
  return true;
}

function crsClosestFractionOnSegment(a, b, p){
  const lat0 = ((a.lat + b.lat + p.lat) / 3) * RAD;
  const ax = a.lon * 60 * Math.cos(lat0), ay = a.lat * 60;
  const bx = b.lon * 60 * Math.cos(lat0), by = b.lat * 60;
  const px = p.lon * 60 * Math.cos(lat0), py = p.lat * 60;
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const vv = vx*vx + vy*vy || 1e-12;
  return Math.max(0, Math.min(1, (wx*vx + wy*vy) / vv));
}

function crsInterp(a, b, f){
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f
  };
}

function crsSegmentReachesMark(a, b, mark, radiusNm){
  const f = crsClosestFractionOnSegment(a, b, mark);
  const q = crsInterp(a, b, f);
  const d = distanceNm(q, mark);
  return d <= radiusNm ? {reaches:true, frac:f, point:{lat:mark.lat, lon:mark.lon}} : {reaches:false};
}

function crsGridKey(p, board, cellNm=0.06){
  // ~110m cells. Include board so port/stbd alternatives both survive.
  const latKey = Math.round((p.lat * 60) / cellNm);
  const lonKey = Math.round((p.lon * 60 * Math.cos(p.lat * RAD)) / cellNm);
  return `${latKey}:${lonKey}:${board || 'x'}`;
}

function crsCandidateActions(p, mark, mode, target, inputs, current){
  const bearing = bearingDeg(p, mark);

  if(mode === 'reach'){
    const signed = norm180(bearing - inputs.twd);
    const bsp = targetFor('reach', inputs, signed).bsp;
    const cts = solveCurrentCorrectedHeadingToMark(bearing, bsp, current.set, current.drift);
    const board = norm180(cts.heading - inputs.twd) < 0 ? 'port' : 'stbd';

    // Free leg: add direct current-corrected CTS plus small +/- trim actions.
    return [
      {board, heading:cts.heading, bsp, label:'cts'},
      {board, heading:norm360(cts.heading - 5), bsp, label:'cts-5'},
      {board, heading:norm360(cts.heading + 5), bsp, label:'cts+5'}
    ];
  }

  const localSigned = norm180(bearing - inputs.twd);
  const localTarget = targetFor(mode, inputs, localSigned);
  const hdg = tackHeadings(mode, inputs.twd, localTarget.twa);

  // For constrained routing, allow normal board headings and a couple of slightly cracked/soaked
  // variants to help escape land boundaries and converge to marks.
  const twas = [
    localTarget.twa,
    Math.max(25, localTarget.twa - 4),
    Math.min(175, localTarget.twa + 4)
  ];

  const actions = [];
  for(const twa of twas){
    const h = tackHeadings(mode, inputs.twd, twa);
    const bsp = inputs.usePolar ? (polarSpeed(inputs.tws, twa) * inputs.polarFactor) : localTarget.bsp;
    const useBsp = Number.isFinite(bsp) && bsp > 0 ? bsp : localTarget.bsp;
    actions.push({board:'port', heading:h.port, bsp:useBsp, label:`p${twa}`});
    actions.push({board:'stbd', heading:h.stbd, bsp:useBsp, label:`s${twa}`});
  }
  return actions;
}

function crsReconstruct(nodes, node){
  const out = [];
  let n = node;
  while(n){
    out.push(n);
    n = n.parentId != null ? nodes[n.parentId] : null;
  }
  return out.reverse();
}

function crsRouteLeg(start, mark, mode, target, inputs, simCfg, startTime){
  const startDist = distanceNm(start, mark);
  const captureRadiusNm = Math.max(0.025, Math.min(0.06, startDist * 0.015));
  const stepSec = Math.max(20, Math.min(120, Number(simCfg.stepSec || 60)));
  const maxNodes = 3500;
  const maxTimeSec = Math.max(1800, startDist / Math.max(0.1, target.bsp || 6) * 3600 * 3.2);
  const maxCorridorNm = Math.max(0.45, startDist * 0.75);
  const routeBearing0 = bearingDeg(start, mark);

  const pq = new TinyPriorityQueue();
  const nodes = [];
  const bestByCell = new Map();

  const startNode = {
    id:0,
    lat:start.lat,
    lon:start.lon,
    timeSec:0,
    absTime:new Date(startTime.getTime()),
    board:null,
    heading:null,
    cog:null,
    sog:0,
    bsp:0,
    current:null,
    parentId:null,
    tacks:0
  };
  nodes.push(startNode);
  pq.push(startNode, 0);
  bestByCell.set(crsGridKey(startNode, null), 0);

  let bestNear = startNode;
  let bestNearDist = startDist;
  let finishNode = null;
  let expanded = 0;

  while(pq.length && expanded < maxNodes){
    const n = pq.pop();
    expanded++;

    const p = {lat:n.lat, lon:n.lon};
    const dist = distanceNm(p, mark);

    if(dist < bestNearDist){
      bestNearDist = dist;
      bestNear = n;
    }

    if(dist <= captureRadiusNm){
      finishNode = {...n, lat:mark.lat, lon:mark.lon};
      break;
    }

    if(n.timeSec > maxTimeSec) continue;

    const progress = lineProgressNm ? lineProgressNm(start, routeBearing0, p) : startDist - dist;
    const cross = Math.abs(signedCrossTrackToLine ? signedCrossTrackToLine(start, routeBearing0, p) : 0);
    if(cross > maxCorridorNm && progress > 0.1) continue;

    const current = getTdmCurrentAt(n.lat, n.lon, n.absTime);
    const actions = crsCandidateActions(p, mark, mode, target, inputs, current);

    for(const a of actions){
      let dt = stepSec;
      let timePenalty = 0;

      if(n.board && a.board && n.board !== a.board){
        timePenalty += Number(simCfg.tackPenaltySec || 0);
        // Do not chatter.
        if(n.parentId != null){
          const parent = nodes[n.parentId];
          if(parent && parent.board && parent.board !== n.board && (n.timeSec - parent.timeSec) < Math.max(30, simCfg.minTackSec || 0)){
            continue;
          }
        }
      }

      const adv = gtAdvance ? gtAdvance(p, a.heading, a.bsp, current, dt) : (function(){
        const ground = addVec(vecFrom(a.heading, a.bsp), currentToVector(current.set, current.drift));
        const cog = norm360(Math.atan2(ground.x, ground.y) * DEG);
        const sog = Math.hypot(ground.x, ground.y);
        const next = destinationPointNm(p, cog, sog * dt / 3600);
        return {next, cog, sog};
      })();

      let next = adv.next;
      let reached = crsSegmentReachesMark(p, next, mark, captureRadiusNm);
      if(reached.reaches){
        next = reached.point;
        dt *= Math.max(0.05, reached.frac);
      }

      if(!crsSafeSegment(p, next)) continue;

      const nextDist = distanceNm(next, mark);
      // Prevent sailing far beyond the mark without capture.
      if(!reached.reaches && nextDist > dist + 0.15 && dist < 0.25) continue;

      const newTime = n.timeSec + dt + timePenalty;
      if(newTime > maxTimeSec) continue;

      const child = {
        id:nodes.length,
        lat:next.lat,
        lon:next.lon,
        timeSec:newTime,
        absTime:new Date(startTime.getTime() + newTime * 1000),
        board:a.board,
        heading:a.heading,
        cog:adv.cog,
        sog:adv.sog,
        bsp:a.bsp,
        current,
        parentId:n.id,
        tacks:n.tacks + ((n.board && a.board && n.board !== a.board) ? 1 : 0)
      };

      const cell = crsGridKey(child, child.board);
      const previousBest = bestByCell.get(cell);
      if(previousBest != null && previousBest <= newTime) continue;
      bestByCell.set(cell, newTime);

      nodes.push(child);

      const heuristic = nextDist / Math.max(0.1, a.bsp + Math.max(0, current.drift)) * 3600;
      const tackPenaltyHeuristic = child.tacks * 3;
      pq.push(child, newTime + heuristic + tackPenaltyHeuristic);

      if(reached.reaches){
        finishNode = child;
        pq.items = [];
        break;
      }
    }
  }

  const end = finishNode || bestNear;
  const nodePath = crsReconstruct(nodes, end);

  const track = nodePath.map((n, idx) => ({
    lat: idx === nodePath.length - 1 && finishNode ? mark.lat : n.lat,
    lon: idx === nodePath.length - 1 && finishNode ? mark.lon : n.lon,
    time: n.absTime,
    mode: n.board || 'start',
    heading: n.heading,
    cog: n.cog,
    sog: n.sog,
    bsp: n.bsp,
    current: n.current,
    routeNode:true
  }));

  const finalDist = finishNode ? 0 : distanceNm({lat:end.lat, lon:end.lon}, mark);
  const guardLimited = !finishNode;

  const portSec = nodePath.reduce((s,n,i) => {
    if(i === 0) return s;
    const prev = nodePath[i-1];
    const dt = Math.max(0, n.timeSec - prev.timeSec);
    return s + (n.board === 'port' ? dt : 0);
  },0);

  const stbdSec = nodePath.reduce((s,n,i) => {
    if(i === 0) return s;
    const prev = nodePath[i-1];
    const dt = Math.max(0, n.timeSec - prev.timeSec);
    return s + (n.board === 'stbd' ? dt : 0);
  },0);

  return {
    track,
    elapsedSec:end.timeSec,
    portSec,
    stbdSec,
    directSec:0,
    endTime:end.absTime,
    finalDist,
    guardLimited,
    expandedNodes:expanded,
    reached:!!finishNode
  };
}

if(typeof simulateCourse === 'function' && !simulateCourse.__constrainedSearchWrapped){
  simulateCourse = function(){
    if(typeof clearNullIslandCustomPoints === 'function') clearNullIslandCustomPoints();
    readCustomPoints();

    const inputs = readInputs();
    const simCfg = readSimulationInputs();

    if(!course || course.length < 2){
      lastSimulation = null;
      renderTable(predict());
      renderMap(predict());
      return null;
    }
    if(Number.isNaN(simCfg.raceStart.getTime())){
      alert('Enter a valid race start time.');
      return null;
    }
    if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
      alert('Solent Currents mode needs a Portsmouth HW time from EasyTide.');
      return null;
    }

    const courseClone = course.filter(validPoint).map((m,i)=>({
      id:m.id || `course_${i}`,
      name:m.name || `Mark ${i+1}`,
      lat:Number(m.lat),
      lon:Number(m.lon)
    }));

    let simTime = new Date(simCfg.raceStart.getTime());
    let state = {lat:courseClone[0].lat, lon:courseClone[0].lon};
    const legSims = [];
    const fullTrack = [];

    for(let i=0; i<courseClone.length-1; i++){
      const to = courseClone[i+1];
      const bearing = bearingDeg(state, to);
      const signed = norm180(bearing - inputs.twd);
      const mode = legMode(Math.abs(signed));
      const target = targetFor(mode, inputs, signed);
      const legStart = new Date(simTime.getTime());

      const r = crsRouteLeg(state, to, mode, target, inputs, simCfg, simTime);

      r.track.forEach(pt => {
        if(pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lon)){
          fullTrack.push({...pt, legIndex:i});
        }
      });

      simTime = new Date(r.endTime.getTime());
      state = {lat:to.lat, lon:to.lon};

      legSims.push({
        legIndex:i,
        from:course[i],
        to:course[i+1],
        mode,
        startTime:legStart,
        finishTime:new Date(simTime.getTime()),
        elapsedSec:r.elapsedSec,
        portSec:r.portSec,
        stbdSec:r.stbdSec,
        directSec:r.directSec,
        guardLimited:r.guardLimited,
        expandedNodes:r.expandedNodes,
        track:r.track
      });
    }

    lastSimulation = {
      startTime:simCfg.raceStart,
      finishTime:new Date(simTime.getTime()),
      elapsedSec:(simTime.getTime() - simCfg.raceStart.getTime()) / 1000,
      legs:legSims,
      track:fullTrack,
      note:'constrained-route-search'
    };

    const staticResults = predict();
    renderCourseList();
    renderTable(staticResults);
    renderMap(staticResults);
    return lastSimulation;
  };

  simulateCourse.__constrainedSearchWrapped = true;
}


// ---------------- Final approach fix for constrained route search ----------------
// If the bounded route search gets close to the mark but does not enter the capture radius,
// run a greedy land-safe final approach instead of leaving the route stopped short.
// This fixes short-stop cases near waypoints with 60s or 15s steps.

function crsBestSafeClosingAction(p, mark, mode, target, inputs, current){
  const actions = crsCandidateActions(p, mark, mode, target, inputs, current);
  let best = null;

  for(const a of actions){
    // Use a shorter probe for action choice near the mark.
    const probeSec = 20;
    const adv = gtAdvance(p, a.heading, a.bsp, current, probeSec);
    if(!crsSafeSegment(p, adv.next)) continue;

    const before = distanceNm(p, mark);
    const after = distanceNm(adv.next, mark);
    const gain = before - after;
    const crossPenalty = typeof segmentCrossesLand === 'function' && segmentCrossesLand(p, adv.next) ? 999 : 0;
    const score = gain * 1000 - crossPenalty;

    if(!best || score > best.score){
      best = {...a, score, adv};
    }
  }

  return best;
}

function crsFinalApproach(startNode, mark, mode, target, inputs, simCfg, routeStartTime, captureRadiusNm){
  let p = {lat:startNode.lat, lon:startNode.lon};
  let tSec = startNode.timeSec || 0;
  let absTime = new Date(routeStartTime.getTime() + tSec * 1000);
  let board = startNode.board || null;
  const track = [];

  const maxExtraSec = Math.max(600, distanceNm(p, mark) / Math.max(0.1, target.bsp || 5) * 3600 * 3.5);
  let elapsedExtra = 0;
  let noGain = 0;
  let guard = 0;

  while(distanceNm(p, mark) > captureRadiusNm && elapsedExtra < maxExtraSec && guard < 240){
    guard += 1;
    const distBefore = distanceNm(p, mark);
    const current = getTdmCurrentAt(p.lat, p.lon, absTime);

    let action;

    if(mode === 'reach'){
      const bearing = bearingDeg(p, mark);
      const signed = norm180(bearing - inputs.twd);
      const bsp = targetFor('reach', inputs, signed).bsp;
      const cts = solveCurrentCorrectedHeadingToMark(bearing, bsp, current.set, current.drift);
      action = {
        board: norm180(cts.heading - inputs.twd) < 0 ? 'port' : 'stbd',
        heading: cts.heading,
        bsp
      };
    } else {
      action = crsBestSafeClosingAction(p, mark, mode, target, inputs, current);
    }

    // Last-resort: if no legal polar action found, try current-corrected direct closing.
    if(!action){
      const bearing = bearingDeg(p, mark);
      const signed = norm180(bearing - inputs.twd);
      const bsp = targetFor('reach', inputs, signed).bsp || target.bsp || 5;
      const cts = solveCurrentCorrectedHeadingToMark(bearing, bsp, current.set, current.drift);
      action = {
        board: norm180(cts.heading - inputs.twd) < 0 ? 'port' : 'stbd',
        heading: cts.heading,
        bsp
      };
    }

    let dt = Math.min(Math.max(10, Math.min(Number(simCfg.stepSec || 60), 30)), maxExtraSec - elapsedExtra);

    if(board && action.board && board !== action.board && Number(simCfg.tackPenaltySec || 0) > 0){
      tSec += Number(simCfg.tackPenaltySec || 0);
      elapsedExtra += Number(simCfg.tackPenaltySec || 0);
      absTime = new Date(routeStartTime.getTime() + tSec * 1000);
    }

    const adv = gtAdvance(p, action.heading, action.bsp, current, dt);
    let next = adv.next;

    const reach = crsSegmentReachesMark(p, next, mark, captureRadiusNm);
    if(reach.reaches){
      dt *= Math.max(0.05, reach.frac);
      next = {lat:mark.lat, lon:mark.lon};
    }

    // If the full step crosses land, progressively shorten it.
    if(!crsSafeSegment(p, next)){
      let found = false;
      for(const factor of [0.5, 0.25, 0.125]){
        const trialDt = dt * factor;
        const trial = gtAdvance(p, action.heading, action.bsp, current, trialDt);
        if(crsSafeSegment(p, trial.next)){
          dt = trialDt;
          next = trial.next;
          found = true;
          break;
        }
      }
      if(!found) break;
    }

    tSec += dt;
    elapsedExtra += dt;
    absTime = new Date(routeStartTime.getTime() + tSec * 1000);

    const distAfter = distanceNm(next, mark);
    if(distAfter >= distBefore - 0.001) noGain += 1;
    else noGain = 0;

    const point = {
      lat: next.lat,
      lon: next.lon,
      time: new Date(absTime.getTime()),
      mode: action.board,
      heading: action.heading,
      cog: adv.cog,
      sog: adv.sog,
      bsp: action.bsp,
      current,
      finalApproach: true
    };
    track.push(point);

    p = {lat:next.lat, lon:next.lon};
    board = action.board;

    if(Math.abs(next.lat - mark.lat) < 1e-10 && Math.abs(next.lon - mark.lon) < 1e-10) break;

    // If stuck very near the mark, close cleanly if the final segment is water-safe.
    if(noGain >= 5 && distanceNm(p, mark) < 0.12 && crsSafeSegment(p, mark)){
      const closePoint = {
        lat: mark.lat,
        lon: mark.lon,
        time: new Date(absTime.getTime()),
        mode: board || 'finish',
        heading: bearingDeg(p, mark),
        finalApproach: true,
        clippedAtWaypoint: true
      };
      track.push(closePoint);
      p = {lat:mark.lat, lon:mark.lon};
      break;
    }
  }

  return {
    track,
    end: p,
    extraSec: elapsedExtra,
    endTime: absTime,
    reached: distanceNm(p, mark) <= captureRadiusNm || (Math.abs(p.lat - mark.lat) < 1e-10 && Math.abs(p.lon - mark.lon) < 1e-10)
  };
}

// Wrap crsRouteLeg so it always attempts a final approach if the main search stops short.
if(typeof crsRouteLeg === 'function' && !crsRouteLeg.__finalApproachWrapped){
  const __crsRouteLegBase = crsRouteLeg;

  crsRouteLeg = function(start, mark, mode, target, inputs, simCfg, startTime){
    const result = __crsRouteLegBase(start, mark, mode, target, inputs, simCfg, startTime);

    const last = result?.track?.[result.track.length - 1];
    if(!last) return result;

    const captureRadiusNm = Math.max(0.025, Math.min(0.06, distanceNm(start, mark) * 0.015));
    const finalDist = distanceNm(last, mark);

    if(finalDist <= captureRadiusNm || (Math.abs(last.lat - mark.lat) < 1e-10 && Math.abs(last.lon - mark.lon) < 1e-10)){
      // Ensure exact final coordinate.
      last.lat = mark.lat;
      last.lon = mark.lon;
      result.finalDist = 0;
      result.guardLimited = false;
      result.reached = true;
      return result;
    }

    // Only try to close if we are reasonably close; if very far, keep guardLimited result.
    if(finalDist <= Math.max(0.35, distanceNm(start, mark) * 0.25)){
      const pseudoNode = {
        lat: last.lat,
        lon: last.lon,
        timeSec: result.elapsedSec || 0,
        board: last.mode || null
      };

      const close = crsFinalApproach(pseudoNode, mark, mode, target, inputs, simCfg, startTime, captureRadiusNm);

      if(close.track?.length){
        // Remove any guardSnap/artificial final points before appending real final approach.
        result.track = result.track.filter(p => !p.guardSnap);
        result.track.push(...close.track);
        result.elapsedSec = (result.elapsedSec || 0) + close.extraSec;
        result.endTime = close.endTime;
        result.finalDist = distanceNm(close.end, mark);
        result.guardLimited = !close.reached;
        result.reached = close.reached;

        if(close.reached){
          const endPt = result.track[result.track.length - 1];
          endPt.lat = mark.lat;
          endPt.lon = mark.lon;
          result.finalDist = 0;
          result.guardLimited = false;
        }

        // Recompute board seconds from resulting track.
        let port = 0, stbd = 0;
        for(let i=1; i<result.track.length; i++){
          const a = result.track[i-1], b = result.track[i];
          const t0 = new Date(a.time || startTime).getTime();
          const t1 = new Date(b.time || startTime).getTime();
          const dt = Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, (t1 - t0)/1000) : 0;
        }
      }
    }

    return result;
  };

  crsRouteLeg.__finalApproachWrapped = true;
}

// Correct board-second recompute for final approach wrapped results.
if(typeof crsRouteLeg === 'function' && !crsRouteLeg.__boardSecondRecomputeWrapped){
  const __crsRouteLegBoardBase = crsRouteLeg;
  crsRouteLeg = function(...args){
    const r = __crsRouteLegBoardBase(...args);
    if(r?.track?.length){
      let port = 0, stbd = 0;
      for(let i=1; i<r.track.length; i++){
        const a = r.track[i-1], b = r.track[i];
        const t0 = new Date(a.time || args[5]?.raceStart || Date.now()).getTime();
        const t1 = new Date(b.time || args[5]?.raceStart || Date.now()).getTime();
        const dt = (Number.isFinite(t0) && Number.isFinite(t1)) ? Math.max(0, (t1 - t0)/1000) : 0;
        if(b.mode === 'port') port += dt;
        else if(b.mode === 'stbd') stbd += dt;
      }
      r.portSec = port;
      r.stbdSec = stbd;
      r.directSec = 0;
    }
    return r;
  };
  crsRouteLeg.__boardSecondRecomputeWrapped = true;
}


// ---------------- Layline + land-escape constrained router fix ----------------
// Beam-search router that keeps multiple states per cell, rejects land immediately,
// captures marks on segment crossing, and adds high/low/escape modes.

function crs2CellKey(p, board, cellNm=0.045){
  const latKey = Math.round((p.lat * 60) / cellNm);
  const lonKey = Math.round((p.lon * 60 * Math.cos(p.lat * RAD)) / cellNm);
  return `${latKey}:${lonKey}:${board || 'x'}`;
}

function crs2LegFrame(start, mark, p){
  const brg = bearingDeg(start, mark);
  const d = distanceNm(start, p);
  const b = bearingDeg(start, p);
  const delta = norm180(b - brg) * RAD;
  return { along: d * Math.cos(delta), cross: d * Math.sin(delta), legBearing: brg };
}

function crs2SafeStep(a, b){
  if(!a || !b) return false;
  if(!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return false;
  if(typeof pointIsLand === 'function' && (pointIsLand(a.lat,a.lon) || pointIsLand(b.lat,b.lon))) return false;
  if(typeof segmentCrossesLand === 'function' && segmentCrossesLand(a,b)) return false;
  if(typeof routeSegmentCrossesLand === 'function' && routeSegmentCrossesLand(a,b)) return false;
  return true;
}

function crs2SegmentHit(a, b, mark, radiusNm){
  const f = typeof crsClosestFractionOnSegment === 'function' ? crsClosestFractionOnSegment(a,b,mark) : 1;
  const q = typeof crsInterp === 'function' ? crsInterp(a,b,f) : b;
  const d = distanceNm(q, mark);
  if(d <= radiusNm || distanceNm(b, mark) <= radiusNm) return {hit:true, frac:f};
  return {hit:false, frac:1};
}

function crs2Actions(p, mark, mode, target, inputs, current){
  const bearing = bearingDeg(p, mark);
  const actions = [];

  if(mode === 'reach'){
    const signed = norm180(bearing - inputs.twd);
    const bsp = targetFor('reach', inputs, signed).bsp;
    const cts = solveCurrentCorrectedHeadingToMark(bearing, bsp, current.set, current.drift);
    [-12,-6,0,6,12].forEach(offset => {
      const h = norm360(cts.heading + offset);
      actions.push({board: norm180(h - inputs.twd) < 0 ? 'port' : 'stbd', heading:h, bsp, kind:'reach'});
    });
    return actions;
  }

  const twaList = [
    target.twa,
    Math.max(25, target.twa - 6),
    Math.min(175, target.twa + 6),
    Math.max(25, target.twa - 12),
    Math.min(175, target.twa + 12)
  ];

  [...new Set(twaList.map(v => Math.round(v)))].forEach(twa => {
    const h = tackHeadings(mode, inputs.twd, twa);
    let bsp = inputs.usePolar ? polarSpeed(inputs.tws, twa) * inputs.polarFactor : target.bsp;
    if(!Number.isFinite(bsp) || bsp <= 0) bsp = target.bsp;
    actions.push({board:'port', heading:h.port, bsp, kind:`p${twa}`});
    actions.push({board:'stbd', heading:h.stbd, bsp, kind:`s${twa}`});
  });
  return actions;
}

function crs2Score(n, mark, start, legDist){
  const dist = distanceNm(n, mark);
  const frame = crs2LegFrame(start, mark, n);
  const beyond = frame.along > legDist ? (frame.along - legDist) * 6000 : 0;
  const behind = frame.along < -0.05 ? Math.abs(frame.along) * 2500 : 0;
  return n.timeSec + dist * 1000 + Math.abs(frame.cross) * 180 + beyond + behind + n.tacks * 10;
}

function crs2Track(nodes, id, mark, reached){
  const path = [];
  let i = id;
  while(i != null && i >= 0){
    path.push(nodes[i]);
    i = nodes[i].parent;
  }
  path.reverse();
  return path.map((n,k) => ({
    lat: reached && k === path.length - 1 ? mark.lat : n.lat,
    lon: reached && k === path.length - 1 ? mark.lon : n.lon,
    time: n.absTime,
    mode: n.board || 'start',
    heading: n.heading,
    cog: n.cog,
    sog: n.sog,
    bsp: n.bsp,
    current: n.current,
    routeNode: true
  }));
}

function crs2RouteLeg(start, mark, mode, target, inputs, simCfg, startTime){
  const legDist = distanceNm(start, mark);
  const captureRadiusNm = Math.max(0.04, Math.min(0.10, legDist * 0.022));
  const stepSec = Math.max(10, Math.min(90, Number(simCfg.stepSec || 30)));
  const maxTimeSec = Math.max(1500, legDist / Math.max(0.1, target.bsp || 6) * 3600 * 3.2);
  const maxIter = Math.ceil(maxTimeSec / stepSec);
  const beamWidth = 340;
  const keepPerCell = 4;

  const nodes = [];
  let frontier = [];
  function add(n){ n.id = nodes.length; nodes.push(n); return n.id; }

  const startId = add({
    lat:start.lat, lon:start.lon, timeSec:0, absTime:new Date(startTime.getTime()),
    board:null, heading:null, cog:null, sog:0, bsp:0, current:null,
    parent:null, tacks:0, score:0
  });
  frontier.push(startId);

  let bestId = startId;
  let bestDist = legDist;
  let finishId = null;

  for(let iter=0; iter<maxIter && frontier.length && finishId == null; iter++){
    const cand = [];

    for(const id of frontier){
      const n = nodes[id];
      const p = {lat:n.lat, lon:n.lon};
      const dist = distanceNm(p, mark);
      if(dist < bestDist){ bestDist = dist; bestId = id; }
      if(dist <= captureRadiusNm){ finishId = id; break; }

      const current = getTdmCurrentAt(p.lat, p.lon, n.absTime);
      const actions = crs2Actions(p, mark, mode, target, inputs, current);

      for(const a of actions){
        // Respect min tack duration but allow zero.
        if(n.board && a.board && n.board !== a.board && Number(simCfg.minTackSec || 0) > 0 && n.parent != null){
          const parent = nodes[n.parent];
          if(parent && parent.board && parent.board !== n.board && (n.timeSec - parent.timeSec) < Number(simCfg.minTackSec || 0)) continue;
        }

        let dt = stepSec;
        let penalty = (n.board && a.board && n.board !== a.board) ? Number(simCfg.tackPenaltySec || 0) : 0;

        let adv = gtAdvance(p, a.heading, a.bsp, current, dt);
        let next = adv.next;

        const hit = crs2SegmentHit(p, next, mark, captureRadiusNm);
        if(hit.hit){
          dt *= Math.max(0.05, hit.frac);
          next = {lat:mark.lat, lon:mark.lon};
        }

        if(!crs2SafeStep(p, next)){
          let ok = false;
          for(const f of [0.5,0.25,0.125]){
            const dt2 = stepSec * f;
            const adv2 = gtAdvance(p, a.heading, a.bsp, current, dt2);
            if(crs2SafeStep(p, adv2.next)){
              dt = dt2; adv = adv2; next = adv2.next; ok = true; break;
            }
          }
          if(!ok) continue;
        }

        const nextDist = distanceNm(next, mark);
        const frame = crs2LegFrame(start, mark, next);
        if(!hit.hit && frame.along > legDist + 0.18 && nextDist > captureRadiusNm) continue;
        if(dist < 0.35 && !hit.hit && nextDist > dist + 0.03) continue;

        const child = {
          lat:next.lat, lon:next.lon,
          timeSec:n.timeSec + dt + penalty,
          absTime:new Date(startTime.getTime() + (n.timeSec + dt + penalty) * 1000),
          board:a.board, heading:a.heading, cog:adv.cog, sog:adv.sog, bsp:a.bsp,
          current, parent:id,
          tacks:n.tacks + ((n.board && a.board && n.board !== a.board) ? 1 : 0)
        };
        child.score = crs2Score(child, mark, start, legDist);
        const childId = add(child);
        if(hit.hit){ finishId = childId; break; }
        cand.push(childId);
      }
      if(finishId != null) break;
    }

    if(finishId != null) break;

    cand.sort((a,b) => nodes[a].score - nodes[b].score);
    const counts = new Map();
    frontier = [];
    for(const id of cand){
      const n = nodes[id];
      const key = crs2CellKey(n, n.board);
      const c = counts.get(key) || 0;
      if(c >= keepPerCell) continue;
      counts.set(key, c + 1);
      frontier.push(id);
      if(frontier.length >= beamWidth) break;
    }
  }

  const endId = finishId != null ? finishId : bestId;
  const reached = finishId != null;
  const track = crs2Track(nodes, endId, mark, reached);
  const end = nodes[endId];

  let portSec = 0, stbdSec = 0;
  for(let i=1; i<track.length; i++){
    const t0 = new Date(track[i-1].time).getTime();
    const t1 = new Date(track[i].time).getTime();
    const dt = Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, (t1-t0)/1000) : 0;
    if(track[i].mode === 'port') portSec += dt;
    else if(track[i].mode === 'stbd') stbdSec += dt;
  }

  return {
    track,
    elapsedSec:end.timeSec,
    portSec,
    stbdSec,
    directSec:0,
    endTime:end.absTime,
    finalDist: reached ? 0 : distanceNm({lat:end.lat, lon:end.lon}, mark),
    guardLimited:!reached,
    reached,
    expandedNodes:nodes.length
  };
}

if(typeof simulateCourse === 'function' && !simulateCourse.__crs2Wrapped){
  simulateCourse = function(){
    if(typeof clearNullIslandCustomPoints === 'function') clearNullIslandCustomPoints();
    readCustomPoints();

    const inputs = readInputs();
    const simCfg = readSimulationInputs();

    if(!course || course.length < 2){
      lastSimulation = null;
      renderTable(predict());
      renderMap(predict());
      return null;
    }
    if(Number.isNaN(simCfg.raceStart.getTime())){
      alert('Enter a valid race start time.');
      return null;
    }
    if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
      alert('Solent Currents mode needs a Portsmouth HW time from EasyTide.');
      return null;
    }

    const courseClone = course.filter(validPoint).map((m,i)=>({
      id:m.id || `course_${i}`, name:m.name || `Mark ${i+1}`, lat:Number(m.lat), lon:Number(m.lon)
    }));

    let simTime = new Date(simCfg.raceStart.getTime());
    let state = {lat:courseClone[0].lat, lon:courseClone[0].lon};
    const legSims = [];
    const fullTrack = [];

    for(let i=0; i<courseClone.length-1; i++){
      const to = courseClone[i+1];
      const bearing = bearingDeg(state, to);
      const signed = norm180(bearing - inputs.twd);
      const mode = legMode(Math.abs(signed));
      const target = targetFor(mode, inputs, signed);
      const legStart = new Date(simTime.getTime());
      const r = crs2RouteLeg(state, to, mode, target, inputs, simCfg, simTime);

      r.track.forEach(pt => {
        if(pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lon)){
          fullTrack.push({...pt, legIndex:i});
        }
      });

      simTime = new Date(r.endTime.getTime());
      state = {lat:to.lat, lon:to.lon};

      legSims.push({
        legIndex:i, from:course[i], to:course[i+1], mode,
        startTime:legStart, finishTime:new Date(simTime.getTime()),
        elapsedSec:r.elapsedSec, portSec:r.portSec, stbdSec:r.stbdSec, directSec:0,
        guardLimited:r.guardLimited, expandedNodes:r.expandedNodes, track:r.track
      });
    }

    lastSimulation = {
      startTime:simCfg.raceStart,
      finishTime:new Date(simTime.getTime()),
      elapsedSec:(simTime.getTime() - simCfg.raceStart.getTime()) / 1000,
      legs:legSims,
      track:fullTrack,
      note:'crs2-layline-land-escape'
    };

    const staticResults = predict();
    renderCourseList();
    renderTable(staticResults);
    renderMap(staticResults);
    return lastSimulation;
  };
  simulateCourse.__crs2Wrapped = true;
}


// ---------------- Reverse isochrone makeable-zone router ----------------
// Adds a reverse "can still make the mark" isochrone pass after the main action model.
// Forward states are strongly biased/restricted toward cells that are reverse-makeable.
// This prevents sailing past the layline and then trying to recover too late.

function riCellKey(p, cellNm=0.055){
  const latKey = Math.round((p.lat * 60) / cellNm);
  const lonKey = Math.round((p.lon * 60 * Math.cos(p.lat * RAD)) / cellNm);
  return `${latKey}:${lonKey}`;
}

function riStateKey(p, board, cellNm=0.055){
  return `${riCellKey(p, cellNm)}:${board || 'x'}`;
}

function riReverseActions(p, mark, mode, target, inputs, current){
  // Same sailing modes as forward, but reverse propagation moves opposite the ground vector.
  return crs2Actions ? crs2Actions(p, mark, mode, target, inputs, current) : crsCandidateActions(p, mark, mode, target, inputs, current);
}

function riBackwardStep(p, action, current, dtSec){
  const ground = addVec(vecFrom(action.heading, action.bsp), currentToVector(current.set, current.drift));
  const cog = norm360(Math.atan2(ground.x, ground.y) * DEG);
  const sog = Math.hypot(ground.x, ground.y);
  // Reverse time: move opposite to the forward COG.
  const prev = destinationPointNm(p, norm360(cog + 180), sog * dtSec / 3600);
  return {prev, cog, sog};
}

function buildReverseIsochrone(mark, start, mode, target, inputs, simCfg, legStartTime){
  const legDist = distanceNm(start, mark);
  const stepSec = Math.max(10, Math.min(90, Number(simCfg.stepSec || 30)));
  const staticSeconds = Math.max(300, legDist / Math.max(0.1, target.bsp || 6) * 3600);
  const horizonSec = Math.max(staticSeconds * 2.4, staticSeconds + 1200);
  const maxIter = Math.ceil(horizonSec / stepSec);
  const maxRadiusNm = Math.max(0.8, legDist * 1.15);
  const beamWidth = 420;
  const cellNm = 0.055;

  const cells = new Map();       // cell -> earliest reverse seconds
  const states = [];
  let frontier = [];

  function addState(s){
    s.id = states.length;
    states.push(s);
    const key = riCellKey(s, cellNm);
    const old = cells.get(key);
    if(old == null || s.revSec < old) cells.set(key, s.revSec);
    return s.id;
  }

  const startId = addState({
    lat:mark.lat,
    lon:mark.lon,
    revSec:0,
    board:null,
    parent:null
  });
  frontier.push(startId);

  for(let iter=0; iter<maxIter && frontier.length; iter++){
    const candidates = [];

    for(const id of frontier){
      const s = states[id];
      const p = {lat:s.lat, lon:s.lon};

      if(distanceNm(p, mark) > maxRadiusNm) continue;

      // Approximate absolute time for reverse state.
      // We don't know the exact arrival time yet, so centre the reverse tide sampling near
      // legStart + staticSeconds, then move backwards with revSec.
      const absTime = new Date(legStartTime.getTime() + Math.max(0, staticSeconds - s.revSec) * 1000);
      const current = getTdmCurrentAt(p.lat, p.lon, absTime);
      const actions = riReverseActions(p, mark, mode, target, inputs, current);

      for(const a of actions){
        const back = riBackwardStep(p, a, current, stepSec);
        const prev = back.prev;

        if(distanceNm(prev, mark) > maxRadiusNm) continue;
        if(!crs2SafeStep(prev, p)) continue;

        const child = {
          lat:prev.lat,
          lon:prev.lon,
          revSec:s.revSec + stepSec,
          board:a.board,
          parent:id
        };

        const stateKey = riStateKey(child, child.board, cellNm);
        const old = cells.get(riCellKey(child, cellNm));
        // Keep if this cell is new or reached materially earlier.
        if(old != null && old <= child.revSec - stepSec * 0.5) continue;

        const childId = addState(child);
        candidates.push(childId);
      }
    }

    // Prune reverse frontier by closeness to start and diversity.
    candidates.sort((a,b) => {
      const sa = states[a], sb = states[b];
      const ca = distanceNm(sa, start) + sa.revSec / 10000;
      const cb = distanceNm(sb, start) + sb.revSec / 10000;
      return ca - cb;
    });

    const used = new Set();
    frontier = [];
    for(const id of candidates){
      const s = states[id];
      const k = riStateKey(s, s.board, cellNm);
      if(used.has(k)) continue;
      used.add(k);
      frontier.push(id);
      if(frontier.length >= beamWidth) break;
    }
  }

  return {
    cells,
    cellNm,
    horizonSec,
    maxRadiusNm,
    size:cells.size,
    isMakeable(p, remainingSecGuess){
      const key = riCellKey(p, cellNm);
      const reverseTime = cells.get(key);
      if(reverseTime == null) return false;
      if(remainingSecGuess == null) return true;
      return reverseTime <= remainingSecGuess * 1.35 + stepSec;
    },
    reverseTime(p){
      return cells.get(riCellKey(p, cellNm));
    }
  };
}

function crs2RouteLegWithReverseIsochrone(start, mark, mode, target, inputs, simCfg, startTime){
  const legDist = distanceNm(start, mark);
  const captureRadiusNm = Math.max(0.04, Math.min(0.10, legDist * 0.022));
  const stepSec = Math.max(10, Math.min(90, Number(simCfg.stepSec || 30)));
  const maxTimeSec = Math.max(1500, legDist / Math.max(0.1, target.bsp || 6) * 3600 * 3.2);
  const maxIter = Math.ceil(maxTimeSec / stepSec);
  const beamWidth = 360;
  const keepPerCell = 4;

  const reverse = buildReverseIsochrone(mark, start, mode, target, inputs, simCfg, startTime);

  const nodes = [];
  let frontier = [];
  function add(n){ n.id = nodes.length; nodes.push(n); return n.id; }

  const startId = add({
    lat:start.lat, lon:start.lon, timeSec:0, absTime:new Date(startTime.getTime()),
    board:null, heading:null, cog:null, sog:0, bsp:0, current:null,
    parent:null, tacks:0, score:0, reverseHit:reverse.isMakeable(start, maxTimeSec)
  });
  frontier.push(startId);

  let bestId = startId;
  let bestDist = legDist;
  let finishId = null;
  let firstReverseJoinId = startId && reverse.isMakeable(start, maxTimeSec) ? startId : null;

  for(let iter=0; iter<maxIter && frontier.length && finishId == null; iter++){
    const cand = [];

    for(const id of frontier){
      const n = nodes[id];
      const p = {lat:n.lat, lon:n.lon};
      const dist = distanceNm(p, mark);
      if(dist < bestDist){ bestDist = dist; bestId = id; }
      if(dist <= captureRadiusNm){ finishId = id; break; }

      const current = getTdmCurrentAt(p.lat, p.lon, n.absTime);
      const actions = crs2Actions(p, mark, mode, target, inputs, current);

      for(const a of actions){
        if(n.board && a.board && n.board !== a.board && Number(simCfg.minTackSec || 0) > 0 && n.parent != null){
          const parent = nodes[n.parent];
          if(parent && parent.board && parent.board !== n.board && (n.timeSec - parent.timeSec) < Number(simCfg.minTackSec || 0)) continue;
        }

        let dt = stepSec;
        let penalty = (n.board && a.board && n.board !== a.board) ? Number(simCfg.tackPenaltySec || 0) : 0;

        let adv = gtAdvance(p, a.heading, a.bsp, current, dt);
        let next = adv.next;

        const hit = crs2SegmentHit(p, next, mark, captureRadiusNm);
        if(hit.hit){
          dt *= Math.max(0.05, hit.frac);
          next = {lat:mark.lat, lon:mark.lon};
        }

        if(!crs2SafeStep(p, next)){
          let ok = false;
          for(const f of [0.5,0.25,0.125]){
            const dt2 = stepSec * f;
            const adv2 = gtAdvance(p, a.heading, a.bsp, current, dt2);
            if(crs2SafeStep(p, adv2.next)){
              dt = dt2; adv = adv2; next = adv2.next; ok = true; break;
            }
          }
          if(!ok) continue;
        }

        const nextDist = distanceNm(next, mark);
        const frame = crs2LegFrame(start, mark, next);
        if(!hit.hit && frame.along > legDist + 0.18 && nextDist > captureRadiusNm) continue;
        if(dist < 0.35 && !hit.hit && nextDist > dist + 0.03) continue;

        const newTime = n.timeSec + dt + penalty;
        const remainingGuess = maxTimeSec - newTime;
        const reverseTime = reverse.reverseTime(next);
        const reverseMakeable = reverseTime != null;

        // Hard-ish gate once we are past the first third of the leg:
        // do not keep sailing away from the reverse makeable zone.
        const legProgressRatio = Math.max(0, Math.min(1.5, frame.along / Math.max(0.001, legDist)));
        if(legProgressRatio > 0.35 && !reverseMakeable && !hit.hit){
          // Allow some exploration, but reject if also not improving range.
          if(nextDist > bestDist + 0.20 || frame.along > legDist * 0.55) continue;
        }

        const child = {
          lat:next.lat, lon:next.lon,
          timeSec:newTime,
          absTime:new Date(startTime.getTime() + newTime * 1000),
          board:a.board, heading:a.heading, cog:adv.cog, sog:adv.sog, bsp:a.bsp,
          current, parent:id,
          tacks:n.tacks + ((n.board && a.board && n.board !== a.board) ? 1 : 0),
          reverseHit:reverseMakeable,
          reverseTime:reverseTime
        };

        child.score = crs2Score(child, mark, start, legDist);

        // Strongly favour states that are in the reverse makeable set.
        if(reverseMakeable){
          child.score -= 450;
          child.score += Math.max(0, (reverseTime || 0) - remainingGuess) * 0.15;
        } else {
          child.score += 750 + legProgressRatio * 600;
        }

        const childId = add(child);
        if(reverseMakeable && firstReverseJoinId == null) firstReverseJoinId = childId;

        if(hit.hit){ finishId = childId; break; }
        cand.push(childId);
      }
      if(finishId != null) break;
    }

    if(finishId != null) break;

    cand.sort((a,b) => nodes[a].score - nodes[b].score);
    const counts = new Map();
    frontier = [];
    for(const id of cand){
      const n = nodes[id];
      const key = crs2CellKey(n, n.board);
      const c = counts.get(key) || 0;
      if(c >= keepPerCell) continue;
      counts.set(key, c + 1);
      frontier.push(id);
      if(frontier.length >= beamWidth) break;
    }
  }

  let endId = finishId != null ? finishId : bestId;
  let reached = finishId != null;

  const track = crs2Track(nodes, endId, mark, reached);
  const end = nodes[endId];

  let portSec = 0, stbdSec = 0;
  for(let i=1; i<track.length; i++){
    const t0 = new Date(track[i-1].time).getTime();
    const t1 = new Date(track[i].time).getTime();
    const dt = Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, (t1-t0)/1000) : 0;
    if(track[i].mode === 'port') portSec += dt;
    else if(track[i].mode === 'stbd') stbdSec += dt;
  }

  return {
    track,
    elapsedSec:end.timeSec,
    portSec,
    stbdSec,
    directSec:0,
    endTime:end.absTime,
    finalDist: reached ? 0 : distanceNm({lat:end.lat, lon:end.lon}, mark),
    guardLimited:!reached,
    reached,
    expandedNodes:nodes.length,
    reverseCells:reverse.size,
    reverseIsochrone:true
  };
}

// Final override: use reverse-isochrone route search for every leg.
if(typeof simulateCourse === 'function' && !simulateCourse.__reverseIsochroneWrapped){
  simulateCourse = function(){
    if(typeof clearNullIslandCustomPoints === 'function') clearNullIslandCustomPoints();
    readCustomPoints();

    const inputs = readInputs();
    const simCfg = readSimulationInputs();

    if(!course || course.length < 2){
      lastSimulation = null;
      renderTable(predict());
      renderMap(predict());
      return null;
    }
    if(Number.isNaN(simCfg.raceStart.getTime())){
      alert('Enter a valid race start time.');
      return null;
    }
    if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
      alert('Solent Currents mode needs a Portsmouth HW time from EasyTide.');
      return null;
    }

    const courseClone = course.filter(validPoint).map((m,i)=>({
      id:m.id || `course_${i}`, name:m.name || `Mark ${i+1}`, lat:Number(m.lat), lon:Number(m.lon)
    }));

    let simTime = new Date(simCfg.raceStart.getTime());
    let state = {lat:courseClone[0].lat, lon:courseClone[0].lon};
    const legSims = [];
    const fullTrack = [];

    for(let i=0; i<courseClone.length-1; i++){
      const to = courseClone[i+1];
      const bearing = bearingDeg(state, to);
      const signed = norm180(bearing - inputs.twd);
      const mode = legMode(Math.abs(signed));
      const target = targetFor(mode, inputs, signed);
      const legStart = new Date(simTime.getTime());

      const r = crs2RouteLegWithReverseIsochrone(state, to, mode, target, inputs, simCfg, simTime);

      r.track.forEach(pt => {
        if(pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lon)){
          fullTrack.push({...pt, legIndex:i});
        }
      });

      simTime = new Date(r.endTime.getTime());
      state = {lat:to.lat, lon:to.lon};

      legSims.push({
        legIndex:i, from:course[i], to:course[i+1], mode,
        startTime:legStart, finishTime:new Date(simTime.getTime()),
        elapsedSec:r.elapsedSec, portSec:r.portSec, stbdSec:r.stbdSec, directSec:0,
        guardLimited:r.guardLimited, expandedNodes:r.expandedNodes, reverseCells:r.reverseCells,
        track:r.track
      });
    }

    lastSimulation = {
      startTime:simCfg.raceStart,
      finishTime:new Date(simTime.getTime()),
      elapsedSec:(simTime.getTime() - simCfg.raceStart.getTime()) / 1000,
      legs:legSims,
      track:fullTrack,
      note:'reverse-isochrone-constrained-router'
    };

    const staticResults = predict();
    renderCourseList();
    renderTable(staticResults);
    renderMap(staticResults);
    return lastSimulation;
  };
  simulateCourse.__reverseIsochroneWrapped = true;
}


// ---------------- Do not treat "best near" as a completed leg ----------------
// If no valid waypoint capture is found, stop simulation at that leg and mark failure.
// Do not continue later legs from a mark the simulated boat never reached.

function makeFailedLegResult(start, mark, startTime, partial, reason){
  const track = Array.isArray(partial?.track) && partial.track.length
    ? partial.track.filter(p => p && !p.guardSnap)
    : [{lat:start.lat, lon:start.lon, time:new Date(startTime.getTime()), mode:'start'}];

  const last = track[track.length - 1] || track[0];
  const elapsedSec = Number(partial?.elapsedSec || 0);
  return {
    track,
    elapsedSec,
    portSec:Number(partial?.portSec || 0),
    stbdSec:Number(partial?.stbdSec || 0),
    directSec:0,
    endTime:partial?.endTime || new Date(startTime.getTime() + elapsedSec * 1000),
    finalDist:last ? distanceNm(last, mark) : distanceNm(start, mark),
    guardLimited:true,
    reached:false,
    failed:true,
    reason:reason || 'No valid waypoint capture found'
  };
}

if(typeof crs2RouteLegWithReverseIsochrone === 'function' && !crs2RouteLegWithReverseIsochrone.__noBestNearWrapped){
  const __crs2RouteLegWithReverseIsochroneBase = crs2RouteLegWithReverseIsochrone;

  crs2RouteLegWithReverseIsochrone = function(start, mark, mode, target, inputs, simCfg, startTime){
    const r = __crs2RouteLegWithReverseIsochroneBase(start, mark, mode, target, inputs, simCfg, startTime);

    if(r?.reached && !r.guardLimited){
      return r;
    }

    // Final explicit closure only if already close and direct segment is land-safe.
    const last = r?.track?.[r.track.length - 1];
    if(last){
      const d = distanceNm(last, mark);
      if(d <= 0.12 && crs2SafeStep(last, mark)){
        const extraSec = Math.max(5, d / Math.max(0.1, target.bsp || 5) * 3600);
        const closeTime = new Date(new Date(last.time || r.endTime || startTime).getTime() + extraSec * 1000);
        r.track = r.track.filter(p => !p.guardSnap);
        r.track.push({
          lat:mark.lat,
          lon:mark.lon,
          time:closeTime,
          mode:last.mode || 'finish',
          heading:bearingDeg(last, mark),
          clippedAtWaypoint:true,
          finalClosure:true
        });
        r.elapsedSec = (closeTime.getTime() - startTime.getTime()) / 1000;
        r.endTime = closeTime;
        r.finalDist = 0;
        r.guardLimited = false;
        r.reached = true;
        r.failed = false;
        return r;
      }
    }

    return makeFailedLegResult(start, mark, startTime, r, 'No valid land-safe route reached waypoint');
  };

  crs2RouteLegWithReverseIsochrone.__noBestNearWrapped = true;
}

if(typeof simulateCourse === 'function' && !simulateCourse.__stopOnFailedLegWrapped){
  simulateCourse = function(){
    if(typeof clearNullIslandCustomPoints === 'function') clearNullIslandCustomPoints();
    readCustomPoints();

    const inputs = readInputs();
    const simCfg = readSimulationInputs();

    if(!course || course.length < 2){
      lastSimulation = null;
      renderTable(predict());
      renderMap(predict());
      return null;
    }
    if(Number.isNaN(simCfg.raceStart.getTime())){
      alert('Enter a valid race start time.');
      return null;
    }
    if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
      alert('Solent Currents mode needs a Portsmouth HW time from EasyTide.');
      return null;
    }

    const courseClone = course.filter(validPoint).map((m,i)=>({
      id:m.id || `course_${i}`, name:m.name || `Mark ${i+1}`, lat:Number(m.lat), lon:Number(m.lon)
    }));

    let simTime = new Date(simCfg.raceStart.getTime());
    let state = {lat:courseClone[0].lat, lon:courseClone[0].lon};
    const legSims = [];
    const fullTrack = [];
    let failed = false;

    for(let i=0; i<courseClone.length-1; i++){
      const to = courseClone[i+1];
      const bearing = bearingDeg(state, to);
      const signed = norm180(bearing - inputs.twd);
      const mode = legMode(Math.abs(signed));
      const target = targetFor(mode, inputs, signed);
      const legStart = new Date(simTime.getTime());

      const r = crs2RouteLegWithReverseIsochrone(state, to, mode, target, inputs, simCfg, simTime);

      r.track.forEach(pt => {
        if(pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lon)){
          fullTrack.push({...pt, legIndex:i, failed:!!r.failed});
        }
      });

      simTime = new Date(r.endTime.getTime());
      legSims.push({
        legIndex:i, from:course[i], to:course[i+1], mode,
        startTime:legStart, finishTime:new Date(simTime.getTime()),
        elapsedSec:r.elapsedSec, portSec:r.portSec, stbdSec:r.stbdSec, directSec:0,
        guardLimited:r.guardLimited, failed:!!r.failed, failureReason:r.reason || '',
        finalDist:r.finalDist, expandedNodes:r.expandedNodes, reverseCells:r.reverseCells,
        track:r.track
      });

      if(!r.reached || r.failed || r.guardLimited){
        failed = true;
        break;
      }

      state = {lat:to.lat, lon:to.lon};
    }

    lastSimulation = {
      startTime:simCfg.raceStart,
      finishTime:new Date(simTime.getTime()),
      elapsedSec:(simTime.getTime() - simCfg.raceStart.getTime()) / 1000,
      legs:legSims,
      track:fullTrack,
      failed,
      note: failed ? 'route-failed-before-waypoint' : 'reverse-isochrone-constrained-router'
    };

    const staticResults = predict();
    renderCourseList();
    renderTable(staticResults);
    renderMap(staticResults);

    if(failed){
      const bad = legSims.find(l => l.failed || l.guardLimited);
      setTideStatus?.(`Simulation stopped: ${bad?.from?.name || 'leg'} → ${bad?.to?.name || 'mark'} did not reach waypoint. ${bad?.failureReason || ''}`, true);
    }

    return lastSimulation;
  };

  simulateCourse.__stopOnFailedLegWrapped = true;
}

if(typeof renderTable === 'function' && !renderTable.__failedLegLabelWrapped){
  const __renderTableFailedBase = renderTable;
  renderTable = function(results){
    __renderTableFailedBase(results);
    try{
      if(!lastSimulation?.legs?.length) return;
      const rows = $('legsTable')?.querySelectorAll('tbody tr');
      if(!rows) return;
      lastSimulation.legs.forEach((leg, idx) => {
        if(leg.failed || leg.guardLimited){
          const row = rows[idx];
          if(row){
            row.classList.add('failed-leg-row');
            const first = row.querySelector('td');
            if(first && !first.textContent.includes('FAILED')){
              first.innerHTML = `${first.innerHTML}<br><span class="failed-leg-label">FAILED: did not reach waypoint</span>`;
            }
          }
        }
      });
    }catch(err){
      console.warn('failed leg label render failed', err);
    }
  };
  renderTable.__failedLegLabelWrapped = true;
}


// ---------------- Deterministic reaching/free-leg solver ----------------
// Reaching legs do not need the constrained tack/gybe route search.
// They are solved by steering a current-corrected CTS each step so COG closes the mark.
// This prevents the router from falsely failing simple cross-tide reaches.

function solveReachLegDeterministic(start, mark, inputs, simCfg, startTime){
  let p = {lat:start.lat, lon:start.lon};
  let t = new Date(startTime.getTime());
  const legDist = distanceNm(start, mark);
  const captureRadiusNm = Math.max(0.025, Math.min(0.06, legDist * 0.015));
  const maxSec = Math.max(900, legDist / 3 * 3600); // very generous guard
  const stepSec = Math.max(5, Math.min(90, Number(simCfg.stepSec || 30)));

  const track = [{lat:p.lat, lon:p.lon, time:new Date(t.getTime()), mode:'start'}];
  let elapsed = 0;
  let portSec = 0;
  let stbdSec = 0;
  let guard = 0;

  while(elapsed < maxSec && guard < 2000){
    guard += 1;

    const dist = distanceNm(p, mark);
    if(dist <= captureRadiusNm) break;

    const bearingNow = bearingDeg(p, mark);
    const signedNow = norm180(bearingNow - inputs.twd);
    const target = targetFor('reach', inputs, signedNow);
    const bsp = Number(target?.bsp || 0);

    if(!Number.isFinite(bsp) || bsp <= 0.1){
      return {
        track,
        elapsedSec: elapsed,
        portSec,
        stbdSec,
        directSec:0,
        endTime:t,
        finalDist:dist,
        guardLimited:true,
        reached:false,
        failed:true,
        reason:'No valid reaching BSP'
      };
    }

    const current = getTdmCurrentAt(p.lat, p.lon, t);
    const cts = solveCurrentCorrectedHeadingToMark(bearingNow, bsp, current.set, current.drift);

    // If current is too strong and no positive closing speed exists, fail. Otherwise continue.
    const closingGround = currentToVector(cts.cog, cts.sog);
    const closingKn = vecProject(closingGround, bearingNow);
    if(!Number.isFinite(closingKn) || closingKn <= 0.05){
      return {
        track,
        elapsedSec: elapsed,
        portSec,
        stbdSec,
        directSec:0,
        endTime:t,
        finalDist:dist,
        guardLimited:true,
        reached:false,
        failed:true,
        reason:'No positive closing speed on reaching leg'
      };
    }

    let dt = Math.min(stepSec, maxSec - elapsed);
    let stepNm = cts.sog * dt / 3600;
    let next = destinationPointNm(p, cts.cog, stepNm);

    // If the segment crosses the mark capture radius, finish exactly at the mark.
    const hit = (typeof crs2SegmentHit === 'function')
      ? crs2SegmentHit(p, next, mark, captureRadiusNm)
      : {hit: distanceNm(next, mark) <= captureRadiusNm, frac:1};

    if(hit.hit){
      dt *= Math.max(0.05, Math.min(1, hit.frac || 1));
      next = {lat:mark.lat, lon:mark.lon};
    }

    // Land avoidance: for a free leg, if direct CTS segment crosses land, try a small fan.
    if(!crs2SafeStep(p, next)){
      let found = false;
      for(const off of [-20,20,-35,35,-50,50]){
        const h = norm360(cts.heading + off);
        const adv = gtAdvance(p, h, bsp, current, dt);
        if(crs2SafeStep(p, adv.next) && distanceNm(adv.next, mark) < dist){
          next = adv.next;
          cts.heading = h;
          cts.cog = adv.cog;
          cts.sog = adv.sog;
          found = true;
          break;
        }
      }
      if(!found){
        return {
          track,
          elapsedSec: elapsed,
          portSec,
          stbdSec,
          directSec:0,
          endTime:t,
          finalDist:dist,
          guardLimited:true,
          reached:false,
          failed:true,
          reason:'Land mask blocks reaching CTS'
        };
      }
    }

    elapsed += dt;
    t = new Date(t.getTime() + dt * 1000);

    const board = norm180(cts.heading - inputs.twd) < 0 ? 'port' : 'stbd';
    if(board === 'port') portSec += dt;
    else stbdSec += dt;

    const pt = {
      lat:next.lat,
      lon:next.lon,
      time:new Date(t.getTime()),
      mode:board,
      heading:cts.heading,
      cog:cts.cog,
      sog:cts.sog,
      bsp,
      current,
      deterministicReach:true
    };
    track.push(pt);
    p = {lat:next.lat, lon:next.lon};

    if(Math.abs(next.lat - mark.lat) < 1e-10 && Math.abs(next.lon - mark.lon) < 1e-10) break;
  }

  const finalDist = distanceNm(p, mark);
  const reached = finalDist <= captureRadiusNm || (Math.abs(p.lat - mark.lat) < 1e-10 && Math.abs(p.lon - mark.lon) < 1e-10);

  if(reached){
    const last = track[track.length - 1];
    last.lat = mark.lat;
    last.lon = mark.lon;
  }

  return {
    track,
    elapsedSec: elapsed,
    portSec,
    stbdSec,
    directSec:0,
    endTime:t,
    finalDist: reached ? 0 : finalDist,
    guardLimited: !reached,
    reached,
    failed: !reached,
    reason: reached ? '' : 'Reaching leg did not close waypoint'
  };
}

// Override simulation flow: use deterministic reach solver for reach/free legs only;
// keep reverse isochrone constrained search for upwind/downwind.
if(typeof simulateCourse === 'function' && !simulateCourse.__deterministicReachWrapped){
  simulateCourse = function(){
    if(typeof clearNullIslandCustomPoints === 'function') clearNullIslandCustomPoints();
    readCustomPoints();

    const inputs = readInputs();
    const simCfg = readSimulationInputs();

    if(!course || course.length < 2){
      lastSimulation = null;
      renderTable(predict());
      renderMap(predict());
      return null;
    }
    if(Number.isNaN(simCfg.raceStart.getTime())){
      alert('Enter a valid race start time.');
      return null;
    }
    if(($('currentSource')?.value === 'tdm') && (!portsmouthHwTime || Number.isNaN(portsmouthHwTime.getTime()))){
      alert('Solent Currents mode needs a Portsmouth HW time from EasyTide.');
      return null;
    }

    const courseClone = course.filter(validPoint).map((m,i)=>({
      id:m.id || `course_${i}`,
      name:m.name || `Mark ${i+1}`,
      lat:Number(m.lat),
      lon:Number(m.lon)
    }));

    let simTime = new Date(simCfg.raceStart.getTime());
    let state = {lat:courseClone[0].lat, lon:courseClone[0].lon};
    const legSims = [];
    const fullTrack = [];
    let failed = false;

    for(let i=0; i<courseClone.length-1; i++){
      const to = courseClone[i+1];
      const bearing = bearingDeg(state, to);
      const signed = norm180(bearing - inputs.twd);
      const mode = legMode(Math.abs(signed));
      const target = targetFor(mode, inputs, signed);
      const legStart = new Date(simTime.getTime());

      let r;
      if(mode === 'reach'){
        r = solveReachLegDeterministic(state, to, inputs, simCfg, simTime);
      } else if(typeof crs2RouteLegWithReverseIsochrone === 'function') {
        r = crs2RouteLegWithReverseIsochrone(state, to, mode, target, inputs, simCfg, simTime);
      } else {
        r = crs2RouteLeg(state, to, mode, target, inputs, simCfg, simTime);
      }

      r.track.forEach(pt => {
        if(pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lon)){
          fullTrack.push({...pt, legIndex:i, failed:!!r.failed});
        }
      });

      simTime = new Date(r.endTime.getTime());

      legSims.push({
        legIndex:i,
        from:course[i],
        to:course[i+1],
        mode,
        startTime:legStart,
        finishTime:new Date(simTime.getTime()),
        elapsedSec:r.elapsedSec,
        portSec:r.portSec,
        stbdSec:r.stbdSec,
        directSec:r.directSec || 0,
        guardLimited:r.guardLimited,
        failed:!!r.failed,
        failureReason:r.reason || '',
        finalDist:r.finalDist,
        expandedNodes:r.expandedNodes,
        reverseCells:r.reverseCells,
        track:r.track
      });

      if(!r.reached || r.failed || r.guardLimited){
        failed = true;
        break;
      }

      state = {lat:to.lat, lon:to.lon};
    }

    lastSimulation = {
      startTime:simCfg.raceStart,
      finishTime:new Date(simTime.getTime()),
      elapsedSec:(simTime.getTime() - simCfg.raceStart.getTime()) / 1000,
      legs:legSims,
      track:fullTrack,
      failed,
      note: failed ? 'route-failed-before-waypoint' : 'deterministic-reach-plus-reverse-router'
    };

    const staticResults = predict();
    renderCourseList();
    renderTable(staticResults);
    renderMap(staticResults);

    if(failed){
      const bad = legSims.find(l => l.failed || l.guardLimited);
      setTideStatus?.(`Simulation stopped: ${bad?.from?.name || 'leg'} → ${bad?.to?.name || 'mark'} did not reach waypoint. ${bad?.failureReason || ''}`, true);
    }

    return lastSimulation;
  };

  simulateCourse.__deterministicReachWrapped = true;
}


// ---------------- Simplified layout wiring ----------------
// Inputs now owns Use Current Model. Existing code still expects #currentSource,
// so provide a virtual currentSource value via helper and sync status/UI.

function useCurrentModelEnabled(){
  const v = $('useCurrentModel')?.value;
  return v !== 'No';
}

function selectedCurrentMode(){
  return useCurrentModelEnabled() ? 'tdm' : 'manual';
}

// Override code paths that directly read #currentSource by ensuring a hidden shim exists.
function ensureCurrentSourceShim(){
  let el = $('currentSource');
  if(!el){
    el = document.createElement('select');
    el.id = 'currentSource';
    el.hidden = true;
    el.innerHTML = '<option value="manual">Manual current entry</option><option value="tdm">Solent Currents</option>';
    document.body.appendChild(el);
  }
  el.value = selectedCurrentMode();
  return el;
}

function readCurrentRateScale(){
  const v = Number($('currentRateScalePct')?.value || 100);
  return Number.isFinite(v) ? v / 100 : 1;
}

function syncSimplifiedLayoutUi(){
  ensureCurrentSourceShim();

  const useModel = useCurrentModelEnabled();
  const manual = !useModel;

  const manualDetails = $('manualCurrentDetails');
  if(manualDetails){
    manualDetails.hidden = !manual;
    manualDetails.open = manual;
  }

  document.querySelectorAll('.manual-current-field').forEach(el => {
    el.style.display = manual ? '' : 'none';
  });

  if(useModel){
    setTideStatus?.('Solent Currents selected: basic table and simulation use .tdm current. Manual current fallback hidden.');
  } else {
    setTideStatus?.('Manual current selected: basic table and simulation use manual set/drift.');
  }
}

function bindSimplifiedLayoutUi(){
  ensureCurrentSourceShim();

  $('useCurrentModel')?.addEventListener('change', () => {
    ensureCurrentSourceShim();
    syncSimplifiedLayoutUi();
    updateAll?.();
  });

  $('currentRateScalePct')?.addEventListener('input', () => {
    lastSimulation = null;
    updateAll?.();
    if(typeof drawCurrentArrows === 'function') drawCurrentArrows();
  });
  $('currentRateScalePct')?.addEventListener('change', () => {
    lastSimulation = null;
    updateAll?.();
    if(typeof drawCurrentArrows === 'function') drawCurrentArrows();
  });

  syncSimplifiedLayoutUi();
}
window.addEventListener('DOMContentLoaded', bindSimplifiedLayoutUi);

// Scale Solent Currents rates independently of tide factor.
if(typeof getTdmCurrentAt === 'function' && !getTdmCurrentAt.__rateScaleWrapped){
  const __getTdmCurrentAtRateBase = getTdmCurrentAt;
  getTdmCurrentAt = function(lat, lon, time){
    const c = __getTdmCurrentAtRateBase(lat, lon, time);
    if(c && c.source === 'tdm'){
      const scale = readCurrentRateScale();
      const east = Number.isFinite(c.east) ? c.east * scale : null;
      const north = Number.isFinite(c.north) ? c.north * scale : null;
      if(east !== null && north !== null){
        const drift = Math.hypot(east, north);
        const set = norm360(Math.atan2(east, north) * DEG);
        return {...c, east, north, drift, set, currentRateScale:scale};
      }
      if(Number.isFinite(c.drift)){
        return {...c, drift:c.drift * scale, currentRateScale:scale};
      }
    }
    return c;
  };
  getTdmCurrentAt.__rateScaleWrapped = true;
}

// Overlay point vectors use raw record interpolation, so scale there too.
if(typeof currentVectorAtPointRecord === 'function' && !currentVectorAtPointRecord.__rateScaleWrapped){
  const __currentVectorAtPointRecordRateBase = currentVectorAtPointRecord;
  currentVectorAtPointRecord = function(point, time){
    const c = __currentVectorAtPointRecordRateBase(point, time);
    if(c && Number.isFinite(c.east) && Number.isFinite(c.north)){
      const scale = readCurrentRateScale();
      const east = c.east * scale;
      const north = c.north * scale;
      const drift = Math.hypot(east, north);
      const set = norm360(Math.atan2(east, north) * DEG);
      return {...c, east, north, drift, set, currentRateScale:scale};
    }
    return c;
  };
  currentVectorAtPointRecord.__rateScaleWrapped = true;
}

// One picked point replaces separate start/finish pickers.
let pickedPoint = {id:'picked_point', name:'Picked Point', lat:NaN, lon:NaN, custom:true};

function readPickedPoint(){
  const lat = Number($('pickedLat')?.value);
  const lon = Number($('pickedLon')?.value);
  pickedPoint.lat = Number.isFinite(lat) ? lat : NaN;
  pickedPoint.lon = Number.isFinite(lon) ? lon : NaN;
  return pickedPoint;
}

function setPickedPoint(lat, lon, label='Picked point'){
  const latEl = $('pickedLat');
  const lonEl = $('pickedLon');
  if(latEl) latEl.value = Number(lat).toFixed(6);
  if(lonEl) lonEl.value = Number(lon).toFixed(6);
  readPickedPoint();
  setPickHint?.(`${label}: ${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`);
}

function makePickedCoursePoint(name, id){
  readPickedPoint();
  return {id, name, lat:pickedPoint.lat, lon:pickedPoint.lon, custom:true};
}

function usePickedAsStart(){
  const p = makePickedCoursePoint('Custom Start', 'custom_start');
  if(!validPoint(p)) return alert('Pick or enter a valid point first.');
  course = course.filter(m => m.id !== 'custom_start');
  course.unshift(p);
  customStart.lat = p.lat; customStart.lon = p.lon;
  updateAll();
}

function usePickedAsFinish(){
  const p = makePickedCoursePoint('Custom Finish', 'custom_finish');
  if(!validPoint(p)) return alert('Pick or enter a valid point first.');
  course = course.filter(m => m.id !== 'custom_finish');
  course.push(p);
  customFinish.lat = p.lat; customFinish.lon = p.lon;
  updateAll();
}

function insertPickedAsMark(){
  const p = makePickedCoursePoint(`Picked ${course.length + 1}`, `picked_${Date.now()}`);
  if(!validPoint(p)) return alert('Pick or enter a valid point first.');
  course.push(p);
  updateAll();
}

function bindPickedPointControls(){
  $('pickPoint')?.addEventListener('click', () => {
    pickMode = 'picked';
    document.querySelectorAll('.pick-active').forEach(el => el.classList.remove('pick-active'));
    $('pickPoint')?.classList.add('pick-active');
    setPickHint('Click the chart or an existing mark to capture the picked point.');
    map?.getContainer().classList.add('crosshair');
  });

  $('usePickedStart')?.addEventListener('click', usePickedAsStart);
  $('usePickedFinish')?.addEventListener('click', usePickedAsFinish);
  $('insertPickedMark')?.addEventListener('click', insertPickedAsMark);
}
window.addEventListener('DOMContentLoaded', bindPickedPointControls);

// Patch map picking handlers by wrapping setCustomPoint for pickMode='picked'.
if(typeof setCustomPoint === 'function' && !setCustomPoint.__pickedPointWrapped){
  const __setCustomPointBase = setCustomPoint;
  setCustomPoint = function(which, lat, lon){
    if(which === 'picked'){
      setPickedPoint(lat, lon, 'Picked point set');
      readPickedPoint();
      return;
    }
    return __setCustomPointBase(which, lat, lon);
  };
  setCustomPoint.__pickedPointWrapped = true;
}

// Patch refresh buttons for picked mode.
if(typeof refreshPickButtons === 'function' && !refreshPickButtons.__pickedPointWrapped){
  const __refreshPickButtonsBase = refreshPickButtons;
  refreshPickButtons = function(){
    __refreshPickButtonsBase();
    $('pickPoint')?.classList.toggle('pick-active', pickMode === 'picked');
  };
  refreshPickButtons.__pickedPointWrapped = true;
}

// Override updateTideModeUi to remove old current source wording.
if(typeof updateTideModeUi === 'function' && !updateTideModeUi.__simplifiedWrapped){
  updateTideModeUi = function(){
    ensureCurrentSourceShim();
    const mode = selectedCurrentMode();
    if(mode === 'manual'){
      setTideStatus?.('Manual current selected: use Manual Current drop-down below.');
    } else if(tideDb){
      setTideStatus?.(`Solent Currents loaded: ${tideDb.records.length} stream points. Enter Portsmouth HW and heights.`);
    } else {
      setTideStatus?.('Solent Currents selected: embedded model loading.');
    }
    syncSimplifiedLayoutUi();
  };
  updateTideModeUi.__simplifiedWrapped = true;
}

// Patch static current selection helper if present.
if(typeof staticLegCurrentFor === 'function' && !staticLegCurrentFor.__simplifiedCurrentWrapped){
  staticLegCurrentFor = function(from, to, legIndex, raceStartTime){
    const inputs = readInputs();
    if(selectedCurrentMode() !== 'tdm' || !tideDb?.records?.length || !portsmouthHwTime){
      return {set:inputs.set, drift:inputs.drift, source:'manual'};
    }
    const mid = {lat:(Number(from.lat)+Number(to.lat))/2, lon:(Number(from.lon)+Number(to.lon))/2};
    let t = raceStartTime || readSimulationInputs?.().raceStart || new Date();
    if(!(t instanceof Date) || Number.isNaN(t.getTime())) t = new Date();
    return getTdmCurrentAt(mid.lat, mid.lon, t);
  };
  staticLegCurrentFor.__simplifiedCurrentWrapped = true;
}


// ---------------- Reaching leg tide-aware CTS fix ----------------
// Reaching/free legs should NOT simply draw a direct line to the mark.
// Each step must:
// 1) read local current from selected source, usually SolentCurrents.tdm,
// 2) calculate TWA from current position to mark and GWD/TWD input,
// 3) get BSP from polar/manual target,
// 4) solve CTS so the resulting COG closes the mark,
// 5) advance over ground using boat vector + current vector.
// This produces a curved ground track when current changes with position/time.

function selectedCurrentAtPosition(lat, lon, time){
  const inputs = readInputs();
  const mode = (typeof selectedCurrentMode === 'function')
    ? selectedCurrentMode()
    : (($('currentSource')?.value === 'tdm') ? 'tdm' : 'manual');

  if(mode === 'tdm' && tideDb?.records?.length && portsmouthHwTime){
    return getTdmCurrentAt(lat, lon, time);
  }

  return {
    set: Number(inputs.set || 0),
    drift: Number(inputs.drift || 0),
    east: vecFrom(Number(inputs.set || 0), Number(inputs.drift || 0)).x,
    north: vecFrom(Number(inputs.set || 0), Number(inputs.drift || 0)).y,
    source:'manual'
  };
}

function waterWindAtPosition(lat, lon, time, inputs){
  // For now, GWD/GWS are entered as ground-referenced wind.
  // Convert ground wind vector TO, subtract water/current vector TO, convert back to FROM.
  // If you later decide inputs are already water true wind, this function can be bypassed.
  const current = selectedCurrentAtPosition(lat, lon, time);
  const groundWindTo = vecFrom(norm360(inputs.twd + 180), inputs.tws);
  const waterWindTo = {
    x: groundWindTo.x - (current.east ?? currentToVector(current.set, current.drift).x),
    y: groundWindTo.y - (current.north ?? currentToVector(current.set, current.drift).y)
  };
  const tws = Math.hypot(waterWindTo.x, waterWindTo.y);
  const windTo = norm360(Math.atan2(waterWindTo.x, waterWindTo.y) * DEG);
  const twd = norm360(windTo + 180);
  return {twd, tws, current};
}

function reachBspForHeading(headingToMark, inputs, localWind){
  const signedTwa = norm180(headingToMark - localWind.twd);
  const absTwa = Math.abs(signedTwa);

  if(inputs.usePolar && polar?.rows?.length){
    const ps = polarSpeed(localWind.tws, absTwa) * inputs.polarFactor;
    if(Number.isFinite(ps) && ps > 0) return {bsp:ps, signedTwa, absTwa, source:'polar'};
  }

  const target = targetFor('reach', {...inputs, twd:localWind.twd, tws:localWind.tws}, signedTwa);
  return {bsp:Number(target.bsp || inputs.reachBsp || 0), signedTwa, absTwa, source:'manual'};
}

function solveReachLegTideAware(start, mark, inputs, simCfg, startTime){
  let p = {lat:start.lat, lon:start.lon};
  let t = new Date(startTime.getTime());

  const legDist = distanceNm(start, mark);
  const captureRadiusNm = Math.max(0.025, Math.min(0.06, legDist * 0.015));
  const stepSec = Math.max(5, Math.min(90, Number(simCfg.stepSec || 30)));
  const maxSec = Math.max(900, legDist / 2.5 * 3600);

  const track = [{lat:p.lat, lon:p.lon, time:new Date(t.getTime()), mode:'start'}];
  let elapsed = 0, portSec = 0, stbdSec = 0;
  let guard = 0;
  let bestDist = distanceNm(p, mark);
  let noProgress = 0;

  while(elapsed < maxSec && guard < 2500){
    guard += 1;

    const dist = distanceNm(p, mark);
    if(dist <= captureRadiusNm) break;

    const localWind = waterWindAtPosition(p.lat, p.lon, t, inputs);
    const current = localWind.current;
    const bearingNow = bearingDeg(p, mark);
    const bspInfo = reachBspForHeading(bearingNow, inputs, localWind);
    const bsp = Number(bspInfo.bsp);

    if(!Number.isFinite(bsp) || bsp <= 0.1){
      return {
        track, elapsedSec:elapsed, portSec, stbdSec, directSec:0, endTime:t,
        finalDist:dist, guardLimited:true, reached:false, failed:true,
        reason:'No valid reach BSP from polar/manual targets'
      };
    }

    // Solve heading through the water so the resultant COG heads at the mark from current position.
    const cts = solveCurrentCorrectedHeadingToMark(bearingNow, bsp, current.set, current.drift);

    // Guard against impossible current.
    const closingVec = vecFrom(cts.cog, cts.sog);
    const closingKn = vecProject(closingVec, bearingNow);
    if(!Number.isFinite(closingKn) || closingKn <= 0.05){
      return {
        track, elapsedSec:elapsed, portSec, stbdSec, directSec:0, endTime:t,
        finalDist:dist, guardLimited:true, reached:false, failed:true,
        reason:'No positive closing speed on reach'
      };
    }

    let dt = Math.min(stepSec, maxSec - elapsed);
    let next = destinationPointNm(p, cts.cog, cts.sog * dt / 3600);

    // Finish cleanly if the segment enters mark capture radius.
    const hit = (typeof crs2SegmentHit === 'function')
      ? crs2SegmentHit(p, next, mark, captureRadiusNm)
      : {hit: distanceNm(next, mark) <= captureRadiusNm, frac:1};

    if(hit.hit){
      dt *= Math.max(0.05, Math.min(1, hit.frac || 1));
      next = {lat:mark.lat, lon:mark.lon};
    }

    // Land check. Do not draw through land. Try small CTS fan if required.
    let headingUsed = cts.heading;
    let cogUsed = cts.cog;
    let sogUsed = cts.sog;
    let legal = (typeof crs2SafeStep === 'function') ? crs2SafeStep(p, next) : true;

    if(!legal){
      let found = false;
      for(const off of [-8,8,-16,16,-25,25,-35,35]){
        const h = norm360(cts.heading + off);
        const boat = vecFrom(h, bsp);
        const curVec = currentToVector(current.set, current.drift);
        const ground = addVec(boat, curVec);
        const cog = norm360(Math.atan2(ground.x, ground.y) * DEG);
        const sog = Math.hypot(ground.x, ground.y);
        const candidate = destinationPointNm(p, cog, sog * dt / 3600);
        if(((typeof crs2SafeStep === 'function') ? crs2SafeStep(p, candidate) : true) && distanceNm(candidate, mark) < dist){
          headingUsed = h; cogUsed = cog; sogUsed = sog; next = candidate; found = true; break;
        }
      }
      if(!found){
        return {
          track, elapsedSec:elapsed, portSec, stbdSec, directSec:0, endTime:t,
          finalDist:dist, guardLimited:true, reached:false, failed:true,
          reason:'Land mask blocks reaching route'
        };
      }
    }

    const nextDist = distanceNm(next, mark);
    if(nextDist < bestDist - 0.001){
      bestDist = nextDist;
      noProgress = 0;
    } else {
      noProgress += 1;
    }

    // Prevent endless wandering, but allow gentle curved paths.
    if(noProgress > 8 && dist < legDist * 0.35){
      return {
        track, elapsedSec:elapsed, portSec, stbdSec, directSec:0, endTime:t,
        finalDist:dist, guardLimited:true, reached:false, failed:true,
        reason:'Reach stopped making progress to waypoint'
      };
    }

    elapsed += dt;
    t = new Date(t.getTime() + dt * 1000);

    const board = norm180(headingUsed - localWind.twd) < 0 ? 'port' : 'stbd';
    if(board === 'port') portSec += dt;
    else stbdSec += dt;

    const pt = {
      lat:next.lat,
      lon:next.lon,
      time:new Date(t.getTime()),
      mode:board,
      heading:headingUsed,
      cog:cogUsed,
      sog:sogUsed,
      bsp,
      twa:bspInfo.signedTwa,
      twd:localWind.twd,
      tws:localWind.tws,
      current,
      deterministicReach:true,
      tideAwareReach:true
    };
    track.push(pt);
    p = {lat:next.lat, lon:next.lon};

    if(Math.abs(next.lat - mark.lat) < 1e-10 && Math.abs(next.lon - mark.lon) < 1e-10) break;
  }

  const finalDist = distanceNm(p, mark);
  const reached = finalDist <= captureRadiusNm || (Math.abs(p.lat - mark.lat) < 1e-10 && Math.abs(p.lon - mark.lon) < 1e-10);

  if(reached){
    const last = track[track.length - 1];
    last.lat = mark.lat;
    last.lon = mark.lon;
  }

  return {
    track,
    elapsedSec:elapsed,
    portSec,
    stbdSec,
    directSec:0,
    endTime:t,
    finalDist:reached ? 0 : finalDist,
    guardLimited:!reached,
    reached,
    failed:!reached,
    reason:reached ? '' : 'Tide-aware reach did not close waypoint'
  };
}

// Replace previous deterministic reach solver.
if(typeof solveReachLegDeterministic === 'function' && !solveReachLegDeterministic.__tideAwareWrapped){
  solveReachLegDeterministic = function(start, mark, inputs, simCfg, startTime){
    return solveReachLegTideAware(start, mark, inputs, simCfg, startTime);
  };
  solveReachLegDeterministic.__tideAwareWrapped = true;
}

// Ensure any later simulateCourse override that calls solveReachLegDeterministic now gets the tide-aware version.


// ---------------- Curved reaching route aim-point solver ----------------
// The previous reach solver made COG point directly at the mark every step, which
// necessarily draws a straight ground track. This version estimates the future tidal
// displacement over the remaining leg and aims at an up-current compensated virtual mark.
// As the boat/time/current changes, that aim point moves, so the plotted ground track curves.

function vectorToSetDrift(v){
  return {
    set: norm360(Math.atan2(v.x, v.y) * DEG),
    drift: Math.hypot(v.x, v.y)
  };
}

function pointOffsetByVectorNm(point, eastNm, northNm){
  const northPoint = destinationPointNm(point, northNm >= 0 ? 0 : 180, Math.abs(northNm));
  return destinationPointNm(northPoint, eastNm >= 0 ? 90 : 270, Math.abs(eastNm));
}

function estimateFutureCurrentDisplacementNm(start, mark, time, remainingSec, samples=5){
  let eastNm = 0;
  let northNm = 0;

  const total = Math.max(1, remainingSec);
  const brg = bearingDeg(start, mark);
  const dist = distanceNm(start, mark);

  for(let i=0; i<samples; i++){
    const f0 = i / samples;
    const f1 = (i + 1) / samples;
    const fm = (f0 + f1) / 2;

    // Sample along current rough line to mark. This is intentionally cheap/mobile-safe.
    const samplePos = destinationPointNm(start, brg, dist * fm);
    const sampleTime = new Date(time.getTime() + total * fm * 1000);
    const c = selectedCurrentAtPosition(samplePos.lat, samplePos.lon, sampleTime);
    const cv = currentToVector(c.set, c.drift);
    const dtHours = total / samples / 3600;

    eastNm += cv.x * dtHours;
    northNm += cv.y * dtHours;
  }

  return {eastNm, northNm};
}

function solveReachLegCurvedAimpoint(start, mark, inputs, simCfg, startTime){
  let p = {lat:start.lat, lon:start.lon};
  let t = new Date(startTime.getTime());

  const legDist = distanceNm(start, mark);
  const captureRadiusNm = Math.max(0.025, Math.min(0.06, legDist * 0.015));
  const stepSec = Math.max(5, Math.min(90, Number(simCfg.stepSec || 30)));
  const maxSec = Math.max(900, legDist / 2.5 * 3600);

  const track = [{lat:p.lat, lon:p.lon, time:new Date(t.getTime()), mode:'start'}];
  let elapsed = 0, portSec = 0, stbdSec = 0;
  let guard = 0, noProgress = 0;
  let bestDist = distanceNm(p, mark);

  while(elapsed < maxSec && guard < 2500){
    guard += 1;

    const distToMark = distanceNm(p, mark);
    if(distToMark <= captureRadiusNm) break;

    const localWind = waterWindAtPosition(p.lat, p.lon, t, inputs);
    const currentNow = localWind.current;

    // First-pass BSP using direct mark bearing.
    const directBearing = bearingDeg(p, mark);
    const directBspInfo = reachBspForHeading(directBearing, inputs, localWind);
    let bsp = Number(directBspInfo.bsp);

    if(!Number.isFinite(bsp) || bsp <= 0.1){
      return {
        track, elapsedSec:elapsed, portSec, stbdSec, directSec:0, endTime:t,
        finalDist:distToMark, guardLimited:true, reached:false, failed:true,
        reason:'No valid reach BSP from polar/manual targets'
      };
    }

    // Estimate remaining time and future tide displacement.
    const roughClosing = Math.max(0.1, bsp + Math.max(0, currentNow.drift * 0.2));
    const remainingSec = Math.min(maxSec - elapsed, distToMark / roughClosing * 3600);
    const futureSet = estimateFutureCurrentDisplacementNm(p, mark, t, remainingSec, 5);

    // Aim up-current: where the boat should point its ground-route target so accumulated
    // current set carries the ground track to the actual mark.
    const aimPoint = pointOffsetByVectorNm(mark, -futureSet.eastNm, -futureSet.northNm);
    const aimBearing = bearingDeg(p, aimPoint);

    // Recompute BSP at the actual aimed heading/TWA.
    const bspInfo = reachBspForHeading(aimBearing, inputs, localWind);
    bsp = Number(bspInfo.bsp);
    if(!Number.isFinite(bsp) || bsp <= 0.1) bsp = Number(directBspInfo.bsp);

    // Solve heading through water so COG aims at the moving compensated aim point.
    const cts = solveCurrentCorrectedHeadingToMark(aimBearing, bsp, currentNow.set, currentNow.drift);

    const closingVecToMark = vecFrom(cts.cog, cts.sog);
    const closingKn = vecProject(closingVecToMark, directBearing);
    if(!Number.isFinite(closingKn) || closingKn <= 0.02){
      return {
        track, elapsedSec:elapsed, portSec, stbdSec, directSec:0, endTime:t,
        finalDist:distToMark, guardLimited:true, reached:false, failed:true,
        reason:'No positive closing speed on curved reach'
      };
    }

    let dt = Math.min(stepSec, maxSec - elapsed);
    let next = destinationPointNm(p, cts.cog, cts.sog * dt / 3600);

    // Capture actual mark if this segment reaches it.
    const hit = (typeof crs2SegmentHit === 'function')
      ? crs2SegmentHit(p, next, mark, captureRadiusNm)
      : {hit: distanceNm(next, mark) <= captureRadiusNm, frac:1};

    if(hit.hit){
      dt *= Math.max(0.05, Math.min(1, hit.frac || 1));
      next = {lat:mark.lat, lon:mark.lon};
    }

    let headingUsed = cts.heading;
    let cogUsed = cts.cog;
    let sogUsed = cts.sog;

    // Land check. If aimpoint route crosses land, use a small fan biased toward closing.
    const safe = (typeof crs2SafeStep === 'function') ? crs2SafeStep(p, next) : true;
    if(!safe){
      let found = false;
      for(const off of [-10,10,-20,20,-35,35,-50,50]){
        const h = norm360(cts.heading + off);
        const boat = vecFrom(h, bsp);
        const curVec = currentToVector(currentNow.set, currentNow.drift);
        const ground = addVec(boat, curVec);
        const cog = norm360(Math.atan2(ground.x, ground.y) * DEG);
        const sog = Math.hypot(ground.x, ground.y);
        const candidate = destinationPointNm(p, cog, sog * dt / 3600);

        if(((typeof crs2SafeStep === 'function') ? crs2SafeStep(p, candidate) : true) &&
           distanceNm(candidate, mark) < distToMark){
          next = candidate;
          headingUsed = h;
          cogUsed = cog;
          sogUsed = sog;
          found = true;
          break;
        }
      }

      if(!found){
        return {
          track, elapsedSec:elapsed, portSec, stbdSec, directSec:0, endTime:t,
          finalDist:distToMark, guardLimited:true, reached:false, failed:true,
          reason:'Land mask blocks curved reaching route'
        };
      }
    }

    const nextDist = distanceNm(next, mark);
    if(nextDist < bestDist - 0.001){
      bestDist = nextDist;
      noProgress = 0;
    } else {
      noProgress += 1;
    }

    if(noProgress > 10 && distToMark < legDist * 0.35){
      return {
        track, elapsedSec:elapsed, portSec, stbdSec, directSec:0, endTime:t,
        finalDist:distToMark, guardLimited:true, reached:false, failed:true,
        reason:'Curved reach stopped making progress to waypoint'
      };
    }

    elapsed += dt;
    t = new Date(t.getTime() + dt * 1000);

    const board = norm180(headingUsed - localWind.twd) < 0 ? 'port' : 'stbd';
    if(board === 'port') portSec += dt;
    else stbdSec += dt;

    const pt = {
      lat:next.lat,
      lon:next.lon,
      time:new Date(t.getTime()),
      mode:board,
      heading:headingUsed,
      cog:cogUsed,
      sog:sogUsed,
      bsp,
      twa:bspInfo.signedTwa,
      twd:localWind.twd,
      tws:localWind.tws,
      current:currentNow,
      aimLat:aimPoint.lat,
      aimLon:aimPoint.lon,
      futureSetEastNm:futureSet.eastNm,
      futureSetNorthNm:futureSet.northNm,
      curvedReach:true
    };

    track.push(pt);
    p = {lat:next.lat, lon:next.lon};

    if(Math.abs(next.lat - mark.lat) < 1e-10 && Math.abs(next.lon - mark.lon) < 1e-10) break;
  }

  const finalDist = distanceNm(p, mark);
  const reached = finalDist <= captureRadiusNm || (Math.abs(p.lat - mark.lat) < 1e-10 && Math.abs(p.lon - mark.lon) < 1e-10);

  if(reached){
    const last = track[track.length - 1];
    last.lat = mark.lat;
    last.lon = mark.lon;
  }

  return {
    track,
    elapsedSec:elapsed,
    portSec,
    stbdSec,
    directSec:0,
    endTime:t,
    finalDist:reached ? 0 : finalDist,
    guardLimited:!reached,
    reached,
    failed:!reached,
    reason:reached ? '' : 'Curved reach did not close waypoint'
  };
}

// Override all prior reaching solvers.
solveReachLegDeterministic = function(start, mark, inputs, simCfg, startTime){
  return solveReachLegCurvedAimpoint(start, mark, inputs, simCfg, startTime);
};

solveReachLegTideAware = function(start, mark, inputs, simCfg, startTime){
  return solveReachLegCurvedAimpoint(start, mark, inputs, simCfg, startTime);
};
