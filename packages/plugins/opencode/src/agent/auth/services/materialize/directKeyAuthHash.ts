import { createHash } from 'node:crypto';

function isOpenCodeRequestAuthMarker(value: string): boolean {
  return /^happier-request-auth:(?:openai|anthropic):\d+$/u.test(value);
}

export function hashOpenCodeDirectKeyAuthContent(rawAuthContent: unknown): string {
  const raw = typeof rawAuthContent === 'string' ? rawAuthContent : '';
  if (!raw) return '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';

  const directKeyEntries: string[] = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.type !== 'api') continue;
    const key = entry.key;
    if (typeof key !== 'string' || key.length === 0) continue;
    if (isOpenCodeRequestAuthMarker(key)) continue;
    directKeyEntries.push(`${name}=${key}`);
  }

  if (directKeyEntries.length === 0) return '';
  return createHash('sha256').update(directKeyEntries.sort().join('\0')).digest('hex');
}
