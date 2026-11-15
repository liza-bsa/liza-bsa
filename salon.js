/* Salons d'échange : connexion directe (WebRTC) entre 2 personnes. Le serveur ne sert qu'à les mettre en relation. */
const SIGNAL = 'wss://liza-bsa.zetrox-l3dinodin0saur3.workers.dev/ws'; // adresse de ton Worker (voir le dossier worker/)
const SITEKEY = '';                                  // clé Turnstile anti-robots (facultatif)
const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
const b64u = u => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => unb64(s.replace(/-/g, '+').replace(/_/g, '/'));
const say = t => { $('#sMsg').textContent = t || ''; };
let S = null, pending = null, myLink = '';

/* Lien reçu : #s=<salon>.<secret>. On l'efface de la barre d'adresse tout de suite. */
const hm = location.hash.match(/^#s=([\w-]{22})\.([\w-]{22})$/);
if (hm) {
  pending = { room: hm[1], secret: unb64u(hm[2]) };
  history.replaceState(null, '', location.pathname + location.search);
  $('#lock .lead').textContent = 'Déverrouille ton coffre pour rejoindre le salon d’échange.';
}
function afterUnlock() {
  if (pending && !S && confirm('Rejoindre le salon d’échange ?')) startSalon(false, pending.room, pending.secret);
  pending = null;
}

function getTs() {
  return new Promise((ok, ko) => {
    if (!SITEKEY) return ok('');
    const go = () => turnstile.render('#ts', { sitekey: SITEKEY, callback: ok, 'error-callback': () => ko(new Error('Vérification anti-robot échouée.')) });
    if (window.turnstile) return go();
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.onload = go; document.head.append(s);
  });
}

async function startSalon(host, room, secret) {
  if (S) return;
  S = { host, mine: [], offered: false, peerOffer: null, iAcc: false, peerAcc: false, sent: false, peerDone: false, rx: null, jobs: [], q: Promise.resolve() };
  $('#sBox').hidden = false; $('#sNew').hidden = true; say('Connexion…');
  try {
    S.mk = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const ts = host ? await getTs() : '';
    const ws = S.ws = new WebSocket(SIGNAL + '?r=' + room + (host ? '&role=host&ts=' + encodeURIComponent(ts) : ''));
    const pc = S.pc = new RTCPeerConnection({ iceServers: ICE });
    ws.onclose = () => { if (S && !S.open) endSalon('Salon fermé ou expiré.'); };
    ws.onmessage = ev => { const m = JSON.parse(ev.data); S.q = S.q.then(() => handle(m)).catch(() => {}); };
    pc.onicecandidate = e => { if (e.candidate && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ice', c: e.candidate })); };
    pc.onconnectionstatechange = () => { if (S && !S.finished && ['failed', 'disconnected', 'closed'].includes(pc.connectionState)) endSalon('Connexion perdue.'); };
    if (host) { $('#sLink').hidden = false; say('Envoie le lien à la personne. Le salon expire dans 10 minutes.'); }
    else say('Connexion au salon…');
  } catch (e) { endSalon(e.message); }
}

async function sendSdp() {
  const d = S.pc.localDescription;
  S.ws.send(JSON.stringify({ t: 'sdp', d: { type: d.type, sdp: d.sdp }, mac: b64(await crypto.subtle.sign('HMAC', S.mk, enc.encode(d.sdp))) }));
}
async function handle(m) {
  if (!S) return;
  const { pc, host } = S;
  if (m.t === 'ready' && host) {
    S.dc = pc.createDataChannel('f'); wire(S.dc);
    await pc.setLocalDescription(await pc.createOffer()); await sendSdp();
  } else if (m.t === 'sdp') {
    // Le secret du lien authentifie l'autre personne : un intrus (même le serveur) ne peut pas s'interposer.
    const ok = await crypto.subtle.verify('HMAC', S.mk, unb64(m.mac), enc.encode(m.d.sdp)).catch(() => false);
    if (!ok) return endSalon('Sécurité : message invalide, échange annulé.');
    await pc.setRemoteDescription(m.d);
    if (!host) { pc.ondatachannel = e => { S.dc = e.channel; wire(S.dc); }; await pc.setLocalDescription(await pc.createAnswer()); await sendSdp(); }
  } else if (m.t === 'ice') await pc.addIceCandidate(m.c).catch(() => {});
}

function wire(dc) {
  dc.binaryType = 'arraybuffer'; dc.bufferedAmountLowThreshold = 1 << 20;
  dc.onopen = async () => {
    S.open = true; S.ws.close();
    // Numéro de vérification : identique des deux côtés si la connexion est bien directe
    const fp = d => (d.match(/a=fingerprint:\S+ (\S+)/) || [])[1] || '';
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode([fp(S.pc.localDescription.sdp), fp(S.pc.remoteDescription.sdp)].sort().join())));
    $('#sCode').hidden = false; $('#sCode').textContent = 'Numéro de vérification : ' + [...h.slice(0, 4)].map(x => String(x).padStart(3, '0')).join(' ') + ' (le même doit s’afficher chez l’autre personne)';
    say('Connecté. Choisis les fichiers à montrer.');
    S.items = await myItems(); renderPick();
  };
  dc.onmessage = onData;
}

async function myItems() {
  const rows = await run(['files'], 'readonly', s => s('files').getAll());
  const out = [];
  for (const r of rows) out.push({ id: r.id, ...JSON.parse(dec.decode(await unseal(r.m))) });
  return out.sort((a, b) => b.date - a.date);
}
function row(name, sz, left) {
  const r = document.createElement('div'); r.className = 'row';
  const n = document.createElement('div'); n.className = 'name';
  const b = document.createElement('b'); b.textContent = name;
  const s = document.createElement('span'); s.className = 'mute'; s.textContent = size(sz);
  n.append(b, s); if (left) r.append(left); r.append(n); return r;
}
function renderPick() {
  const box = $('#sPick'); box.replaceChildren();
  if (!S.items.length) { const p = document.createElement('p'); p.className = 'mute'; p.textContent = 'Ton coffre est vide : tu peux quand même recevoir.'; box.append(p); }
  for (const it of S.items) { const c = document.createElement('input'); c.type = 'checkbox'; c.dataset.id = it.id; box.append(row(it.name, it.size, c)); }
  $('#sShow').hidden = false; $('#sAcc').hidden = false; $('#sAcc').disabled = true;
}
function renderPeer() {
  const box = $('#sPeer'); box.replaceChildren();
  const h = document.createElement('p'); h.textContent = S.peerOffer.length ? 'L’autre personne propose :' : 'L’autre personne ne propose rien.'; box.append(h);
  for (const it of S.peerOffer) box.append(row(it.name, it.size));
  $('#sAcc').disabled = !S.offered;
}
$('#sShow').onclick = () => {
  const ids = [...$('#sPick').querySelectorAll('input:checked')].map(c => c.dataset.id);
  S.mine = ids; S.offered = true;
  $('#sPick').querySelectorAll('input').forEach(c => c.disabled = true); $('#sShow').hidden = true;
  S.dc.send(JSON.stringify({ t: 'offer', items: S.items.filter(i => ids.includes(i.id)).map(({ id, name, type, size }) => ({ id, name, type, size })) }));
  say(S.peerOffer ? 'Vérifie ce qu’on te propose, puis accepte.' : 'En attente de l’autre personne…');
  $('#sAcc').disabled = !S.peerOffer;
};
$('#sAcc').onclick = () => { S.iAcc = true; $('#sAcc').disabled = true; S.dc.send('{"t":"accept"}'); say('Accepté. En attente de l’autre personne…'); go(); };

function go() { if (S.iAcc && S.peerAcc && !S.sending) { S.sending = true; say('Échange en cours…'); sendAll(); } }
async function sendAll() {
  for (const id of S.mine) {
    const it = S.items.find(x => x.id === id);
    const rec = await run(['blobs'], 'readonly', s => s('blobs').get(id));
    const parts = []; for (const c of rec.chunks) parts.push(await unseal(c));
    const blob = new Blob(parts);
    S.dc.send(JSON.stringify({ t: 'file', id, name: it.name, type: it.type, size: it.size }));
    for (let o = 0; o < blob.size; o += 16384) {
      if (S.dc.bufferedAmount > (4 << 20)) await new Promise(r => S.dc.addEventListener('bufferedamountlow', r, { once: true }));
      S.dc.send(await blob.slice(o, o + 16384).arrayBuffer());
    }
    S.dc.send(JSON.stringify({ t: 'end', id }));
  }
  S.dc.send('{"t":"done"}'); S.sent = true; finish();
}
function onData(e) {
  if (!S) return;
  if (typeof e.data !== 'string') { const r = S.rx; if (r) { r.got += e.data.byteLength; if (r.got > r.size) S.rx = null; else r.parts.push(e.data); } return; }
  const m = JSON.parse(e.data);
  if (m.t === 'offer') { S.peerOffer = m.items.slice(0, 200); renderPeer(); if (S.offered) say('Vérifie ce qu’on te propose, puis accepte.'); }
  else if (m.t === 'accept') { S.peerAcc = true; go(); }
  else if (m.t === 'file') { // on ne reçoit que ce qui a été montré ET accepté
    const it = S.iAcc && S.peerOffer && S.peerOffer.find(x => x.id === m.id && x.size === m.size);
    S.rx = it ? { name: it.name, type: it.type, size: it.size, got: 0, parts: [] } : null;
  } else if (m.t === 'end') {
    const r = S.rx; S.rx = null;
    if (r && r.got === r.size) S.jobs.push(addFiles([new File(r.parts, r.name, { type: r.type })]));
  } else if (m.t === 'done') { S.peerDone = true; finish(); }
}
async function finish() {
  if (!(S.sent && S.peerDone)) return;
  S.finished = true; await Promise.all(S.jobs);
  endSalon('Échange terminé. ' + S.jobs.length + ' fichier(s) reçu(s) dans ton coffre.');
}

function endSalon(msg) {
  if (!S) return;
  try { S.dc && S.dc.close(); S.pc && S.pc.close(); S.ws && S.ws.close(); } catch {}
  S = null; myLink = '';
  for (const id of ['#sPick', '#sPeer']) $(id).replaceChildren();
  for (const id of ['#sBox', '#sLink', '#sCode', '#sShow', '#sAcc']) $(id).hidden = true;
  $('#sNew').hidden = false; $('#sBox').hidden = !msg; say(msg);
}
$('#sQuit').onclick = () => endSalon('Salon quitté.');
$('#sNew').onclick = () => {
  const room = b64u(rnd(16)), secret = rnd(16);
  myLink = location.origin + location.pathname + '#s=' + room + '.' + b64u(secret);
  startSalon(true, room, secret);
};
$('#sShare').onclick = () => {
  if (navigator.share) navigator.share({ title: 'Salon d’échange', url: myLink }).catch(() => {});
  else navigator.clipboard.writeText(myLink).then(() => say('Lien copié. Envoie-le à la personne.'));
};
