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
    polarFactor: Number($('polarFactor').value || 1), magVar: Number($('magVar').value || 0)
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
      setPickHint(`${pickMode === 'start' ? 'Start' : 'Finish'} set from chart: ${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`);
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
          setPickHint(`${pickMode === 'start' ? 'Start' : 'Finish'} set from mark: ${m.name} (${m.lat.toFixed(6)}, ${m.lon.toFixed(6)})`);
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
$('addCustomStart').onclick = insertCustomStart;
$('addCustomFinish').onclick = insertCustomFinish;
$('pickStart').onclick = () => { pickMode = 'start'; refreshPickButtons(); setPickHint('Click the chart to place the custom start.'); map?.getContainer().classList.add('crosshair'); };
$('pickFinish').onclick = () => { pickMode = 'finish'; refreshPickButtons(); setPickHint('Click the chart to place the custom finish.'); map?.getContainer().classList.add('crosshair'); };
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
  const lengthNm = Math.max(0.015, driftKt * 0.14);
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
