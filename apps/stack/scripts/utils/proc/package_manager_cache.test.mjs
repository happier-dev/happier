import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

test('worker Yarn retention preserves all protected lock resolutions, live holders, malformed entries and unavailable mirrors', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-worker-yarn-retention-' });
  const cacheBaseDir = join(root, 'cache'), procRoot = join(root, 'proc');
  const cache = join(cacheBaseDir, 'yarn', 'v6');
  await mkdir(join(procRoot, '42', 'fd'), { recursive: true });
  await writeFile(join(procRoot, '42', 'status'), 'State:\tS (sleeping)\n');
  await symlink(root, join(procRoot, '42', 'cwd'));
  await writeFile(join(procRoot, '42', 'maps'), '');
  const repositories = [join(root, '0.3'), join(root, '0.2')];
  for (const [index, dir] of repositories.entries()) {
    await mkdir(dir);
    await writeFile(join(dir, 'yarn.lock'), `# yarn lockfile v1\nfixture:\n  resolved "https://registry.example/current-${index}.tgz#hash"\n`);
  }
  for (const name of ['current-0', 'current-1', 'obsolete', 'held', 'unknown']) {
    const dir = join(cache, `npm-${name}`, 'node_modules', '@fixture', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'data'), 'cached bytes');
    await writeFile(join(dir, '.yarn-metadata.json'), JSON.stringify(name === 'unknown' ? {} : {
      remote: { resolved: `https://registry.example/${name}.tgz#hash` },
    }));
  }
  await symlink(join(cache, 'npm-held', 'node_modules', '@fixture', 'held', 'data'), join(procRoot, '42', 'fd', '9'));
  const linkedMetadata = join(cache, 'npm-linked-metadata', 'node_modules', 'fixture');
  await mkdir(linkedMetadata, { recursive: true });
  const externalMetadata = join(root, 'external-metadata.json');
  await writeFile(externalMetadata, JSON.stringify({ remote: { resolved: 'https://registry.example/unrelated.tgz#hash' } }));
  await symlink(externalMetadata, join(linkedMetadata, '.yarn-metadata.json'));
  const options = { cacheBaseDir, repositoryDirectories: repositories, procRoot };
  const { pruneWorkerYarnCache } = await import('./package_manager_cache.mjs');
  await pruneWorkerYarnCache({ ...options, repositoryDirectories: [...repositories, join(root, 'missing-mirror')] });
  await access(join(cache, 'npm-obsolete'));
  const result = await pruneWorkerYarnCache(options);
  assert.equal(result.reclaimedRoots, 1);
  await assert.rejects(access(join(cache, 'npm-obsolete')), { code: 'ENOENT' });
  for (const name of ['current-0', 'current-1', 'held', 'unknown']) await access(join(cache, `npm-${name}`));
  await access(linkedMetadata);
});
