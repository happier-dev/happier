import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeTarList, findMonorepoRoot, resolvePackDirForComponent } from './pack.mjs';

test('analyzeTarList detects bundled workspace deps in tar listing', () => {
  const { hasAgents, hasProtocol } = analyzeTarList([
    'package/dist/index.mjs',
    'package/node_modules/@happier-dev/agents/package.json',
    'package/node_modules/@happier-dev/agents/dist/index.js',
    'package/node_modules/@happier-dev/protocol/package.json',
  ]);
  assert.equal(hasAgents, true);
  assert.equal(hasProtocol, true);
});

test('findMonorepoRoot finds nearest package.json + yarn.lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await mkdir(join(root, 'packages', 'happy-cli'), { recursive: true });

    const nested = join(root, 'packages', 'happy-cli');
    const found = await findMonorepoRoot(nested);
    assert.equal(found, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolvePackDirForComponent maps monorepo root to apps/cli', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await mkdir(join(root, 'apps', 'cli'), { recursive: true });

    const resolved = await resolvePackDirForComponent({
      component: 'happy-cli',
      componentDir: root,
      explicitDir: null,
    });
    assert.equal(resolve(resolved), resolve(join(root, 'apps', 'cli')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
