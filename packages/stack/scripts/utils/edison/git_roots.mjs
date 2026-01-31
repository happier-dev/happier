import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

export function findGitRootForPath(dir) {
  let cur = resolve(String(dir ?? '').trim());
  if (!cur) return '';
  while (true) {
    try {
      if (existsSync(join(cur, '.git'))) {
        return cur;
      }
    } catch {
      // ignore
    }
    const parent = dirname(cur);
    if (parent === cur) return '';
    cur = parent;
  }
}

export function normalizeGitRoots(paths) {
  const list = Array.isArray(paths) ? paths : [];
  const normalized = list
    .map((d) => findGitRootForPath(d) || String(d ?? '').trim())
    .map((d) => resolve(d))
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

