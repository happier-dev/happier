import { extname } from 'node:path';

const MAX_SAFE_FILE_NAME_LENGTH = 200;

export function isUnsafeSessionMediaMetadataString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^\$(?:HOME|CODEX_HOME)(?:$|[\\/])/u.test(trimmed)) return true;
  if (/^\$\{(?:HOME|CODEX_HOME)\}(?:$|[\\/])/u.test(trimmed)) return true;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-z]:[\\/]/i.test(trimmed)) return true;
  if (/^(?:data|file|https?|blob):/iu.test(trimmed)) return true;
  if (/;base64,/iu.test(trimmed)) return true;
  if (isBase64LikeSessionMediaString(trimmed)) return true;
  return false;
}

function isBase64LikeSessionMediaString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 11) return false;
  if (trimmed.includes('.') || /\s/u.test(trimmed)) return false;
  if (!/[A-Z]/u.test(trimmed) || !/[a-z]/u.test(trimmed) || !/[0-9+/_=-]/u.test(trimmed)) return false;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(trimmed)) return false;
  const normalized = trimmed.replace(/=+$/u, '').replace(/-/gu, '+').replace(/_/gu, '/');
  if (normalized.length % 4 === 1) return false;
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    const decoded = Buffer.from(padded, 'base64');
    if (decoded.byteLength < 8) return false;
    return decoded.toString('base64').replace(/=+$/u, '') === normalized;
  } catch {
    return false;
  }
}

export function sanitizeSessionMediaFileName(value: string, fallback = 'file'): string {
  const raw = String(value ?? '');
  if (isUnsafeSessionMediaMetadataString(raw)) return fallback;
  const base = raw.split(/[/\\]/g).pop() ?? '';
  if (isUnsafeSessionMediaMetadataString(base)) return fallback;
  const trimmed = base.trim() || fallback;
  const safe = trimmed.replace(/[^\w.\- ()]/g, '_');
  const collapsed = safe.replace(/_+/g, '_');
  const finalName = collapsed === '.' || collapsed === '..' ? fallback : collapsed;
  return finalName.length > MAX_SAFE_FILE_NAME_LENGTH
    ? finalName.slice(-MAX_SAFE_FILE_NAME_LENGTH)
    : finalName;
}

export function sanitizeSessionMediaFailureName(value: string | null | undefined, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || isUnsafeSessionMediaMetadataString(raw)) return fallback;
  const sanitized = sanitizeSessionMediaFileName(raw, fallback);
  return isUnsafeSessionMediaMetadataString(sanitized) ? fallback : sanitized;
}

export function sanitizeSessionMediaIdentifier(value: string | null | undefined): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > MAX_SAFE_FILE_NAME_LENGTH || raw.includes('\0')) return null;
  if (isUnsafeSessionMediaMetadataString(raw)) return null;
  return raw;
}

export function withSessionMediaFileExtension(fileName: string, extensionWithDot: string): string {
  const currentExtension = extname(fileName);
  const base = currentExtension ? fileName.slice(0, -currentExtension.length) : fileName;
  return `${base || 'file'}${extensionWithDot}`;
}
