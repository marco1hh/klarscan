const FREE_PDF_LIMIT = 5;
const TESTER_CODE = "KLAR2026";
const DB_NAME = "klarscan";
const DB_VERSION = 1;

const $ = (id) => document.getElementById(id);
const state = {
  pages: [],
  current: 0,
  filter: "document",
  docs: [],
  settings: { tester: false, pdfCount: 0, quality: "high", onboarded: false },
  qrStream: null,
};

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2400);
}

function show(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const el = document.querySelector(`[data-screen="${name}"]`);
  if (el) el.classList.add("active");
  if (name !== "qr") stopQr();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function loadSettings() {
  try { Object.assign(state.settings, JSON.parse(localStorage.getItem("klarscan-settings") || "{}")); } catch {}
}
function saveSettings() {
  localStorage.setItem("klarscan-settings", JSON.stringify(state.settings));
  renderHomeMeta();
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDoc(doc) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("docs", "readwrite");
    tx.objectStore("docs").put(doc);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function loadDocs() {
  const db = await openDb();
  state.docs = await new Promise((resolve, reject) => {
    const tx = db.transaction("docs", "readonly");
    const req = tx.objectStore("docs").getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.created - a.created));
    req.onerror = () => reject(req.error);
  });
  renderDocs();
}
async function deleteDoc(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("docs", "readwrite");
    tx.objectStore("docs").delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await loadDocs();
}

function remainingScans() {
  if (state.settings.tester) return Infinity;
  return Math.max(0, FREE_PDF_LIMIT - state.settings.pdfCount);
}
function renderHomeMeta() {
  const left = remainingScans();
  $("quota").textContent = state.settings.tester ? "Tester-Modus · unbegrenzt" : `${left} von ${FREE_PDF_LIMIT} PDFs frei`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&", "<": "<", ">": ">", '"': """, "'": "&#39;" }[c]));
}
function renderDocs() {
  const box = $("doc-list");
  if (!state.docs.length) {
    box.innerHTML = `<div class="empty">Noch keine Dokumente auf diesem Gerät.<br>Alles bleibt lokal.</div>`;
    return;
  }
  box.innerHTML = state.docs.map((d) => `<article class="doc-item">
        <img class="doc-thumb" src="${d.thumb}" alt="">
        <div><strong>${escapeHtml(d.title)}</strong><br>
        <small>${d.pages} Seite${d.pages === 1 ? "" : "n"} · ${new Date(d.created).toLocaleString("de-DE")}</small></div>
        <button class="btn-ghost" data-del="${d.id}">Löschen</button></article>`).join("");
  box.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => { if (confirm("Dokument wirklich vom Gerät löschen?")) await deleteDoc(b.dataset.del); };
  });
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}
function imageToCanvas(img, maxEdge = 2000) {
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0, w, h);
  return c;
}
function clamp(n) { return Math.max(0, Math.min(255, n)); }
function applyFilter(srcCanvas, filter) {
  const c = document.createElement("canvas");
  c.width = srcCanvas.width; c.height = srcCanvas.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(srcCanvas, 0, 0);
  if (filter === "original") return c;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (filter === "enhance") {
      y = (y - 128) * 1.28 + 128;
      d[i] = clamp(r + (y - 128) * 0.25);
      d[i + 1] = clamp(g + (y - 128) * 0.25);
      d[i + 2] = clamp(b + (y - 128) * 0.22);
    } else {
      y = (y - 18) * 1.45;
      const bw = y > 168 ? 255 : y < 95 ? 18 : y * 0.92;
      d[i] = d[i + 1] = d[i + 2] = clamp(bw);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function rotateCanvas(src) {
  const c = document.createElement("canvas");
  c.width = src.height; c.height = src.width;
  const ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}
function trimEdges(src) {
  const ctx = src.getContext("2d", { willReadFrequently: true });
  const { width: w, height: h } = src;
  const data = ctx.getImageData(0, 0, w, h).data;
  const isPaper = (i) => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return y > 232 && Math.max(r, g, b) - Math.min(r, g, b) < 28;
  };
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  outer: for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!isPaper((y * w + x) * 4)) { top = y; break outer; }
  outer2: for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) if (!isPaper((y * w + x) * 4)) { bottom = y; break outer2; }
  outer3: for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (!isPaper((y * w + x) * 4)) { left = x; break outer3; }
  outer4: for (let x = w - 1; x >= 0; x--) for (let y = 0; y < h; y++) if (!isPaper((y * w + x) * 4)) { right = x; break outer4; }
  const pad = Math.round(Math.min(w, h) * 0.02);
  left = Math.max(0, left - pad); top = Math.max(0, top - pad);
  right = Math.min(w - 1, right + pad); bottom = Math.min(h - 1, bottom + pad);
  const cw = right - left + 1, ch = bottom - top + 1;
  if (cw < w * 0.4 || ch < h * 0.4) return src;
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  c.getContext("2d").drawImage(src, left, top, cw, ch, 0, 0, cw, ch);
  return c;
}

function renderEditor() {
  if (!state.pages.length) return;
  const page = state.pages[state.current];
  const filtered = applyFilter(page.source, page.filter || state.filter);
  page.preview = filtered;
  const stage = $("stage");
  stage.innerHTML = "";
  filtered.className = "preview";
  stage.appendChild(filtered);
  $("page-info").textContent = `Seite ${state.current + 1} / ${state.pages.length}`;
  $("pages").innerHTML = state.pages.map((p, i) => {
    const url = (p.preview || p.source).toDataURL("image/jpeg", 0.5);
    return `<img class="page-thumb ${i === state.current ? "active" : ""}" src="${url}" data-i="${i}" alt="Seite ${i + 1}">`;
  }).join("");
  $("pages").querySelectorAll(".page-thumb").forEach((el) => {
    el.onclick = () => { state.current = Number(el.dataset.i); renderEditor(); };
  });
  document.querySelectorAll("[data-filter]").forEach((b) => {
    b.classList.toggle("active", (state.pages[state.current].filter || state.filter) === b.dataset.filter);
  });
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/"));
  if (!files.length) { toast("Bitte ein Foto wählen."); return; }
  for (const file of files) {
    const img = await loadImageFile(file);
    state.pages.push({ source: imageToCanvas(img, 2000), filter: "document", preview: null });
  }
  state.current = state.pages.length - 1;
  show("editor");
  renderEditor();
}
function checkPaywall() {
  if (remainingScans() <= 0) { show("paywall"); return false; }
  return true;
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9äöüß]+/gi, "-").replace(/^-|-$/g, "") || "klarscan";
}

async function makePdf() {
  if (!state.pages.length) return;
  if (!checkPaywall()) return;
  $("pdf-btn").disabled = true;
  $("pdf-btn").textContent = "PDF entsteht …";
  try {
    const { PDFDocument } = PDFLib;
    const pdf = await PDFDocument.create();
    pdf.setTitle($("doc-title").value.trim() || "Klarscan Dokument");
    pdf.setCreator("Klarscan on-device");
    for (const page of state.pages) {
      const filtered = applyFilter(page.source, page.filter || "document");
      const jpeg = await new Promise((res) => filtered.toBlob(res, "image/jpeg", 0.82));
      const img = await pdf.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
      const A4w = 595.28, A4h = 841.89;
      const ratio = Math.min(A4w / img.width, A4h / img.height);
      const w = img.width * ratio, h = img.height * ratio;
      const p = pdf.addPage([A4w, A4h]);
      p.drawImage(img, { x: (A4w - w) / 2, y: (A4h - h) / 2, width: w, height: h });
    }
    const bytes = await pdf.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const title = $("doc-title").value.trim() || `Klarscan ${new Date().toLocaleDateString("de-DE")}`;
    const file = new File([blob], `${slug(title)}.pdf`, { type: "application/pdf" });
    state.settings.pdfCount += 1;
    saveSettings();
    const thumb = applyFilter(state.pages[0].source, state.pages[0].filter || "document").toDataURL("image/jpeg", 0.6);
    await saveDoc({ id: crypto.randomUUID(), title, pages: state.pages.length, created: Date.now(), thumb });
    await loadDocs();
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title });
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    toast("PDF ist fertig. Liegt nur auf deinem Gerät.");
  } catch (err) {
    console.error(err);
    toast("PDF hat nicht geklappt. Versuch ein kleineres Foto.");
  } finally {
    $("pdf-btn").disabled = false;
    $("pdf-btn").textContent = "PDF erzeugen";
  }
}

async function startQr() {
  show("qr");
  $("qr-result").classList.add("hidden");
  const video = $("qr-video");
  try {
    state.qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    video.srcObject = state.qrStream;
    await video.play();
    tickQr();
  } catch {
    toast("Kamera blockiert. Foto des Codes über „Bild prüfen“ geht auch.");
  }
}
function stopQr() {
  if (state.qrStream) {
    state.qrStream.getTracks().forEach((t) => t.stop());
    state.qrStream = null;
  }
}
let qrBusy = false;
const qrCanvas = document.createElement("canvas");
async function tickQr() {
  if (!state.qrStream) return;
  const video = $("qr-video");
  if (video.readyState >= 2 && !qrBusy) {
    qrBusy = true;
    try {
      if ("BarcodeDetector" in window) {
        const det = new BarcodeDetector({ formats: ["qr_code", "ean_13", "ean_8", "code_128"] });
        const codes = await det.detect(video);
        if (codes[0]) return showQrValue(codes[0].rawValue);
      } else if (window.jsQR) {
        qrCanvas.width = video.videoWidth; qrCanvas.height = video.videoHeight;
        const ctx = qrCanvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(video, 0, 0);
        const data = ctx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
        const code = jsQR(data.data, qrCanvas.width, qrCanvas.height);
        if (code) return showQrValue(code.data);
      }
    } catch {}
    qrBusy = false;
  }
  requestAnimationFrame(tickQr);
}
function showQrValue(value) {
  stopQr();
  $("qr-text").textContent = value;
  $("qr-result").classList.remove("hidden");
  $("qr-open").href = value.startsWith("http") ? value : "#";
  $("qr-open").classList.toggle("hidden", !value.startsWith("http"));
}
async function scanQrFile(file) {
  const img = await loadImageFile(file);
  const canvas = imageToCanvas(img, 1400);
  if ("BarcodeDetector" in window) {
    try {
      const det = new BarcodeDetector({ formats: ["qr_code", "ean_13", "code_128"] });
      const codes = await det.detect(canvas);
      if (codes[0]) return showQrValue(codes[0].rawValue);
    } catch {}
  }
  if (window.jsQR) {
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(data.data, canvas.width, canvas.height);
    if (code) return showQrValue(code.data);
  }
  toast("Kein Code erkannt. Näher rangehen, mehr Licht.");
}

function bind() {
  $("btn-scan").onclick = () => $("file-camera").click();
  $("btn-gallery").onclick = () => $("file-gallery").click();
  $("btn-qr").onclick = startQr;
  $("file-camera").onchange = (e) => addFiles(e.target.files);
  $("file-gallery").onchange = (e) => addFiles(e.target.files);
  $("file-more").onchange = (e) => addFiles(e.target.files);
  $("file-qr").onchange = (e) => e.target.files[0] && scanQrFile(e.target.files[0]);
  $("go-home").onclick = () => show("home");
  $("go-home-2").onclick = () => show("home");
  $("go-home-3").onclick = () => show("home");
  $("go-settings").onclick = () => { $("tester-flag").textContent = state.settings.tester ? "an" : "aus"; show("settings"); };
  $("go-legal").onclick = () => show("legal");
  $("go-feedback").onclick = () => show("feedback");
  $("go-onboarding").onclick = () => show("onboarding");
  $("start-app").onclick = () => { state.settings.onboarded = true; saveSettings(); show("home"); };
  $("add-page").onclick = () => $("file-more").click();
  $("rotate").onclick = () => { const p = state.pages[state.current]; if (!p) return; p.source = rotateCanvas(p.source); renderEditor(); };
  $("trim").onclick = () => { const p = state.pages[state.current]; if (!p) return; p.source = trimEdges(p.source); renderEditor(); toast("Helle Ränder abgeschnitten."); };
  $("delete-page").onclick = () => {
    if (!state.pages.length) return;
    state.pages.splice(state.current, 1);
    state.current = Math.max(0, state.current - 1);
    if (!state.pages.length) show("home"); else renderEditor();
  };
  document.querySelectorAll("[data-filter]").forEach((b) => {
    b.onclick = () => {
      if (!state.pages[state.current]) return;
      state.pages[state.current].filter = b.dataset.filter;
      state.filter = b.dataset.filter;
      renderEditor();
    };
  });
  $("pdf-btn").onclick = makePdf;
  $("new-doc").onclick = () => { state.pages = []; $("doc-title").value = ""; show("home"); };
  $("copy-qr").onclick = async () => {
    try { await navigator.clipboard.writeText($("qr-text").textContent); toast("Kopiert."); }
    catch { toast("Manuell markieren und kopieren."); }
  };
  $("qr-photo").onclick = () => $("file-qr").click();
  $("unlock").onclick = () => {
    const code = $("tester-code").value.trim().toUpperCase();
    if (code === TESTER_CODE) { state.settings.tester = true; saveSettings(); $("tester-flag").textContent = "an"; toast("Tester-Modus an. Danke dir."); }
    else toast("Code stimmt nicht.");
  };
  $("reset-quota").onclick = () => { state.settings.pdfCount = 0; saveSettings(); toast("Zähler zurück."); };
  $("send-feedback").onclick = async () => {
    const text = $("feedback-text").value.trim();
    if (text.length < 8) return toast("Schreib bitte etwas Konkretes.");
    const payload = ["Klarscan Feedback", new Date().toISOString(), navigator.userAgent, "Tester: " + state.settings.tester, "", text].join("\n");
    try { await navigator.clipboard.writeText(payload); toast("Feedback kopiert. Schick’s Marco per WhatsApp."); } catch {}
    const mail = $("feedback-mail").value.trim();
    if (mail) location.href = `mailto:${encodeURIComponent(mail)}?subject=${encodeURIComponent("Klarscan Feedback")}&body=${encodeURIComponent(payload)}`;
  };
}

async function boot() {
  loadSettings();
  bind();
  renderHomeMeta();
  try { await loadDocs(); } catch { renderDocs(); }
  if (!state.settings.onboarded) show("onboarding"); else show("home");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}
boot();
