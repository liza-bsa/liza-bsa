// Relais des salons : il fait seulement passer les messages de connexion entre 2 personnes.
// Il ne voit jamais les fichiers ni le secret du lien.
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname !== '/ws' || req.headers.get('Upgrade') !== 'websocket') return new Response('ok');
    const room = u.searchParams.get('r') || '';
    if (!/^[A-Za-z0-9_-]{22}$/.test(room)) return new Response('bad', { status: 400 });
    if (env.TURNSTILE_SECRET && u.searchParams.get('role') === 'host') {
      const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: u.searchParams.get('ts') || '' });
      const r = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })).json();
      if (!r.success) return new Response('captcha', { status: 403 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
  }
};

export class Room {
  constructor(state) { this.state = state; this.socks = []; }
  async fetch() {
    // Salon à usage unique : 2 personnes max, impossible de le rouvrir une fois fermé ou expiré
    if (this.socks.length >= 2 || await this.state.storage.get('dead')) return new Response('full', { status: 403 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.socks.push(server);
    if (this.socks.length === 1) await this.state.storage.setAlarm(Date.now() + 10 * 60 * 1000);
    server.addEventListener('message', e => {
      if (typeof e.data !== 'string' || e.data.length > 20000) return;
      for (const o of this.socks) if (o !== server) o.send(e.data);
    });
    server.addEventListener('close', () => this.kill());
    if (this.socks.length === 2) for (const o of this.socks) o.send('{"t":"ready"}');
    return new Response(null, { status: 101, webSocket: client });
  }
  async kill() {
    await this.state.storage.put('dead', 1);
    for (const o of this.socks) { try { o.close(); } catch {} }
  }
  async alarm() { await this.kill(); }
}
