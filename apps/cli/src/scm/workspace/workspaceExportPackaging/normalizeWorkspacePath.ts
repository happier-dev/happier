import { posix } from 'node:path';

export function normalizeWorkspacePath(value: string): string {
  const normalized = posix.normalize(value.replace(/\\/g, '/').trim()).replace(/^\.\//, '');
  return normalized === '.' ? '' : normalized;
}
