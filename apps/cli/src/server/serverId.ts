const SERVER_ID_SAFE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isServerIdFilesystemSafe(raw: string): boolean {
  const value = String(raw ?? '').trim();
  if (!value) return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return SERVER_ID_SAFE_RE.test(value);
}

export function sanitizeServerIdForFilesystem(raw: string, fallback = 'cloud'): string {
  const value = String(raw ?? '').trim();
  if (isServerIdFilesystemSafe(value)) return value;
  return String(fallback ?? '').trim() || 'cloud';
}

export function deriveServerIdFromName(raw: string): string {
  const input = String(raw ?? '').trim();
  if (!input) return 'server';

  let id = input
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');

  if (id.length > 64) {
    id = id.slice(0, 64).replace(/[.-]+$/, '');
  }

  if (!isServerIdFilesystemSafe(id)) {
    return 'server';
  }

  return id;
}
