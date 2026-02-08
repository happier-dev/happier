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

export function normalizeStackNameOrNull(raw, { maxLen = 63 } = {}) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  const normalized = String(trimmed)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  if (!normalized) return null;
  if (Number.isFinite(maxLen) && maxLen > 0 && normalized.length > maxLen) return null;
  return normalized;
}
