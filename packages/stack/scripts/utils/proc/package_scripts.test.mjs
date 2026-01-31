import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectPackageManagerCmd } from './package_scripts.mjs';

async function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) old[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v == null) delete process.env[k];
      else process.env[k] = String(v);
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('detectPackageManagerCmd prefers yarn when run from a Happy monorepo package dir (packages/ layout)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-package-scripts-happy-monorepo-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Minimal monorepo markers + yarn.lock at the monorepo root.
  await mkdir(join(root, 'packages', 'app'), { recursive: true });
  await mkdir(join(root, 'packages', 'cli'), { recursive: true });
  await mkdir(join(root, 'packages', 'server'), { recursive: true });
  await writeFile(join(root, 'packages', 'app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'packages', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'packages', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'package.json'), '{ "name": "monorepo", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');

  // Ensure we don't accidentally depend on `pnpm` being present.
  await withEnv({ PATH: '/usr/bin:/bin' }, async () => {
    const pm = await detectPackageManagerCmd(join(root, 'packages', 'server'));
    assert.equal(pm.name, 'yarn');
  });
});
