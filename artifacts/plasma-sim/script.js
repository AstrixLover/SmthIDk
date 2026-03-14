(function () {
  'use strict';

  /* ── DOM refs ─────────────────────────────────────────── */
  const canvas        = document.getElementById('plasmaCanvas');
  const ctx           = canvas.getContext('2d');
  const startBtn      = document.getElementById('startBtn');
  const resetBtn      = document.getElementById('resetBtn');
  const flareBtn      = document.getElementById('flareBtn');
  const fpsEl         = document.getElementById('fpsCounter');
  const heatSlider    = document.getElementById('heatSlider');
  const bfieldSlider  = document.getElementById('bfieldSlider');
  const gravitySlider = document.getElementById('gravitySlider');
  const toroidSlider  = document.getElementById('toroidSlider');
  const ionSlider     = document.getElementById('ionSlider');
  const heatVal       = document.getElementById('heatVal');
  const bfieldVal     = document.getElementById('bfieldVal');
  const gravityVal    = document.getElementById('gravityVal');
  const toroidVal     = document.getElementById('toroidVal');
  const ionVal        = document.getElementById('ionVal');
  const statusDot     = document.getElementById('statusDot');
  const statusLabel   = document.getElementById('statusLabel');
  const particleCountEl = document.getElementById('particleCount');
  const confinementEl   = document.getElementById('confinementStatus');
  const plasmaTempEl    = document.getElementById('plasmaTemp');
  const bfieldBar     = document.getElementById('bfieldBar');
  const heatBar       = document.getElementById('heatBar');
  const gravityBar    = document.getElementById('gravityBar');
  const ionBar        = document.getElementById('ionBar');

  /* ── Constants ────────────────────────────────────────── */
  const NUM_PARTICLES = 1000;
  const DAMPING       = 0.99;
  const TERMINAL_VEL  = 8.0;
  const SPAWN_RADIUS  = 60;
  const TRAIL_LEN     = 8;

  /* ── Simulation state ─────────────────────────────────── */
  let running   = false;
  let animId    = null;
  let particles = [];

  /* ── FPS tracking ─────────────────────────────────────── */
  let lastTime  = 0;
  let fpsFrames = 0;
  let fpsClock  = 0;

  /* ════════════════════════════════════════════════════════
     PARTICLE CLASS
  ════════════════════════════════════════════════════════ */
  class Particle {
    constructor(x, y, vx, vy, mass) {
      this.x      = x;
      this.y      = y;
      this.vx     = vx;
      this.vy     = vy;
      this.mass   = mass;
      this.charge = (mass > 1.0) ? 1 : -1;
      this.trail  = [];
      this.energy = 0;
    }

    /* ── 1. Brownian motion ───────────────────────────────── */
    applyBrownian(heatStrength) {
      const kick = heatStrength * 0.22;
      this.vx += (Math.random() - 0.5) * kick;
      this.vy += (Math.random() - 0.5) * kick;
    }

    /* ── 2. Lorentz force — ionization scales B intensity ───
         ionization: 0 (ignore field) → 2 (twice normal).
         Lorentz F = q(v × B):  Fx = q·vy·B, Fy = -q·vx·B    */
    applyLorentz(bStrength, ionization) {
      const B = bStrength * 0.018 * ionization;
      const q = this.charge;
      this.vx +=  q * this.vy * B;
      this.vy += -q * this.vx * B;
    }

    /* ── 3. Toroidal gravity ─────────────────────────────────
         When toroidRadius = 0: classic point gravity (original).
         When toroidRadius > 0: find the nearest point T on the
         ring of that radius centred on (cx, cy), then pull the
         particle toward T.  This naturally forms a hollow
         plasma donut — the tokamak torus.                      */
    applyGravity(cx, cy, gStrength, toroidRadius) {
      let tx, ty;

      if (toroidRadius < 0.5) {
        /* Original point gravity — pull straight to centre */
        tx = cx;
        ty = cy;
      } else {
        /* Project the particle's position onto the ring */
        const pdx  = this.x - cx;
        const pdy  = this.y - cy;
        const pdist = Math.sqrt(pdx * pdx + pdy * pdy) || 0.001;
        tx = cx + (pdx / pdist) * toroidRadius;
        ty = cy + (pdy / pdist) * toroidRadius;
      }

      const dx   = tx - this.x;
      const dy   = ty - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const mag  = (gStrength * 0.07) / (1 + dist * 0.008);
      this.vx += (dx / dist) * mag;
      this.vy += (dy / dist) * mag;
    }

    /* ── 4. Damping ──────────────────────────────────────── */
    applyDamping() {
      this.vx *= DAMPING;
      this.vy *= DAMPING;
    }

    /* ── 5. Terminal velocity clamp ──────────────────────── */
    clampSpeed() {
      const spd = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
      if (spd > TERMINAL_VEL) {
        const s = TERMINAL_VEL / spd;
        this.vx *= s;
        this.vy *= s;
      }
      this.energy = Math.min(1, spd / TERMINAL_VEL);
    }

    /* ── 6. Euler integration ────────────────────────────── */
    integrate() {
      this.x += this.vx;
      this.y += this.vy;
    }

    /* ── 7. Wall bounce ──────────────────────────────────── */
    bounceWalls(W, H) {
      const r = 1.5;
      if (this.x < r)       { this.x = r;       this.vx =  Math.abs(this.vx); }
      else if (this.x > W - r) { this.x = W - r; this.vx = -Math.abs(this.vx); }
      if (this.y < r)       { this.y = r;       this.vy =  Math.abs(this.vy); }
      else if (this.y > H - r) { this.y = H - r; this.vy = -Math.abs(this.vy); }
    }

    recordTrail() {
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > TRAIL_LEN) this.trail.shift();
    }
  }

  /* ════════════════════════════════════════════════════════
     CANVAS SIZING
  ════════════════════════════════════════════════════════ */
  function resizeCanvas() {
    const wrapper = canvas.parentElement;
    canvas.width  = wrapper.clientWidth;
    canvas.height = wrapper.clientHeight;
  }

  /* ════════════════════════════════════════════════════════
     SPAWN 1,000 PARTICLES
  ════════════════════════════════════════════════════════ */
  function spawnParticles() {
    particles = [];
    const cx = canvas.width  / 2;
    const cy = canvas.height / 2;

    for (let i = 0; i < NUM_PARTICLES; i++) {
      const angle  = Math.random() * Math.PI * 2;
      const r      = Math.random() * SPAWN_RADIUS;
      const x      = cx + Math.cos(angle) * r;
      const y      = cy + Math.sin(angle) * r;
      const speed  = 0.5 + Math.random() * 2.0;
      const vAngle = Math.random() * Math.PI * 2;
      const vx     = Math.cos(vAngle) * speed;
      const vy     = Math.sin(vAngle) * speed;
      const mass   = 0.6 + Math.random() * 1.0;
      particles.push(new Particle(x, y, vx, vy, mass));
    }
  }

  /* ════════════════════════════════════════════════════════
     INSTABILITY SHOCKWAVE — "Trigger Flare"
     Simulates magnetic reconnection: a sudden shockwave
     originating from a random point, flinging 20% of
     particles outward with a massive velocity spike.
  ════════════════════════════════════════════════════════ */
  function triggerFlare() {
    if (particles.length === 0) return;

    /* Random epicentre anywhere on the canvas */
    const fx = Math.random() * canvas.width;
    const fy = Math.random() * canvas.height;

    /* Fisher-Yates shuffle to get a random 20% sample */
    const count   = Math.floor(NUM_PARTICLES * 0.2);
    const indices = Array.from({ length: NUM_PARTICLES }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
    }

    for (let i = 0; i < count; i++) {
      const p   = particles[indices[i]];
      const dx  = p.x - fx;
      const dy  = p.y - fy;
      const d   = Math.sqrt(dx * dx + dy * dy) || 1;
      const spk = 14 + Math.random() * 10;   // 14–24 px/frame spike
      p.vx += (dx / d) * spk;
      p.vy += (dy / d) * spk;
    }
  }

  /* ════════════════════════════════════════════════════════
     PHYSICS UPDATE — reads all sliders live each frame
  ════════════════════════════════════════════════════════ */
  function update() {
    const W  = canvas.width;
    const H  = canvas.height;
    const cx = W / 2;
    const cy = H / 2;

    const heatNorm    = +heatSlider.value    / 100;
    const bfieldNorm  = +bfieldSlider.value  / 100;
    const gravityNorm = +gravitySlider.value / 100;
    const toroidR     = +toroidSlider.value;          // raw px
    const ionization  = +ionSlider.value     / 100;   // 0–2

    for (const p of particles) {
      p.recordTrail();
      p.applyBrownian(heatNorm);
      p.applyLorentz(bfieldNorm, ionization);
      p.applyGravity(cx, cy, gravityNorm, toroidR);
      p.applyDamping();
      p.clampSpeed();
      p.integrate();
      p.bounceWalls(W, H);
    }
  }

  /* ════════════════════════════════════════════════════════
     DRAW — globalCompositeOperation = 'lighter' throughout,
     NO shadowBlur anywhere.
  ════════════════════════════════════════════════════════ */
  function draw() {
    const W  = canvas.width;
    const H  = canvas.height;
    const cx = W / 2;
    const cy = H / 2;

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, 0, W, H);

    const bfieldNorm  = +bfieldSlider.value  / 100;
    const gravityNorm = +gravitySlider.value  / 100;
    const heatNorm    = +heatSlider.value     / 100;
    const toroidR     = +toroidSlider.value;
    const maxR        = Math.min(cx, cy) * 0.88;

    /* Ambient gradient */
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 0.65);
    bg.addColorStop(0,    `rgba(60,10,140,${0.04 + gravityNorm * 0.06})`);
    bg.addColorStop(0.55, `rgba(0,50,180,${0.03 + heatNorm    * 0.05})`);
    bg.addColorStop(1,    'rgba(0,0,0,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    /* Outer containment ring */
    ctx.beginPath();
    ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(0,160,255,${0.12 + bfieldNorm * 0.28})`;
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, maxR * 0.96, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(0,80,200,${0.06 + bfieldNorm * 0.10})`;
    ctx.lineWidth   = 3;
    ctx.stroke();

    /* Toroid guide ring — shown when radius > 0 */
    if (toroidR > 0.5) {
      const ionization = +ionSlider.value / 100;
      ctx.beginPath();
      ctx.arc(cx, cy, toroidR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(160,80,255,${0.15 + ionization * 0.10})`;
      ctx.lineWidth   = 1;
      ctx.stroke();
    }

    /* ── Particles — additive blending ─────────────────── */
    ctx.globalCompositeOperation = 'lighter';

    for (const p of particles) {
      const e = p.energy;

      let r, g, b;
      if (e > 0.7) {
        r = 255; g = (80 + e * 175) | 0; b = 20;
      } else if (e > 0.35) {
        r = 0;   g = 150;                b = 255;
      } else {
        r = 80;  g = 40;                 b = 220;
      }

      if (p.trail.length > 1) {
        for (let t = 0; t < p.trail.length - 1; t++) {
          const alpha = (t / p.trail.length) * 0.18;
          ctx.beginPath();
          ctx.moveTo(p.trail[t].x, p.trail[t].y);
          ctx.lineTo(p.trail[t + 1].x, p.trail[t + 1].y);
          ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
          ctx.lineWidth   = 0.8;
          ctx.stroke();
        }
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.5 + e * 1.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},0.4)`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.0 + e * 2.0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},0.08)`;
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  /* ════════════════════════════════════════════════════════
     FPS COUNTER
  ════════════════════════════════════════════════════════ */
  function updateFps(now) {
    fpsFrames++;
    fpsClock += now - (lastTime || now);
    if (fpsClock >= 500) {
      fpsEl.textContent = Math.round(fpsFrames / (fpsClock / 1000));
      fpsFrames = 0;
      fpsClock  = 0;
    }
    lastTime = now;
  }

  /* ════════════════════════════════════════════════════════
     TELEMETRY PANEL
  ════════════════════════════════════════════════════════ */
  function updateTelemetry() {
    const hv = +heatSlider.value;
    const bv = +bfieldSlider.value;
    const gv = +gravitySlider.value;
    const iv = +ionSlider.value;

    heatVal.textContent    = hv;
    bfieldVal.textContent  = bv;
    gravityVal.textContent = gv;
    toroidVal.textContent  = toroidSlider.value;
    ionVal.textContent     = iv;

    bfieldBar.style.width  = bv + '%';
    heatBar.style.width    = hv + '%';
    gravityBar.style.width = gv + '%';
    ionBar.style.width     = (iv / 2) + '%';   // max 200 → bar fills to 100%

    particleCountEl.textContent = NUM_PARTICLES.toLocaleString();

    const confinePct = Math.round(bv * 0.5 + gv * 0.3 + (100 - hv) * 0.2);
    confinementEl.textContent = confinePct + '%';
    plasmaTempEl.textContent  = (hv * 1.5 + 50).toFixed(0) + ' MK';
  }

  /* ════════════════════════════════════════════════════════
     ANIMATION LOOP
  ════════════════════════════════════════════════════════ */
  function loop(now) {
    if (!running) return;
    updateFps(now);
    update();
    draw();
    updateTelemetry();
    animId = requestAnimationFrame(loop);
  }

  /* ════════════════════════════════════════════════════════
     SIMULATION CONTROL
  ════════════════════════════════════════════════════════ */
  function startSim() {
    if (running) return;
    running   = true;
    lastTime  = 0;
    fpsFrames = 0;
    fpsClock  = 0;
    startBtn.textContent = 'PAUSE SIMULATION';
    startBtn.classList.add('active');
    statusDot.classList.add('running');
    statusLabel.textContent = 'RUNNING';
    statusLabel.classList.add('running');
    animId = requestAnimationFrame(loop);
  }

  function pauseSim() {
    running = false;
    if (animId) cancelAnimationFrame(animId);
    animId = null;
    startBtn.textContent = 'RESUME SIMULATION';
    startBtn.classList.remove('active');
    statusDot.classList.remove('running');
    statusLabel.textContent = 'PAUSED';
    statusLabel.classList.remove('running');
    fpsEl.textContent = '--';
  }

  function resetSim() {
    pauseSim();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    spawnParticles();
    startBtn.textContent        = 'START SIMULATION';
    statusLabel.textContent     = 'IDLE';
    fpsEl.textContent           = '--';
    confinementEl.textContent   = '--';
    plasmaTempEl.textContent    = '--';
    particleCountEl.textContent = '0';
    bfieldBar.style.width       = '0%';
    heatBar.style.width         = '0%';
    gravityBar.style.width      = '0%';
    ionBar.style.width          = '0%';
  }

  /* ── Slider live-label sync ─────────────────────────── */
  heatSlider.addEventListener('input',    () => { heatVal.textContent    = heatSlider.value;    });
  bfieldSlider.addEventListener('input',  () => { bfieldVal.textContent  = bfieldSlider.value;  });
  gravitySlider.addEventListener('input', () => { gravityVal.textContent = gravitySlider.value; });
  toroidSlider.addEventListener('input',  () => { toroidVal.textContent  = toroidSlider.value;  });
  ionSlider.addEventListener('input',     () => { ionVal.textContent     = ionSlider.value;     });

  startBtn.addEventListener('click', () => { if (running) pauseSim(); else startSim(); });
  resetBtn.addEventListener('click', resetSim);
  flareBtn.addEventListener('click', triggerFlare);

  window.addEventListener('resize', () => {
    resizeCanvas();
    if (!running) ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

  /* ── Boot ─────────────────────────────────────────────── */
  resizeCanvas();
  spawnParticles();

})();
