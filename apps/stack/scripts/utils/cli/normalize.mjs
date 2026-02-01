export function normalizeProfile(raw) {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'selfhost' || v === 'self-host' || v === 'self_host' || v === 'host') return 'selfhost';
  if (v === 'dev' || v === 'developer' || v === 'develop' || v === 'development') return 'dev';
  return '';
}

export function normalizeServerComponent(raw) {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'light' || v === 'server-light' || v === 'happy-server-light') return 'happy-server-light';
  if (v === 'server' || v === 'full' || v === 'happy-server') return 'happy-server';
  return '';
}

