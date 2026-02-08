import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureHappyMonorepoNestedDepsInstalled } from './happy_monorepo_deps.mjs';

async function mkMonorepoRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'hs-mono-deps-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  return root;
}

test('ensureHappyMonorepoNestedDepsInstalled installs cli/server deps when running tests at the monorepo root', async (t) => {
  const root = await mkMonorepoRoot(t);

  const calls = [];
  const ensureDepsInstalled = async (dir, label) => {
    calls.push({ dir, label });
  };

  const out = await ensureHappyMonorepoNestedDepsInstalled({
    happyTestDir: root,
    quiet: true,
    env: { ...process.env },
    ensureDepsInstalled,
  });

  assert.equal(out.monorepoRoot, root);
  assert.deepEqual(out.ensured.sort(), ['apps/cli', 'apps/server']);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.dir).sort(),
    [join(root, 'apps', 'cli'), join(root, 'apps', 'server')].sort()
  );
});

test('ensureHappyMonorepoNestedDepsInstalled is a no-op when invoked from inside a package directory', async (t) => {
  const root = await mkMonorepoRoot(t);

  const calls = [];
  const ensureDepsInstalled = async (dir, label) => {
    calls.push({ dir, label });
  };

  const out = await ensureHappyMonorepoNestedDepsInstalled({
    happyTestDir: join(root, 'apps', 'ui'),
    quiet: true,
    env: { ...process.env },
    ensureDepsInstalled,
  });

  assert.equal(out.monorepoRoot, root);
  assert.deepEqual(out.ensured, []);
  assert.equal(calls.length, 0);
});

test('ensureHappyMonorepoNestedDepsInstalled is a no-op outside monorepo roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-mono-deps-non-root-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'random', 'folder'), { recursive: true });
  const out = await ensureHappyMonorepoNestedDepsInstalled({
    happyTestDir: join(root, 'random', 'folder'),
    quiet: true,
    env: { ...process.env },
    ensureDepsInstalled: async () => {},
  });
  assert.equal(out.monorepoRoot, null);
  assert.deepEqual(out.ensured, []);
});

test('ensureHappyMonorepoNestedDepsInstalled throws when ensureDepsInstalled is missing for monorepo root', async (t) => {
  const root = await mkMonorepoRoot(t);
  await assert.rejects(
    () => ensureHappyMonorepoNestedDepsInstalled({ happyTestDir: root, quiet: true, env: { ...process.env } }),
    /missing ensureDepsInstalled implementation/i
  );
});
