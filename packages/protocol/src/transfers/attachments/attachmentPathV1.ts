import { z } from '../../zodRuntimePolicy.js';

/** Display metadata preserves Session intake names; only the target sanitizer chooses filesystem names. */
export const AttachmentNameV1Schema = z.string().check(z.refine(value =>
  value.length > 0 && value === value.normalize('NFC')));

/** Shared Session/Discussion relative paths; absolute paths and traversal fail closed. */
export function normalizeAttachmentRelativePathV1(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('\\')) return null;
  if (trimmed.includes('\0') || /^[A-Za-z]:/.test(trimmed)) return null;
  const parts = trimmed.split(/[\\/]+/g).filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) return null;
  return parts.join('/');
}

export const AttachmentRelativePathV1Schema = z.string().check(z.refine(value =>
  normalizeAttachmentRelativePathV1(value) === value));

/** Existing target filesystem naming policy; display names retain their Unicode spelling. */
export function sanitizeAttachmentFileName(value: string): string {
  const raw = String(value ?? '');
  const base = raw.split(/[/\\]/g).pop() ?? '';
  const trimmed = base.trim() || 'file';
  const safe = trimmed.replace(/[^\w.\- ()]/g, '_');
  const collapsed = safe.replace(/_+/g, '_');
  const finalName = collapsed === '.' || collapsed === '..' ? 'file' : collapsed;
  return finalName.length > 200 ? finalName.slice(-200) : finalName;
}
