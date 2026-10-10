import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, utimes, access, symlink, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('package-specific compiler classes inspect the same write filesystems', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-disk-compiler-' });
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache');
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules/data'), 'dependency'.repeat(8192));
  await mkdir(cacheBaseDir, { recursive: true });
  const { inspectWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const options = { repoDir, cacheBaseDir, observeFilesystem: () => ({ device: 'fixture', availableBytes: 1e9, totalBytes: 2e9 }) };
  const compilation = await inspectWorkerDiskBudget({ ...options, commandClass: 'compilation' });
  for (const commandClass of ['compilation-ui', 'compilation-cli', 'compilation-server']) {
    assert.deepEqual(await inspectWorkerDiskBudget({ ...options, commandClass }), compilation);
  }
});

test('disk budget reclaims obsolete packages and unused final scratch without scanning retired source staging', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-disk-budget-' });
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache');
  const retiredStage = join(root, 'cli/runtime-build/old/linux-x64');
  const scratchRoot = join(root, 'scratch'), procRoot = join(root, 'proc');
  await mkdir(repoDir);
  await writeFile(join(repoDir, 'yarn.lock'), '# yarn lockfile v1\nfixture:\n  resolved "https://example/current.tgz#hash"\n');
  await mkdir(join(cacheBaseDir, 'yarn/v6'), { recursive: true });
  await mkdir(join(retiredStage, 'repo'), { recursive: true });
  await writeFile(join(retiredStage, 'source-files.json'), '[]');
  await mkdir(scratchRoot);
  await mkdir(procRoot);
  const old = new Date(Date.now() - 48 * 3600000);
  await utimes(join(retiredStage, 'repo'), old, old);
  await utimes(join(retiredStage, 'source-files.json'), old, old);
  await utimes(retiredStage, old, old);
  const obsolete = join(cacheBaseDir, 'yarn/v6/npm-obsolete/node_modules/obsolete');
  await mkdir(obsolete, { recursive: true });
  await writeFile(join(obsolete, '.yarn-metadata.json'), JSON.stringify({ remote: { resolved: 'https://example/obsolete.tgz#hash' } }));
  await mkdir(join(scratchRoot, 'happier-runtime-build-old'));
  await utimes(join(scratchRoot, 'happier-runtime-build-old'), old, old);
  const { admitWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const result = await admitWorkerDiskBudget({ repoDir, cacheBaseDir, scratchRoot, procRoot, commandClass: 'runtime-build',
    observeFilesystem: () => ({ device: 'fixture', availableBytes: 0, totalBytes: 1e9 }) });
  assert.equal(result.admitted, false);
  assert.deepEqual(result.reclamation.map(step => step.kind), ['packages', 'scratch']);
  await access(retiredStage);
  await assert.rejects(access(obsolete), { code: 'ENOENT' });
  await assert.rejects(access(join(scratchRoot, 'happier-runtime-build-old')), { code: 'ENOENT' });
  assert.equal(result.reason, 'worker write filesystem exhausted');
});

test('runtime build disk admission observes the mirror, cache and final scratch instead of retired source staging', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-disk-runtime-write-owner-' });
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache'), scratchRoot = join(root, 'scratch');
  const { inspectWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const actualWrites = [repoDir, cacheBaseDir, scratchRoot];
  const result = await inspectWorkerDiskBudget({ repoDir, cacheBaseDir, scratchRoot, commandClass: 'runtime-build',
    observeFilesystem: path => ({ device: path, availableBytes: actualWrites.includes(path) ? 1 : 0, totalBytes: 2e9 }) });
  assert.equal(result.admitted, true, 'a retired source tree is not a write resource for a mirror build');
  assert.deepEqual(result.filesystems.map(filesystem => filesystem.path).sort(), actualWrites.sort());
});

test('unknown same-user visibility retains scratch, but other-user processes do not block reclamation or bypass holders', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-disk-unknown-' });
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache'), scratchRoot = join(root, 'scratch'), procRoot = join(root, 'proc');
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules/data'), 'x'.repeat(8192));
  await mkdir(join(cacheBaseDir, 'yarn/v6'), { recursive: true });
  await mkdir(join(scratchRoot, 'happier-old'), { recursive: true });
  await mkdir(join(procRoot, '42'), { recursive: true });
  await writeFile(join(procRoot, '42/status'), 'State:\tS\n');
  const old = new Date(Date.now() - 48 * 3600000);
  await utimes(join(scratchRoot, 'happier-old'), old, old);
  const { admitWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const result = await admitWorkerDiskBudget({ repoDir, cacheBaseDir, scratchRoot, procRoot, commandClass: 'dependency-install', observeFilesystem: () => ({ device: 'fixture', availableBytes: 0, totalBytes: 1e9 }) });
  assert.equal(result.admitted, false);
  assert.equal(result.reclaimedBytes, 0);
  await access(join(scratchRoot, 'happier-old'));
  assert.match(result.reclamation.at(-1).observationUnavailable, /references unavailable/);

  // Add the genuine Linux procfs boundary where PID 1 belongs to another user
  // and may deny cwd/fd visibility. No privilege or foreign-process mutation.
  await rm(join(procRoot, '42'), { recursive: true });
  if (process.platform === 'linux') {
    const initUids = (await readFile('/proc/1/status', 'utf8')).match(/^Uid:\s+(.*)$/m)[1].split(/\s+/);
    if (!initUids.includes(String(process.getuid()))) await symlink('/proc/1', join(procRoot, '1'));
  }
  const held = join(scratchRoot, 'happier-held');
  await mkdir(held);
  await utimes(held, old, old);
  await mkdir(join(procRoot, '43/fd'), { recursive: true });
  await writeFile(join(procRoot, '43/status'), `State:\tS\nUid:\t${Array(4).fill(process.getuid()).join('\t')}\n`);
  await writeFile(join(procRoot, '43/maps'), '');
  await symlink(held, join(procRoot, '43/cwd'));
  // Procfs inode ownership can differ from the process UID (dumpability).
  // Foreign status UIDs, not this same-user fixture directory, decide visibility.
  await mkdir(join(procRoot, '44'));
  await writeFile(join(procRoot, '44/status'), `State:\tS\nUid:\t${Array(4).fill(process.getuid() + 1).join('\t')}\n`);
  const reclaimed = await admitWorkerDiskBudget({ repoDir, cacheBaseDir, scratchRoot, procRoot, commandClass: 'dependency-install', observeFilesystem: () => ({ device: 'fixture', availableBytes: 0, totalBytes: 1e9 }) });
  assert.equal(reclaimed.admitted, false, 'cleanup cannot fabricate available disk');
  assert.equal(reclaimed.reclamation.at(-1).observationUnavailable, null);
  await assert.rejects(access(join(scratchRoot, 'happier-old')), { code: 'ENOENT' });
  await access(held);
});

test('available filesystem space admits work without resident dependency or cache sizing', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-disk-free-' });
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache');
  await mkdir(repoDir);
  const { inspectWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const options = { repoDir, cacheBaseDir, observeFilesystem: path => ({ device: path, availableBytes: 1, totalBytes: 2000000 }) };
  for (const commandClass of ['dependency-install', 'runtime-build', 'source-bundle', 'package-dist', 'compilation', 'validation']) {
    assert.equal((await inspectWorkerDiskBudget({ ...options, commandClass })).admitted, true, `${commandClass} must not reserve an unmeasured resident closure`);
  }
  const separateFilesystems = { ...options, observeFilesystem: path => ({ device: path, availableBytes: path === repoDir ? 1 : 0, totalBytes: 2000000 }) };
  assert.equal((await inspectWorkerDiskBudget({ ...separateFilesystems, commandClass: 'dependency-install' })).admitted, false, 'install writes must fit the cache filesystem too');
  assert.equal((await inspectWorkerDiskBudget({ ...separateFilesystems, commandClass: 'runtime-build' })).admitted, false, 'runtime writes use the staging filesystem');
  assert.equal((await inspectWorkerDiskBudget({ ...separateFilesystems, commandClass: 'source-bundle' })).admitted, false, 'shared source bundles write to the target home filesystem containing its cache');
  assert.equal((await inspectWorkerDiskBudget({ ...separateFilesystems, commandClass: 'compilation' })).admitted, true, 'in-place compilation does not copy retained staging or caches');
});

test('loaded admission status observes free space without a circular observer import', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-disk-status-' });
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache');
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules/data'), 'x'.repeat(8192));
  await mkdir(join(cacheBaseDir, 'yarn/v6'), { recursive: true });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../proc/service_memory.mjs', import.meta.url)), '--admission-status', `--admission-root=${join(root, 'admission')}`], {
    cwd: repoDir, encoding: 'utf8', env: { ...process.env, HAPPIER_STACK_PM_CACHE_BASE_DIR: cacheBaseDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.state, 'observed');
  assert.equal(status.disk.state, 'observed');
  assert.ok(status.disk.filesystems.every(fs => fs.availableBytes > 0));
});

test('resident dependencies and caches do not become additional disk demand', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-disk-inplace-' });
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache');
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules/data'), 'dependency'.repeat(8192));
  await mkdir(join(cacheBaseDir, 'yarn'), { recursive: true });
  await writeFile(join(cacheBaseDir, 'yarn/data'), 'cache'.repeat(8192));
  const { inspectWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const options = { repoDir, cacheBaseDir, observeFilesystem: () => ({ device: 'fixture', availableBytes: 4096, totalBytes: 2e9 }) };
  for (const commandClass of ['dependency-install', 'runtime-build', 'package-dist', 'compilation', 'validation']) {
    assert.equal((await inspectWorkerDiskBudget({ ...options, commandClass })).admitted, true, `${commandClass} reuses the existing install`);
  }
});
