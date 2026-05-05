import { createHash } from 'node:crypto';

export function createPetSourceKey(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return `pet:${hash.digest('hex').slice(0, 32)}`;
}
