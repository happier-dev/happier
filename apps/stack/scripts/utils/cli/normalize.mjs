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
  // Prefer Happier component IDs; accept legacy Happy IDs for backward compatibility.
  if (v === 'light' || v === 'server-light' || v === 'happier-server-light' || v === 'happy-server-light') return 'happier-server-light';
  if (v === 'server' || v === 'full' || v === 'happier-server' || v === 'happy-server') return 'happier-server';
  return '';
}
