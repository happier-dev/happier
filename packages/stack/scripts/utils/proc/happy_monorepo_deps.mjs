import { join } from 'node:path';

import { pathExists } from '../fs/fs.mjs';
import { coerceHappyMonorepoRootFromPath } from '../paths/paths.mjs';

export async function ensureHappyMonorepoNestedDepsInstalled({
  happyTestDir,
  quiet = false,
  env = process.env,
  ensureDepsInstalled,
} = {}) {
  const dir = String(happyTestDir ?? '').trim();
  if (!dir) return { monorepoRoot: null, ensured: [] };

  const monorepoRoot = coerceHappyMonorepoRootFromPath(dir);
  if (!monorepoRoot || monorepoRoot !== dir) return { monorepoRoot: monorepoRoot ?? null, ensured: [] };

  const ensure = ensureDepsInstalled;
  if (typeof ensure !== 'function') {
    throw new Error('ensureHappyMonorepoNestedDepsInstalled: missing ensureDepsInstalled implementation');
  }

  const candidates = [
    { subdir: 'cli', label: 'happy-cli (monorepo)' },
    { subdir: 'server', label: 'happy-server (monorepo)' },
  ];

  const ensured = [];
  for (const c of candidates) {
    const pkgDir = join(monorepoRoot, c.subdir);
    if (!(await pathExists(join(pkgDir, 'package.json')))) continue;
    await ensure(pkgDir, c.label, { quiet, env });
    ensured.push(c.subdir);
  }

  return { monorepoRoot, ensured };
}

