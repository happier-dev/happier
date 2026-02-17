import { createHash } from 'node:crypto';

export function normalizeMaterializationKeyForPath(raw: string): string {
  const value = String(raw ?? '');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

