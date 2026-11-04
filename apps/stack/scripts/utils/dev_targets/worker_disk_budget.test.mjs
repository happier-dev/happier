import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, utimes, access, symlink, rm, readFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHappierTempDir, getHappierTempDirOwnerPath } from '@happier-dev/cli-common/tempDirs';
import { adoptDependencyInstallation } from '../proc/dependency_refresh.mjs';

test('cold Yarn admission measures matching copies and warns without refusing an unmeasured identity', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-yarn-footprint-' });
  const repoDir = join(root, 'cold'), reference = join(root, 'installed');
  const cacheBaseDir = join(root, 'cache'), bin = join(root, 'bin');
  const diskReads = join(root, 'disk-reads');
  await mkdir(bin);
  await mkdir(cacheBaseDir);
  const dependencyOwner = fileURLToPath(new URL('../proc/dependency_refresh.mjs', import.meta.url));
  for (const repo of [repoDir, reference]) {
    const owner = join(repo, 'apps/stack/scripts/utils/proc');
    await mkdir(owner, { recursive: true });
    await symlink(dependencyOwner, join(owner, 'dependency_refresh.mjs'));
    await writeFile(join(repo, 'package.json'), JSON.stringify({ private: true, packageManager: 'yarn@1.22.22', workspaces: ['apps/*'] }));
    await writeFile(join(repo, 'yarn.lock'), '# matching fixture lock\n');
    await writeFile(join(repo, 'apps/stack/package.json'), '{"name":"fixture-stack"}');
  }
  const packagePath = 'node_modules/fixture-package';
  const nestedPath = 'apps/stack/node_modules/nested-package';
  for (const path of [packagePath, nestedPath]) {
    await mkdir(join(reference, path), { recursive: true });
    await writeFile(join(reference, path, 'package.json'), '{"name":"fixture-package"}');
    await writeFile(join(reference, path, 'index.js'), Buffer.alloc(8192));
  }
  await adoptDependencyInstallation({ installDir: reference, componentDir: join(reference, 'apps/stack') });
  const setFreeKiB = async free => {
    await writeFile(join(bin, 'df'), `#!/bin/sh\nprintf x >> "$DF_CALLS"\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 1000000 999999 ${free} 100%% /\\n'\n`, { mode: 0o700 });
  };
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('./worker_disk_budget.mjs', import.meta.url)),
    '--admit', '--cold-dependencies', '--class=dependency-install', `--repo=${repoDir}`, `--cache=${cacheBaseDir}`], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DF_CALLS: diskReads },
  });
  await setFreeKiB(1);
  await t.test('measured missing root and workspace copies govern admission before installation', async () => {
    assert.equal(run().status, 76);
    await assert.rejects(access(join(repoDir, 'node_modules')), { code: 'ENOENT' });
    await setFreeKiB(1024);
    assert.equal(run().status, 0);
  });
  await setFreeKiB(1);
  await t.test('unmatched identity preserves admission with a typed visible warning and missing reference', async () => {
    await writeFile(join(reference, 'yarn.lock'), '# different fixture closure\n');
    await writeFile(diskReads, '');
    const unknown = run();
    assert.equal(unknown.status, 0);
    assert.equal(await readFile(diskReads, 'utf8'), '', 'unmeasured footprint adds no disk admission beyond the existing containing command');
    const result = JSON.parse(unknown.stdout);
    assert.equal(result.warnings[0].code, 'HSTACK_DEPENDENCY_FOOTPRINT_UNMEASURED');
    assert.equal(result.warnings[0].packageManager, 'yarn@1.22.22');
    assert.match(result.warnings[0].identity, /^[a-f0-9]{64}$/);
    assert.equal(result.warnings[0].missingReference, 'matching-admitted-copy');
    assert.match(unknown.stderr, /HSTACK_DEPENDENCY_FOOTPRINT_UNMEASURED/);
    assert.ok(unknown.stderr.includes(result.warnings[0].identity));
    assert.match(unknown.stderr, /matching-admitted-copy/);
    assert.equal(result.warnings[0].referenceParent, root);
    // Once the admitted matching reference is restored, its measured demand applies.
    await writeFile(join(reference, 'yarn.lock'), '# matching fixture lock\n');
    assert.equal(run().status, 76);
    await writeFile(join(reference, 'apps/stack/package.json'), '{"name":"fixture-stack","dependencies":{"other":"1.0.0"}}');
    const stale = run();
    assert.equal(stale.status, 0, 'equal lockfile bytes cannot make a stale installation a matching admitted reference');
    assert.equal(JSON.parse(stale.stdout).warnings[0].missingReference, 'matching-admitted-copy');
    await writeFile(join(reference, 'apps/stack/package.json'), '{');
    const invalidReference = run();
    assert.equal(invalidReference.status, 0, 'an unusable neighboring installation is still an unmeasured footprint');
    assert.equal(JSON.parse(invalidReference.stdout).warnings[0].missingReference, 'matching-admitted-copy');
    await writeFile(join(reference, 'apps/stack/package.json'), '{"name":"fixture-stack"}');
  });
  for (const path of [packagePath, nestedPath]) {
    await mkdir(join(repoDir, path), { recursive: true });
    await writeFile(join(repoDir, path, 'package.json'), '{"name":"fixture-package"}');
    await writeFile(join(repoDir, path, 'index.js'), Buffer.alloc(8192));
  }
  await t.test('truncated root and missing workspace-local files still require additional writes', async () => {
    await writeFile(join(repoDir, packagePath, 'index.js'), Buffer.alloc(1));
    assert.equal(run().status, 76);
    await writeFile(join(repoDir, packagePath, 'index.js'), Buffer.alloc(8192));
    const shared = join(root, 'retained-package-link');
    await link(join(repoDir, packagePath, 'index.js'), shared);
    const old = new Date(1000);
    await utimes(join(repoDir, packagePath, 'index.js'), old, old);
    assert.equal(run().status, 76, 'replacing one of several links cannot reclaim the shared file allocation');
    await rm(shared);
    await rm(join(repoDir, nestedPath, 'index.js'));
    assert.equal(run().status, 76);
  });
  await t.test('warm admitted installations and pnpm retain their existing admission', async () => {
    await writeFile(join(repoDir, nestedPath, 'index.js'), Buffer.alloc(8192));
    await adoptDependencyInstallation({ installDir: repoDir, componentDir: join(repoDir, 'apps/stack') });
    await writeFile(diskReads, '');
    assert.equal(run().status, 0);
    assert.equal(await readFile(diskReads, 'utf8'), '', 'a warm installation adds zero disk observations');
    await writeFile(join(repoDir, 'package.json'), '{"private":true,"packageManager":"pnpm@10.0.0"}');
    assert.equal(run().status, 0);
    assert.equal(await readFile(diskReads, 'utf8'), '', 'pnpm retains its containing command admission without a second disk scan');
  });
});

test('read-only disk checks refuse exhausted filesystems without running reclamation', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-disk-placement-' });
  const bin = join(root, 'bin');
  await mkdir(bin);
  const reads = join(root, 'reads');
  const owner = fileURLToPath(new URL('./worker_disk_budget.mjs', import.meta.url));
  for (const free of [0, 1, 1_886_445]) {
    await writeFile(reads, '');
    await writeFile(join(bin, 'df'), `#!/bin/sh\nprintf x >> "$DISK_READS"\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 1000000 999999 ${free} 100%% /\\n'\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [owner, '--check', '--class=validation',
      `--repo=${root}`, `--cache=${root}`], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DISK_READS: reads },
    });
    assert.equal(result.status, free > 1_886_444 ? 0 : 76, result.stderr);
    assert.equal(JSON.parse(result.stdout).admitted, free > 1_886_444);
    assert.equal(await readFile(reads, 'utf8'), 'x', 'one filesystem observation, no reclaim/reobservation at placement');
  }
});

test('validation refuses less than the measured validation scratch footprint on its write filesystem', async () => {
  const { inspectWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  // mac2-linux, 2026-11-01: the largest observed executor validation TMPDIR
  // occupied 1,886,444 KiB; this is future scratch demand for another run.
  const measuredScratchBytes = 1_931_718_656;
  for (const commandClass of ['validation', 'targeted-validation', 'full-validation', 'native-source-test', 'focused-validation', 'entry-loads']) {
    for (const availableBytes of [209 * 1024 * 1024, measuredScratchBytes - 1, measuredScratchBytes, measuredScratchBytes + 1]) {
      const options = { repoDir: '/fixture/repo', cacheBaseDir: '/fixture/cache', scratchRoot: '/fixture/scratch', commandClass,
        observeFilesystem: path => ({ device: path, availableBytes,
          totalBytes: 248505155584 }) };
      const result = await inspectWorkerDiskBudget(options);
      assert.equal(result.admitted, availableBytes > measuredScratchBytes, `${commandClass}: free=${availableBytes}`);
      if (!result.admitted) assert.match(result.reason, /measured.*1931718656/);
      assert.equal((await inspectWorkerDiskBudget({ ...options, requiredAdditionalBytes: measuredScratchBytes + 1 })).admitted, false,
        'larger measured demand remains authoritative');
    }
  }
});

test('every admission resource class has executable disk admission', async () => {
  const { HEAVYWEIGHT_COMMAND_RESOURCES } = await import('./remote_commands.mjs');
  const { inspectWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  for (const [commandClass, resource] of Object.entries(HEAVYWEIGHT_COMMAND_RESOURCES)) {
    const result = await inspectWorkerDiskBudget({ repoDir: '/fixture/repo', cacheBaseDir: '/fixture/cache',
      scratchRoot: '/fixture/scratch', commandClass,
      observeFilesystem: path => ({ device: path, availableBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 }) });
    assert.equal(result.admitted, true, commandClass);
    assert.equal(result.commandClass, resource.diskClass, `${commandClass} must use its declared disk shape`);
    assert.ok(result.filesystems.length > 0, `${commandClass} must check its write filesystem`);
  }
});

test('validation preserves larger explicit additional-write measurements', async () => {
  const { inspectWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  for (const commandClass of ['validation', 'targeted-validation', 'full-validation', 'native-source-test', 'focused-validation', 'entry-loads']) {
    for (const availableBytes of [0, 1, 1_931_718_657]) {
      const options = { repoDir: '/fixture/repo', cacheBaseDir: '/fixture/cache', commandClass,
        observeFilesystem: () => ({ device: 'fixture', availableBytes, totalBytes: 248505155584 }) };
      assert.equal((await inspectWorkerDiskBudget(options)).admitted, availableBytes > 1_931_718_656, `${commandClass} at ${availableBytes}`);
      assert.equal((await inspectWorkerDiskBudget({ ...options, requiredAdditionalBytes: availableBytes })).admitted, false,
        'measured additional writes still require actual room');
    }
  }
});

test('native source tests retain validation disk admission including exhausted filesystems', async () => {
  const { inspectWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  for (const availableBytes of [1_931_718_657, 0]) {
    const options = { repoDir: '/fixture/repo', cacheBaseDir: '/fixture/cache',
      observeFilesystem: path => ({ device: path, availableBytes, totalBytes: 1e9 }) };
    const expected = await inspectWorkerDiskBudget({ ...options, commandClass: 'validation' });
    assert.deepEqual(await inspectWorkerDiskBudget({ ...options, commandClass: 'native-source-test' }), expected);
    assert.equal(expected.admitted, availableBytes > 0);
  }
});

test('native custody retains package-dist disk admission including exhausted filesystems', async () => {
  const { inspectWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  for (const availableBytes of [1, 0]) {
    const options = { repoDir: '/fixture/repo', cacheBaseDir: '/fixture/cache',
      scratchRoot: '/fixture/scratch',
      observeFilesystem: path => ({ device: path, availableBytes, totalBytes: 100 }) };
    const expected = await inspectWorkerDiskBudget({ ...options, commandClass: 'package-dist' });
    assert.deepEqual(await inspectWorkerDiskBudget({ ...options, commandClass: 'native-custody' }), expected);
    assert.deepEqual(expected.filesystems.map(filesystem => filesystem.path), [options.repoDir]);
    assert.equal(expected.admitted, availableBytes > 0);
  }
});

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

test('admission and maintenance reclaim expired target scratch siblings while retaining live and fresh roots', { skip: process.platform !== 'linux' }, async t => {
  const { admitWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  for (const maintenance of [false, true]) {
    for (const nestedScratch of [false, true]) {
      await t.test(`${maintenance ? 'maintenance' : 'exhausted admission'} with ${nestedScratch ? 'private' : 'explicit'} scratch`, async t => {
        const { root } = await createTempFixture(t, { prefix: 'hstack-target-retention-' });
        const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache');
        const targetScratch = join(root, 'cli/tmp'), procRoot = join(root, 'proc');
        const scratchRoot = nestedScratch ? join(targetScratch, 'hstack-current') : join(root, 'explicit');
        await mkdir(repoDir);
        await mkdir(cacheBaseDir, { recursive: true });
        await mkdir(scratchRoot, { recursive: true });
        await mkdir(join(procRoot, '42/fd'), { recursive: true });
        const stale = Array.from({ length: 4 }, (_, index) => join(targetScratch, `hstack-completed-${index}`));
        const held = join(targetScratch, 'hstack-held'), fresh = join(targetScratch, 'hstack-fresh');
        const unknown = join(targetScratch, 'unrelated-data');
        const old = new Date(Date.now() - 48 * 3600000);
        for (const path of [...stale, held, fresh, unknown]) {
          await mkdir(path, { recursive: true });
          await writeFile(join(path, 'payload'), 'scratch allocation');
          await utimes(join(path, 'payload'), old, old);
          await utimes(path, old, old);
        }
        await utimes(join(fresh, 'payload'), new Date(), new Date());
        await writeFile(join(procRoot, '42/status'), `State:\tS\nUid:\t${Array(4).fill(process.getuid()).join('\t')}\n`);
        await writeFile(join(procRoot, '42/maps'), '');
        await writeFile(join(procRoot, '42/environ'), '');
        await symlink(held, join(procRoot, '42/cwd'));
        const result = await admitWorkerDiskBudget({ repoDir, cacheBaseDir, scratchRoot, procRoot, maintenance,
          commandClass: 'runtime-build', observeFilesystem: () => ({ device: 'fixture', availableBytes: maintenance ? 1e9 : 0, totalBytes: 2e9 }) });
        assert.equal(result.reclamation.at(-1).reclaimedRoots, stale.length, 'all expired unheld target siblings are reclaimed');
        assert.ok(result.reclaimedBytes > 0);
        for (const path of stale) await assert.rejects(access(path), { code: 'ENOENT' });
        for (const path of [held, fresh, unknown, scratchRoot]) await access(path);
        assert.equal(result.reclamation.at(-1).observationUnavailable, null);
      });
    }
  }
});

test('disk maintenance sweeps nominated system scratch once and preserves fresh or unrelated data', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-system-scratch-' });
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache');
  const scratchRoot = join(root, 'tmp'), systemScratch = join(root, 'var-tmp'), procRoot = join(root, 'proc');
  await Promise.all([repoDir, cacheBaseDir, scratchRoot, systemScratch, procRoot].map(path => mkdir(path, { recursive: true })));
  const stale = join(systemScratch, 'happier-source-runtime-old');
  const fresh = join(systemScratch, 'happier-source-runtime-fresh');
  const unrelated = join(systemScratch, 'other-data');
  const old = new Date(Date.now() - 48 * 3600000);
  for (const path of [stale, unrelated]) {
    await mkdir(path);
    await writeFile(join(path, 'payload'), Buffer.alloc(8192));
    await utimes(join(path, 'payload'), old, old);
    await utimes(path, old, old);
  }
  await mkdir(fresh);
  const { admitWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const result = await admitWorkerDiskBudget({ repoDir, cacheBaseDir, scratchRoot, procRoot,
    additionalScratchRoots: [systemScratch, systemScratch], maintenance: true, commandClass: 'validation',
    observeFilesystem: () => ({ device: 'fixture', availableBytes: 1e9, totalBytes: 2e9 }) });
  assert.equal(result.reclamation.at(-1).reclaimedRoots, 1);
  assert.ok(result.reclaimedBytes >= 8192);
  await assert.rejects(access(stale), { code: 'ENOENT' });
  await access(fresh);
  await access(unrelated);
});

test('disk maintenance retires unused legacy runtime generations and incoming roots through canonical custody', async t => {
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
  const incoming = join(root, 'cli/runtime-build/old/.incoming-happier-runtime-build-abandoned');
  const unknown = join(root, 'cli/runtime-build/old/unrelated');
  await mkdir(incoming);
  await mkdir(unknown);
  const old = new Date(Date.now() - 48 * 3600000);
  await utimes(join(retiredStage, 'repo'), old, old);
  await utimes(join(retiredStage, 'source-files.json'), old, old);
  await utimes(retiredStage, old, old);
  await utimes(incoming, old, old);
  await utimes(unknown, old, old);
  const obsolete = join(cacheBaseDir, 'yarn/v6/npm-obsolete/node_modules/obsolete');
  await mkdir(obsolete, { recursive: true });
  await writeFile(join(obsolete, '.yarn-metadata.json'), JSON.stringify({ remote: { resolved: 'https://example/obsolete.tgz#hash' } }));
  await mkdir(join(scratchRoot, 'happier-runtime-build-old'));
  await utimes(join(scratchRoot, 'happier-runtime-build-old'), old, old);
  const { admitWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const result = await admitWorkerDiskBudget({ repoDir, cacheBaseDir, scratchRoot, procRoot, commandClass: 'runtime-build',
    observeFilesystem: () => ({ device: 'fixture', availableBytes: 0, totalBytes: 1e9 }) });
  assert.equal(result.admitted, false);
  assert.deepEqual(result.reclamation.map(step => step.kind), ['runtime-build', 'scratch']);
  await assert.rejects(access(retiredStage), { code: 'ENOENT' });
  await assert.rejects(access(incoming), { code: 'ENOENT' });
  await access(unknown);
  await access(obsolete); // Package-manager cache retention is not this owner's authority.
  await assert.rejects(access(join(scratchRoot, 'happier-runtime-build-old')), { code: 'ENOENT' });
  assert.equal(result.reason, 'worker write filesystem exhausted');
});

test('roomy-worker maintenance preserves held, fresh and unknown runtime-build children', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-runtime-retention-' });
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache');
  const parent = join(root, 'cli/runtime-build/stack'), procRoot = join(root, 'proc');
  await mkdir(repoDir);
  await mkdir(join(cacheBaseDir, 'yarn/v6'), { recursive: true });
  await mkdir(join(procRoot, '42/fd'), { recursive: true });
  await writeFile(join(procRoot, '42/status'), `State:\tS\nUid:\t${Array(4).fill(process.getuid()).join('\t')}\n`);
  await writeFile(join(procRoot, '42/environ'), '');
  await writeFile(join(procRoot, '42/maps'), '');
  const old = new Date(Date.now() - 48 * 3600000);
  for (const name of ['linux-x64', 'darwin-arm64', 'store', '.incoming-happier-runtime-build-old', 'unrelated']) {
    await mkdir(join(parent, name), { recursive: true });
    await utimes(join(parent, name), old, old);
  }
  await writeFile(join(parent, 'store/fresh-artifact'), 'recently built');
  await symlink(join(parent, 'linux-x64'), join(procRoot, '42/cwd'));
  await symlink(join(parent, 'unrelated'), join(parent, 'win32-x64'));
  const { admitWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const result = await admitWorkerDiskBudget({ repoDir, cacheBaseDir, scratchRoot: join(root, 'absent'), procRoot,
    commandClass: 'runtime-build', maintenance: true,
    observeFilesystem: () => ({ device: 'fixture', availableBytes: 1e9, totalBytes: 2e9 }) });
  assert.equal(result.admitted, true);
  assert.equal(result.reclamation.find(step => step.kind === 'runtime-build')?.reclaimedRoots, 2);
  for (const name of ['linux-x64', 'store', 'unrelated', 'win32-x64']) await access(join(parent, name));
  for (const name of ['darwin-arm64', '.incoming-happier-runtime-build-old']) await assert.rejects(access(join(parent, name)), { code: 'ENOENT' });
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

test('runtime staging retention preserves SDK creators and unknown ownership, and retires only departed runtime builders', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sdk-runtime-retention-' });
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache'), scratchRoot = join(root, 'tmp'), procRoot = join(root, 'proc');
  await mkdir(repoDir); await mkdir(scratchRoot); await mkdir(procRoot);
  const live = createHappierTempDir({ purpose: 'runtime-build', root: scratchRoot });
  const unknown = createHappierTempDir({ purpose: 'runtime-build', root: scratchRoot });
  const ownerPath = getHappierTempDirOwnerPath(unknown);
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  await writeFile(ownerPath, JSON.stringify({ ...owner, processInstanceFingerprint: null }));
  const createDeparted = purpose => {
    const child = spawnSync(process.execPath, ['--conditions=happier-source', '--import', './packages/cli-common/registerSourceRuntime.mjs',
      '--input-type=module', '-e', 'import{createHappierTempDir}from"@happier-dev/cli-common/tempDirs";console.log(createHappierTempDir({root:process.argv[1],purpose:process.argv[2]}));', scratchRoot, purpose], {
      cwd: fileURLToPath(new URL('../../../../../', import.meta.url)), encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
  };
  const orphan = createDeparted('runtime-build'), other = createDeparted('unrelated');
  const old = new Date(Date.now() - 48 * 3600000);
  for (const directory of [live, unknown, orphan, other]) {
    await utimes(directory, old, old);
    await utimes(getHappierTempDirOwnerPath(directory), old, old);
  }
  const { admitWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const result = await admitWorkerDiskBudget({ repoDir, cacheBaseDir, scratchRoot, procRoot, commandClass: 'runtime-build', maintenance: true,
    observeFilesystem: () => ({ device: 'fixture', availableBytes: 1e9, totalBytes: 2e9 }) });
  assert.equal(result.reclamation.find(step => step.kind === 'runtime-build').reclaimedRoots, 1);
  await assert.rejects(access(orphan), { code: 'ENOENT' });
  await assert.rejects(access(getHappierTempDirOwnerPath(orphan)), { code: 'ENOENT' });
  for (const directory of [live, unknown, other]) await access(directory);
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
  await writeFile(join(procRoot, '43/environ'), '');
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
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache'), scratchRoot = join(root, 'scratch');
  await mkdir(repoDir);
  const { inspectWorkerDiskBudget } = await import('./worker_disk_budget.mjs');
  const options = { repoDir, cacheBaseDir, scratchRoot, observeFilesystem: path => ({ device: path, availableBytes: 1, totalBytes: 2000000 }) };
  for (const commandClass of ['dependency-install', 'runtime-build', 'source-bundle', 'source-web-export', 'package-dist', 'compilation', 'validation']) {
    const classOptions = commandClass === 'validation' ? { ...options,
      observeFilesystem: path => ({ device: path, availableBytes: 1_931_718_657, totalBytes: 4e9 }) } : options;
    assert.equal((await inspectWorkerDiskBudget({ ...classOptions, commandClass })).admitted, true, `${commandClass} must not reserve an unmeasured resident closure`);
  }
  const separateFilesystems = { ...options, observeFilesystem: path => ({ device: path, availableBytes: path === repoDir ? 1 : 0, totalBytes: 2000000 }) };
  assert.equal((await inspectWorkerDiskBudget({ ...separateFilesystems, commandClass: 'dependency-install' })).admitted, false, 'install writes must fit the cache filesystem too');
  assert.equal((await inspectWorkerDiskBudget({ ...separateFilesystems, commandClass: 'runtime-build' })).admitted, false, 'runtime writes use the staging filesystem');
  assert.equal((await inspectWorkerDiskBudget({ ...separateFilesystems, commandClass: 'source-bundle' })).admitted, false, 'shared source bundles write to the target home filesystem containing its cache');
  for (const exhausted of [cacheBaseDir, scratchRoot]) {
    assert.equal((await inspectWorkerDiskBudget({ ...options, commandClass: 'source-web-export',
      observeFilesystem: path => ({ device: path, availableBytes: path === exhausted ? 0 : 1, totalBytes: 2000000 }),
    })).admitted, false, 'web exports require free space for both retained inputs/cache and private scratch outputs');
  }
  assert.equal((await inspectWorkerDiskBudget({ ...separateFilesystems, commandClass: 'compilation' })).admitted, true, 'in-place compilation does not copy retained staging or caches');
});

test('loaded admission status observes free space without a circular observer import', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-disk-status-' });
  const native = await installNativeAdmissionFixture({ root });
  await native.brokerStatus();
  const repoDir = join(root, 'repo'), cacheBaseDir = join(root, 'cli/cache');
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules/data'), 'x'.repeat(8192));
  await mkdir(join(cacheBaseDir, 'yarn/v6'), { recursive: true });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../proc/service_memory.mjs', import.meta.url)), '--admission-status', `--admission-root=${native.admissionRoot}`], {
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
    const classOptions = commandClass === 'validation' ? { ...options,
      observeFilesystem: () => ({ device: 'fixture', availableBytes: 1_931_718_657, totalBytes: 4e9 }) } : options;
    assert.equal((await inspectWorkerDiskBudget({ ...classOptions, commandClass })).admitted, true, `${commandClass} reuses the existing install`);
  }
});
