import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureHappyMonorepoNestedDepsInstalled } from './happy_monorepo_deps.mjs';

async function mkMonorepoRoot() {
  const root = await mkdtemp(join(tmpdir(), 'hs-mono-deps-'));
  await mkdir(join(root, 'packages', 'app'), { recursive: true });
  await mkdir(join(root, 'packages', 'cli'), { recursive: true });
  await mkdir(join(root, 'packages', 'server'), { recursive: true });
  await writeFile(join(root, 'packages', 'app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'packages', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'packages', 'server', 'package.json'), '{}\n', 'utf-8');
  return root;
}

test('ensureHappyMonorepoNestedDepsInstalled installs cli/server deps when running tests at the monorepo root', async (t) => {
  const root = await mkMonorepoRoot();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

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
  assert.deepEqual(out.ensured.sort(), ['packages/cli', 'packages/server']);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.dir).sort(),
    [join(root, 'packages', 'cli'), join(root, 'packages', 'server')].sort()
  );
});

test('ensureHappyMonorepoNestedDepsInstalled is a no-op when invoked from inside a package directory', async (t) => {
  const root = await mkMonorepoRoot();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const calls = [];
  const ensureDepsInstalled = async (dir, label) => {
    calls.push({ dir, label });
  };

  const out = await ensureHappyMonorepoNestedDepsInstalled({
    happyTestDir: join(root, 'packages', 'app'),
    quiet: true,
    env: { ...process.env },
    ensureDepsInstalled,
  });

  assert.equal(out.monorepoRoot, root);
  assert.deepEqual(out.ensured, []);
  assert.equal(calls.length, 0);
});
