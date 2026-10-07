import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, utimes, access, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

test('disk budget reclaims oldest stale staging before obsolete packages and scratch, preserving newest target and holders', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-disk-budget-' });
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache');
  const runtimeBuildRoot = join(root, 'cli/runtime-build'), scratchRoot = join(root, 'scratch'), procRoot = join(root, 'proc');
  await mkdir(repoDir);
  await mkdir(join(repoDir, 'node_modules'));
  await writeFile(join(repoDir, 'node_modules/data'), 'dependency'.repeat(8192));
  await writeFile(join(repoDir, 'yarn.lock'), '# yarn lockfile v1\nfixture:\n  resolved "https://example/current.tgz#hash"\n');
  await mkdir(join(cacheBaseDir, 'yarn/v6'), { recursive: true });
  await mkdir(scratchRoot);
  await mkdir(join(procRoot, '42/fd'), { recursive: true });
  await writeFile(join(procRoot, '42/status'), 'State:\tS (sleeping)\n');
  await symlink(root, join(procRoot, '42/cwd'));
  await writeFile(join(procRoot, '42/maps'), '');
  const old = new Date(Date.now() - 48 * 3600000);
  const oldest = new Date(Date.now() - 72 * 3600000);
  for (const [stack, target, time] of [['old', 'linux-x64', oldest], ['new', 'linux-x64', old], ['held', 'darwin-arm64', old]]) {
    const stage = join(runtimeBuildRoot, stack, target);
    await mkdir(join(stage, 'repo'), { recursive: true });
    await writeFile(join(stage, 'repo/yarn.lock'), '# yarn lockfile v1\nfixture:\n  resolved "https://example/current.tgz#hash"\n');
    await writeFile(join(stage, 'source-files.json'), '[]');
    await utimes(join(stage, 'repo/yarn.lock'), time, time);
    await utimes(join(stage, 'repo'), time, time);
    await utimes(join(stage, 'source-files.json'), time, time);
    await utimes(stage, time, time);
  }
  await symlink(join(runtimeBuildRoot, 'held/darwin-arm64/source-files.json'), join(procRoot, '42/fd/9'));
  const legacyCache = join(runtimeBuildRoot, 'old/cache');
  await mkdir(legacyCache);
  await writeFile(join(legacyCache, 'old-package'), 'legacy regenerable cache');
  await utimes(join(legacyCache, 'old-package'), oldest, oldest);
  await utimes(legacyCache, oldest, oldest);
  const obsolete = join(cacheBaseDir, 'yarn/v6/npm-obsolete/node_modules/obsolete');
  await mkdir(obsolete, { recursive: true });
  await writeFile(join(obsolete, '.yarn-metadata.json'), JSON.stringify({ remote: { resolved: 'https://example/obsolete.tgz#hash' } }));
  await mkdir(join(scratchRoot, 'happier-old'));
  await utimes(join(scratchRoot, 'happier-old'), old, old);
  const { admitWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const result = await admitWorkerDiskBudget({ repoDir, cacheBaseDir, scratchRoot, procRoot, commandClass: 'runtime-build', target: 'linux-x64', observeFilesystem: () => ({ device: 'fixture', availableBytes: 1, totalBytes: 1e9 }) });
  assert.equal(result.admitted, false);
  assert.deepEqual(result.reclamation.map(step => step.kind), ['staging', 'packages', 'scratch']);
  await assert.rejects(access(join(runtimeBuildRoot, 'old/linux-x64')), { code: 'ENOENT' });
  await assert.rejects(access(legacyCache), { code: 'ENOENT' });
  await access(join(runtimeBuildRoot, 'new/linux-x64'));
  await access(join(runtimeBuildRoot, 'held/darwin-arm64'));
  await assert.rejects(access(obsolete), { code: 'ENOENT' });
  await assert.rejects(access(join(scratchRoot, 'happier-old')), { code: 'ENOENT' });
  assert.ok(result.requiredBytes > 8192);
});

test('unknown process visibility retains every cleanup candidate and low disk is still rejected', async t => {
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
});

test('disk admission charges an authenticated live peer reservation on the same filesystem', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-disk-peer-' });
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache'), admissionRoot = join(root, 'admission');
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules/data'), 'x'.repeat(8192));
  await mkdir(join(cacheBaseDir, 'yarn/v6'), { recursive: true });
  const identity = spawnSync('/bin/sh', ['-c', '. "$1"; heavyweight_process_token "$2"', 'test-identity', fileURLToPath(new URL('../proc/native_process_identity.sh', import.meta.url)), String(process.pid)], { encoding: 'utf8' });
  assert.equal(identity.status, 0, identity.stderr);
  const token = identity.stdout.trim();
  assert.match(token, /^\d+$/);
  const owner = join(admissionRoot, 'owners', `${process.pid}-${token}`);
  await mkdir(owner, { recursive: true });
  await writeFile(join(owner, 'process'), `${process.pid} ${token}\n`);
  await writeFile(join(owner, 'class'), 'validation\n');
  await writeFile(join(owner, 'disk'), JSON.stringify({ filesystems: [{ device: 'fixture', requiredBytes: 1000000 }] }));
  const spawn = childProcess.spawnSync;
  // This fixture is its own physical worker. Keep real kernel observations
  // for its owner without importing unrelated live host reservations.
  const enumerate = t.mock.method(childProcess, 'spawnSync', (command, ...args) => {
    const result = spawn(command, ...args);
    if (command === 'ps') return { ...result, stdout: result.stdout.split('\n').filter(row => Number(row.trim().split(/\s+/)[0]) === process.pid).join('\n') };
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { enumerate.mock.restore(); syncBuiltinESMExports(); });
  const { inspectWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const options = { repoDir, cacheBaseDir, admissionRoot, commandClass: 'validation', observeFilesystem: () => ({ device: 'fixture', availableBytes: 1000000, totalBytes: 2000000 }) };
  assert.equal((await inspectWorkerDiskBudget(options)).admitted, false);
  assert.equal((await inspectWorkerDiskBudget({ ...options, ownOwnerPath: owner })).admitted, true, 'an inherited owner replaces its existing reservation');

  const diskPath = join(owner, 'disk');
  await fs.promises.rm(diskPath);
  await assert.rejects(inspectWorkerDiskBudget(options), { code: 'ENOENT' }, 'a live owner without a published envelope remains unknown');
  await writeFile(diskPath, '{');
  await assert.rejects(inspectWorkerDiskBudget(options), SyntaxError, 'a malformed envelope cannot supply headroom');
  await writeFile(diskPath, JSON.stringify({ filesystems: [{ device: 'fixture', requiredBytes: 1000000 }] }));

  const readFile = fs.readFileSync;
  let retire = false;
  // The filesystem boundary reproduces release after the real OS owner
  // snapshot but before its disk record is read; internal logic stays real.
  const read = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === diskPath) {
      if (!retire) throw Object.assign(new Error('disk permission denied'), { code: 'EACCES' });
      fs.rmSync(owner, { recursive: true });
    }
    return readFile(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(inspectWorkerDiskBudget(options), { code: 'EACCES' });
    retire = true;
    const retired = await inspectWorkerDiskBudget(options);
    assert.equal(retired.admitted, true, 'a retired peer does not prevent admission');
    assert.equal(retired.filesystems[0].reservedBytes, 0);
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
  }
});

test('loaded admission status observes the disk envelope without a circular observer import', async t => {
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
  assert.ok(status.disk.measurements.dependencyBytes >= 8192);
});
