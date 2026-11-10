/* Суфлёр: улучшение звука и картинки.
   Звук: шумодав RNNoise → срез низа 80 Гц → минус «бубнёж» 300 Гц → разборчивость 4 кГц → компрессор → лимитер.
   Картинка: WebGL-шейдер поверх кадра камеры — сглаживание кожи, резкость, яркость, контраст, насыщенность, тепло.
   Одно и то же изображение идёт и в превью, и в запись. */
(() => {
const DEF = {
  voice: true, denoise: true, video: true,
  bri: 0.03, con: 1.06, sat: 1.06, warm: 0.03, sharp: 0.35, smooth: 0.3, expo: null
};
const load = () => { try{ return { ...DEF, ...JSON.parse(localStorage.getItem('tp_fx') || '{}') }; }catch(_){ return { ...DEF }; } };
const FX = { s: load(), gl: null, canvas: null, ctx: null, holding: false };
FX.save = () => { try{ localStorage.setItem('tp_fx', JSON.stringify(FX.s)); }catch(_){} };

/* ================= ЗВУК ================= */
FX.prepareAudio = () => {
  // вызывается прямо из нажатия кнопки: iOS запускает звук только по жесту пользователя
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    FX.ctx = new AC({ sampleRate: 48000 });
    FX.ctx.resume?.();
  }catch(_){ FX.ctx = null; }
};

FX.initAudio = async stream => {
  const tr = stream.getAudioTracks()[0];
  const ctx = FX.ctx;
  if(!tr || !ctx || !ctx.createMediaStreamDestination) return null;
  try{
    const g = v => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const src = ctx.createMediaStreamSource(new MediaStream([tr]));
    const mid = g(1), nsWet = g(0), nsDry = g(1);

    // шумодав на нейросети, только при 48 кГц
    let ns = null;
    if(ctx.audioWorklet && ctx.sampleRate === 48000 && window.AudioWorkletNode){
      try{
        await ctx.audioWorklet.addModule('vendor/rnnoise/workletProcessor.js');
        const simd = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]));
        const wasm = await (await fetch(simd ? 'vendor/rnnoise_simd.wasm' : 'vendor/rnnoise.wasm')).arrayBuffer();
        ns = new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/rnnoise', { processorOptions: { maxChannels: 1, wasmBinary: wasm } });
        src.connect(ns); ns.connect(nsWet);
      }catch(e){ ns = null; console.warn('RNNoise недоступен', e); }
    }
    src.connect(nsDry); nsWet.connect(mid); nsDry.connect(mid);

    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 80; hp.Q.value = 0.707;
    const mud = ctx.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 300; mud.Q.value = 1; mud.gain.value = -2;
    const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 4000; pres.Q.value = 0.9; pres.gain.value = 3;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -26; comp.knee.value = 8; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.18;
    const makeup = g(1.8);
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.05;
    const procWet = g(0), procDry = g(1), out = g(1);
    mid.connect(hp); hp.connect(mud); mud.connect(pres); pres.connect(comp); comp.connect(makeup); makeup.connect(lim); lim.connect(procWet);
    mid.connect(procDry);
    procWet.connect(out); procDry.connect(out);

    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    out.connect(dest);
    const an = ctx.createAnalyser(); an.fftSize = 1024; out.connect(an);

    FX.audio = { nsWet, nsDry, procWet, procDry, an, ns, dest, buf: new Float32Array(an.fftSize) };
    FX.applyAudio();
    return dest.stream.getAudioTracks()[0];
  }catch(e){
    console.warn('Обработка звука недоступна', e);
    return null;
  }
};

FX.applyAudio = () => {
  const a = FX.audio; if(!a) return;
  const t = FX.ctx.currentTime, set = (n, v) => n.gain.setTargetAtTime(v, t, 0.02);
  const dn = FX.s.denoise && !!a.ns;
  set(a.nsWet, dn ? 1 : 0); set(a.nsDry, dn ? 0 : 1);
  set(a.procWet, FX.s.voice ? 1 : 0); set(a.procDry, FX.s.voice ? 0 : 1);
};

FX.level = () => {
  const a = FX.audio; if(!a) return -100;
  a.an.getFloatTimeDomainData(a.buf);
  let s = 0; for(let i = 0; i < a.buf.length; i++) s += a.buf[i] * a.buf[i];
  return 20 * Math.log10(Math.sqrt(s / a.buf.length) + 1e-6);
};

/* Дорожка для записи: обработанная, если цепочка поднялась, иначе исходная */
FX.audioTracks = stream => FX.audio ? FX.audio.dest.stream.getAudioTracks() : stream.getAudioTracks();

/* ================= КАРТИНКА ================= */
const VS = `attribute vec2 p; varying vec2 v;
void main(){ v = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.,1.); }`;
const FS = `precision mediump float;
varying vec2 v;
uniform sampler2D t; uniform vec2 sc, of, px;
uniform float on, bri, con, sat, warm, sharp, smth;
vec3 tx(vec2 uv, vec2 o){ return texture2D(t, uv + o*px).rgb; }
float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
void main(){
  vec2 uv = v*sc + of;
  vec3 c0 = tx(uv, vec2(0.));
  if(on < 0.5){ gl_FragColor = vec4(c0,1.); return; }
  vec3 c = c0;
  if(smth > 0.01){
    float l0 = lum(c0); vec3 sum = c0; float ws = 1.;
    for(int i = 0; i < 8; i++){
      float a = float(i)*0.7854;
      vec2 d = vec2(cos(a), sin(a)) * (mod(float(i), 2.) < 0.5 ? 1.8 : 3.4);
      vec3 s1 = tx(uv, d); float e1 = lum(s1)-l0; float w1 = exp(-e1*e1*350.);
      sum += s1*w1; ws += w1;
    }
    vec3 sm = sum/ws;
    float cb = -0.169*c0.r - 0.331*c0.g + 0.5*c0.b;
    float cr =  0.5*c0.r - 0.419*c0.g - 0.081*c0.b;
    float skin = smoothstep(0.0,0.04,cr)*(1.-smoothstep(0.2,0.26,cr))*smoothstep(-0.24,-0.16,cb)*(1.-smoothstep(0.0,0.06,cb));
    c = mix(c0, sm, smth*skin);
  }
  if(sharp > 0.01){
    vec3 b = (tx(uv,vec2(1.,0.)) + tx(uv,vec2(-1.,0.)) + tx(uv,vec2(0.,1.)) + tx(uv,vec2(0.,-1.)))*0.25;
    c += (c0 - b)*sharp*1.6;
  }
  c += bri;
  c = (c - 0.5)*con + 0.5;
  float l = lum(c); c = mix(vec3(l), c, sat);
  c += vec3(warm, warm*0.25, -warm);
  gl_FragColor = vec4(clamp(c,0.,1.),1.);
}`;

FX.initVideo = (video, canvas, dims) => {
  FX.canvas = canvas; FX.video = video; FX.dims = dims;
  let gl = null;
  try{ gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, alpha: false }); }catch(_){}
  if(!gl) return false;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  try{
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr); if(!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]
      .forEach(([k, val]) => gl.texParameteri(gl.TEXTURE_2D, k, val));
    const U = {}; ['t','sc','of','px','on','bri','con','sat','warm','sharp','smth'].forEach(n => U[n] = gl.getUniformLocation(pr, n));
    gl.uniform1i(U.t, 0);
    FX.gl = gl; FX.U = U;
  }catch(e){ console.warn('WebGL недоступен', e); FX.gl = null; return false; }

  FX.running = true;
  // Сторож частоты кадров: если обработка тормозит, сначала выключаем сглаживание, потом всю обработку картинки
  const target = Math.min(30, video.srcObject?.getVideoTracks()[0]?.getSettings().frameRate || 30);
  let n = 0, t0 = performance.now(), slow = 0;
  FX.lite = false;
  const watch = () => {
    n++;
    const dt = performance.now() - t0;
    if(dt < 2000) return;
    const fps = n * 1000 / dt; n = 0; t0 = performance.now();
    FX.fps = fps;
    if(!FX.s.video || FX.holding) { slow = 0; return; }
    slow = fps < target * 0.75 ? slow + 1 : 0;
    if(slow >= 2){
      slow = 0;
      if(FX.s.smooth > 0 && !FX.lite){ FX.lite = true; FX.onWarn?.('Телефон не успевает: сглаживание кожи выключено, чтобы видео не дёргалось.'); }
      else { FX.s.video = false; FX.save(); FX.onVideoToggle?.(); FX.onWarn?.('Телефон не успевает обрабатывать картинку: улучшение выключено.'); }
    }
  };
  const frame = () => {
    if(!FX.running) return;
    // без улучшения превью показывает само видео; во время записи с холста рисуем дальше без эффектов, чтобы кадр не застыл
    if(FX.s.video || FX.recording){ FX.draw(); watch(); }
    if(video.requestVideoFrameCallback) video.requestVideoFrameCallback(frame);
    else requestAnimationFrame(frame);
  };
  if(video.requestVideoFrameCallback) video.requestVideoFrameCallback(frame); else requestAnimationFrame(frame);
  return true;
};

FX.draw = () => {
  const gl = FX.gl, v = FX.video, U = FX.U, s = FX.s;
  if(!gl || !v.videoWidth) return;
  const [W, H] = FX.dims();
  if(FX.canvas.width !== W || FX.canvas.height !== H){ FX.canvas.width = W; FX.canvas.height = H; }
  gl.viewport(0, 0, W, H);
  try{ gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v); }catch(_){ return; }
  const vw = v.videoWidth, vh = v.videoHeight, k = Math.max(W / vw, H / vh);
  const sx = (W / k) / vw, sy = (H / k) / vh;
  gl.uniform2f(U.sc, sx, sy); gl.uniform2f(U.of, (1 - sx) / 2, (1 - sy) / 2);
  gl.uniform2f(U.px, 1 / vw, 1 / vh);
  gl.uniform1f(U.on, s.video && !FX.holding ? 1 : 0);
  gl.uniform1f(U.bri, s.bri); gl.uniform1f(U.con, s.con); gl.uniform1f(U.sat, s.sat);
  gl.uniform1f(U.warm, s.warm); gl.uniform1f(U.sharp, s.sharp); gl.uniform1f(U.smth, FX.lite ? 0 : s.smooth);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
};

/* ================= КАМЕРА: экспозиция ================= */
FX.initCamera = track => {
  FX.track = track;
  let caps = {};
  try{ caps = track.getCapabilities?.() || {}; }catch(_){}
  FX.expoCaps = caps.exposureCompensation || null;
  if(FX.expoCaps && FX.s.expo != null) FX.applyExpo();
  return !!FX.expoCaps;
};
FX.applyExpo = () => {
  if(!FX.track || !FX.expoCaps) return;
  FX.track.applyConstraints({ advanced: [{ exposureCompensation: FX.s.expo ?? 0 }] }).catch(() => {});
};

FX.stop = () => {
  FX.running = false;
  try{ FX.audio?.ns?.port.postMessage('destroy'); }catch(_){}
  try{ FX.ctx?.close(); }catch(_){}
  FX.audio = null; FX.ctx = null; FX.gl = null; FX.track = null;
};

/* ================= ПАНЕЛЬ НАСТРОЕК ================= */
const SL = [
  ['bri', 'Яркость', -0.2, 0.2, 0.01, v => (v > 0 ? '+' : '') + Math.round(v * 100)],
  ['con', 'Контраст', 0.8, 1.3, 0.01, v => Math.round(v * 100) + '%'],
  ['sat', 'Насыщенность', 0.6, 1.5, 0.01, v => Math.round(v * 100) + '%'],
  ['warm', 'Тепло', -0.12, 0.12, 0.005, v => (v > 0 ? '+' : '') + Math.round(v * 100)],
  ['sharp', 'Резкость', 0, 1, 0.05, v => Math.round(v * 100) + '%'],
  ['smooth', 'Сглаживание кожи', 0, 1, 0.05, v => Math.round(v * 100) + '%']
];
FX.buildPanel = root => {
  const $ = s => root.querySelector(s);
  const box = $('#fxSliders'); box.innerHTML = '';
  SL.forEach(([k, label, mn, mx, st, fmt]) => {
    const row = document.createElement('label'); row.className = 'fxrow';
    row.innerHTML = `<span>${label}</span><input type="range" id="fx_${k}" min="${mn}" max="${mx}" step="${st}"><b></b>`;
    const inp = row.querySelector('input'), out = row.querySelector('b');
    inp.value = FX.s[k]; out.textContent = fmt(+inp.value);
    inp.addEventListener('input', () => { FX.s[k] = +inp.value; out.textContent = fmt(FX.s[k]); FX.save(); });
    box.appendChild(row);
  });
  if(FX.expoCaps){
    const c = FX.expoCaps, row = document.createElement('label'); row.className = 'fxrow';
    row.innerHTML = `<span>Экспозиция камеры</span><input type="range" id="fx_expo" min="${c.min}" max="${c.max}" step="${c.step || 0.1}"><b></b>`;
    const inp = row.querySelector('input'), out = row.querySelector('b');
    inp.value = FX.s.expo ?? 0; out.textContent = (+inp.value).toFixed(1);
    inp.addEventListener('input', () => { FX.s.expo = +inp.value; out.textContent = FX.s.expo.toFixed(1); FX.save(); FX.applyExpo(); });
    box.appendChild(row);
  }
  const tog = (id, key, after) => {
    const b = $(id); b.setAttribute('aria-pressed', !!FX.s[key]);
    b.onclick = () => { FX.s[key] = !FX.s[key]; b.setAttribute('aria-pressed', FX.s[key]); FX.save(); after && after(); };
  };
  tog('#fxVoice', 'voice', FX.applyAudio);
  tog('#fxDenoise', 'denoise', FX.applyAudio);
  tog('#fxVideo', 'video', () => FX.onVideoToggle?.());
  $('#fxDenoise').disabled = !!FX.audio && !FX.audio.ns;
  $('#fxDenoiseNote').hidden = !(FX.audio && !FX.audio.ns);
  $('#fxAudioNote').hidden = !!FX.audio;
  $('#fxVideoNote').hidden = !!FX.gl;
  $('#fxReset').onclick = () => { const keep = { voice: FX.s.voice, denoise: FX.s.denoise, video: FX.s.video }; FX.s = { ...DEF, ...keep }; FX.save(); FX.applyExpo(); FX.buildPanel(root); };
  const hold = $('#fxHold');
  const on = e => { e.preventDefault(); FX.holding = true; hold.classList.add('on'); };
  const off = () => { FX.holding = false; hold.classList.remove('on'); };
  hold.onpointerdown = on; hold.onpointerup = off; hold.onpointerleave = off; hold.onpointercancel = off;
};
FX.meterLoop = el => {
  const tick = () => {
    if(!FX.panelOpen) return;
    const db = FX.level();
    const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
    el.style.width = pct + '%';
    el.dataset.hot = db > -6 ? '1' : '';
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

window.TPFX = FX;
})();
