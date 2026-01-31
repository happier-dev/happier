export function sanitizeDnsLabel(raw, { fallback = 'stack' } = {}) {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return s || fallback;
}

