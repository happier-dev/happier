export function sanitizeStackName(raw, { fallback = 'stack', maxLen = 64 } = {}) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  const out = s || String(fallback ?? 'stack');
  return Number.isFinite(maxLen) && maxLen > 0 ? out.slice(0, maxLen) : out;
}

