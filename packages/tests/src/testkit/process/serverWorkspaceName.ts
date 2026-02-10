import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { repoRootDir } from '../paths';

let cached: string | null = null;

export function resolveServerAppWorkspaceName(): string {
  if (cached) return cached;

  const fallback = '@happier-dev/server';
  try {
    const pkgPath = resolve(repoRootDir(), 'apps', 'server', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const json = JSON.parse(raw) as { name?: unknown };
    const name = typeof json?.name === 'string' ? json.name.trim() : '';
    cached = name || fallback;
    return cached;
  } catch {
    cached = fallback;
    return cached;
  }
}
