// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import * as dependencies from './dependency_refresh.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { resolvePnpmCommandInvocation } from '../../../../../scripts/workspaces/execPnpmCommand.mjs';
import { resolveCommandWorkspaceLocks, resolveRemoteCommandPolicy } from '../dev_targets/remote_commands.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { withWorkspaceBuildResources } from './workspace_build_admission.mjs';

const execFileAsync = promisify(execFile);

async function setup(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-writer-only-refresh-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true }));
  await writeFile(fixture.path('pnpm-lock.yaml'), '# installed A\n');
  return { fixture, env };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}



test('lockfile-only input writers share refresh exclusion without retaining dependency reader custody', async t => {
  const { fixture, env } = await setup(t);
  const policy = resolveRemoteCommandPolicy(['pnpm', 'install', '--lockfile-only'], { repoRoot: fixture.root });
  const locks = resolveCommandWorkspaceLocks(policy, fixture.root, env);
  assert.equal(locks.length, 1);
  assert.equal(locks[0].path, dependencies.resolveDependencyRefreshLockPath(fixture.root, env));
  const held = deferred(), release = deferred();
  const refresh = dependencies.withDependencyRefreshLock({ installDir: fixture.root, env }, async () => {
    held.resolve(); await release.promise;
  });
  await held.promise;
  try {
    await assert.rejects(withWorkspaceBuildResources({ locks, env: { ...env,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0' }, signal: t.signal }, () => assert.fail('writer raced refresh')),
    { code: 'EJSONOWNERFILELOCKBUSY' });
  } finally { release.resolve(); await refresh; }
  const tryRefresh = deferred();
  const competingRefresh = (async () => {
    await tryRefresh.promise;
    return await dependencies.withDependencyRefreshLock({ installDir: fixture.root, env, wait: false },
      () => assert.fail('refresh raced input writer'));
  })();
  await withWorkspaceBuildResources({ locks, env, signal: t.signal }, async () => {
    assert.equal(dependencies.isDependencyRefreshLockActive({ installDir: fixture.root, env }), true);
    tryRefresh.resolve();
    await assert.rejects(competingRefresh, { code: 'EJSONOWNERFILELOCKBUSY' });
  });
  assert.equal(dependencies.isDependencyRefreshLockActive({ installDir: fixture.root, env }), false);
});

test('lockfile-only launcher repairs mismatched patch inputs without preparing or mutating node_modules', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-lockfile-writer-live-' });
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root });
  const root = join(fixture.root, 'native-owner');
  const { packageManager } = JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, packageManager,
    scripts: { install: 'node scripts/api-governance/cli.mjs --write' } }));
  const realPnpm = spawnSync('/bin/sh', ['-c', 'command -v pnpm'], { encoding: 'utf8' });
  assert.equal(realPnpm.status, 0, realPnpm.stderr);
  const writerEnv = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root };
  const lockPath = dependencies.resolveDependencyRefreshLockPath(root, writerEnv);
  // Replace the fixture's package-manager process boundary with real pinned
  // pnpm; launcher, bootstrap, admission, locking and refresh stay real.
  await writeFile(join(root, '.fixture-pnpm/bin/pnpm'), `#!${process.execPath}
const {spawnSync}=require('node:child_process');
if(process.argv.includes('--lockfile-only') && !require('node:fs').existsSync(${JSON.stringify(lockPath)})) process.exit(89);
const child=spawnSync(${JSON.stringify(realPnpm.stdout.trim())},process.argv.slice(2),{stdio:'inherit'});
if(child.error) throw child.error;
process.exit(child.status ?? 1);
`);
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: '',
    HAPPIER_EXEC_CONFIG_PATH: '', HAPPIER_HSTACK_EXECUTION: '', HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0',
    HAPPIER_STACK_HOME_DIR: fixture.root };
  const pnpm = args => execFileAsync(realPnpm.stdout.trim(), args, { cwd: root, env, signal: t.signal });
  const workspace = 'packages:\n  - apps/*\nautoInstallPeers: true\n';
  await writeFile(join(root, 'pnpm-workspace.yaml'), workspace);
  await pnpm(['install', '--lockfile-only', '--ignore-scripts', '--offline']);
  const beforeLockfile = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
  await mkdir(join(root, 'patches'));
  await writeFile(join(root, 'patches/dummy.patch'), 'diff --git a/dummy.txt b/dummy.txt\n--- a/dummy.txt\n+++ b/dummy.txt\n@@ -1 +1 @@\n-before\n+after\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), workspace + 'allowUnusedPatches: true\npatchedDependencies:\n  dummy@1.0.0: patches/dummy.patch\n');
  const sentinel = join(root, 'node_modules', 'retained.js');
  await writeFile(sentinel, 'retained tree\n');
  const tree = await lstat(join(root, 'node_modules'));
  await assert.rejects(pnpm(['install', '--frozen-lockfile', '--ignore-scripts', '--offline']),
    error => /ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/u.test(error.stdout + error.stderr));
  const written = await execFileAsync(launcher, ['--local', '--', 'pnpm', 'install', '--lockfile-only', '--offline'],
    { cwd: root, env, signal: t.signal });
  assert.doesNotMatch(written.stdout + written.stderr, /HAPPIER_DEPENDENCY_REFRESH_FAILED/u);
  assert.notEqual(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'), beforeLockfile);
  assert.equal((await lstat(join(root, 'node_modules'))).ino, tree.ino);
  assert.equal(await readFile(sentinel, 'utf8'), 'retained tree\n');
  await pnpm(['install', '--frozen-lockfile', '--ignore-scripts', '--offline']);
});

test('frozen pnpm failure preserves the existing tree and marker and the corrected rerun succeeds', async t => {
  const { fixture, env } = await setup(t);
  const rootPackage = JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8'));
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, packageManager: rootPackage.packageManager }));
  const workspace = 'packages:\n  - packages/*\nautoInstallPeers: true\n';
  await writeFile(fixture.path('pnpm-workspace.yaml'), workspace);
  // Real pnpm is the boundary under investigation. No dependency download or
  // registry is needed: the fixture is an empty offline workspace.
  const pnpm = args => {
    const invocation = resolvePnpmCommandInvocation(args, { preferPath: true });
    const result = spawnSync(invocation.command, invocation.args, { cwd: fixture.root, env,
      encoding: 'utf8', windowsVerbatimArguments: invocation.windowsVerbatimArguments });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Object.assign(new Error('pnpm install failed'), {
      stdout: result.stdout, stderr: result.stderr, status: result.status });
    return result;
  };
  pnpm(['install', '--lockfile-only', '--ignore-scripts', '--offline']);
  const lockfile = await readFile(fixture.path('pnpm-lock.yaml'), 'utf8');
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, () => {
    pnpm(['install', '--frozen-lockfile', '--ignore-scripts', '--offline']);
  });
  const sentinel = fixture.path('node_modules', 'retained.js');
  await writeFile(sentinel, 'the installed tree stays in place\n');
  const tree = await lstat(fixture.path('node_modules'));
  const marker = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
  const admitted = await readFile(marker, 'utf8');
  await writeFile(fixture.path('pnpm-workspace.yaml'), workspace.replace('true', 'false'));
  await assert.rejects(dependencies.withDependencyRefresh({ installDir: fixture.root, env }, () => {
    pnpm(['install', '--frozen-lockfile', '--ignore-scripts', '--offline']);
  }), error => {
    assert.match([error.stdout, error.stderr, error.cause?.stdout, error.cause?.stderr].map(value => String(value ?? '')).join('\n'),
      /ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/u, 'the real frozen validator must reject the mid-edit workspace settings');
    assert.equal(error.code, 'HAPPIER_DEPENDENCY_REFRESH_FAILED');
    assert.equal(error.pnpmErrorCode, 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH');
    return true;
  });
  assert.equal(await readFile(sentinel, 'utf8'), 'the installed tree stays in place\n');
  assert.equal((await lstat(fixture.path('node_modules'))).ino, tree.ino, 'refresh never renames the dependency tree');
  assert.equal(await readFile(marker, 'utf8'), admitted, 'failed pnpm validation must preserve admission bytes');
  assert.equal((await dependencies.inspectDependencyRefresh({ installDir: fixture.root, env })).required, true);
  // Finish the in-flight edit by regenerating its canonical lockfile, then use
  // the same production owner and real frozen install to recover.
  pnpm(['install', '--lockfile-only', '--ignore-scripts', '--offline']);
  assert.notEqual(await readFile(fixture.path('pnpm-lock.yaml'), 'utf8'), lockfile);
  assert.equal((await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, () => {
    pnpm(['install', '--frozen-lockfile', '--ignore-scripts', '--offline']);
  })).refreshed, true);
  assert.equal((await dependencies.inspectDependencyRefresh({ installDir: fixture.root, env })).required, false);
});

test('a detached former writer cannot bypass a later independent writer', async t => {
  const { fixture, env } = await setup(t);
  const resumeDetached = deferred(), detachedEntered = deferred();
  let detached;
  await dependencies.withDependencyRefreshLock({ installDir: fixture.root, env }, async () => {
    detached = (async () => {
      await resumeDetached.promise;
      await dependencies.withDependencyRefreshLock({ installDir: fixture.root, env }, async () => { detachedEntered.resolve(); });
    })();
  });
  let timer;
  try {
    await dependencies.withDependencyRefreshLock({ installDir: fixture.root, env }, async () => {
      resumeDetached.resolve();
      const result = await Promise.race([detachedEntered.promise.then(() => 'bypassed'),
        new Promise(resolve => { timer = setTimeout(() => resolve('waiting'), 50); })]);
      assert.equal(result, 'waiting', 'released asynchronous context grants no writer authority');
    });
    await detached;
  } finally { clearTimeout(timer); await detached; }
});

test('a second writer waits then rechecks and reuses the first installation', async t => {
  const { fixture, env } = await setup(t);
  const entered = deferred(), release = deferred();
  let installs = 0;
  const first = dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {
    installs++; entered.resolve(); await release.promise;
  });
  await entered.promise;
  const second = dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => { installs++; });
  try { assert.equal(installs, 1); }
  finally { release.resolve(); }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.refreshed, true);
  assert.equal(b.refreshed, false);
  assert.equal(installs, 1);
});

test('starter readiness waits for an active writer and consumes complete installed bytes', async t => {
  const { fixture, env } = await setup(t);
  const entered = deferred(), release = deferred();
  const sentinel = fixture.path('node_modules', 'ready.js');
  const writer = dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {
    await writeFile(sentinel, 'partial'); entered.resolve(); await release.promise;
    await writeFile(sentinel, 'complete');
  });
  await entered.promise;
  let consumed = false;
  const starter = dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => assert.fail('the active writer prepares the tree'))
    .then(async () => { assert.equal(await readFile(sentinel, 'utf8'), 'complete'); consumed = true; });
  try { assert.equal(consumed, false); }
  finally { release.resolve(); }
  await Promise.all([writer, starter]);
  assert.equal(consumed, true);
});

test('refresh records the identity consumed before install and a later source edit requires the next refresh', async t => {
  const { fixture, env } = await setup(t);
  let installs = 0;
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {
    installs++;
    await writeFile(fixture.path('pnpm-lock.yaml'), '# edited while installing\n');
  });
  const marker = JSON.parse(await readFile(dependencies.resolveDependencyRefreshMarkerPath(fixture.root), 'utf8'));
  assert.equal(typeof marker.identity, 'string');
  assert.deepEqual(Object.keys(marker).sort(), ['identity', 'stacksNeedingRestart', 'version']);
  assert.equal((await dependencies.inspectDependencyRefresh({ installDir: fixture.root, env })).required, true);
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => { installs++; });
  assert.equal((await dependencies.inspectDependencyRefresh({ installDir: fixture.root, env })).required, false);
  assert.equal(installs, 2);
});

test('output repair failure preserves an already-admitted marker', async t => {
  const { fixture, env } = await setup(t);
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const marker = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
  const before = await readFile(marker, 'utf8');
  await assert.rejects(dependencies.withDependencyRefresh({ installDir: fixture.root, env,
    onDependenciesReady: async () => { throw new Error('output prerequisite failed'); } },
  async () => assert.fail('warm output repair does not install')), /output prerequisite failed/);
  assert.equal(await readFile(marker, 'utf8'), before);
});

test('explicit no-refresh flags preserve the installed marker and skip installation', async t => {
  const { fixture, env } = await setup(t);
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const marker = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
  const before = await readFile(marker, 'utf8');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# changed while refresh is disabled\n');
  for (const flag of ['HAPPIER_STACK_SKIP_REFRESH_DEPS', 'HAPPIER_STACK_DISABLE_REFRESH_DEPS']) {
    assert.deepEqual(await dependencies.withDependencyRefresh({ installDir: fixture.root, env: { ...env, [flag]: '1' } },
      async () => assert.fail('an explicit no-refresh flag must prevent installation')),
    { refreshed: false, reason: 'refresh-disabled' });
    assert.equal(await readFile(marker, 'utf8'), before);
  }
  assert.equal((await dependencies.inspectDependencyRefresh({ installDir: fixture.root, env })).required, true);
});

test('explicit provisioner adoption admits a new tree but never certifies mismatched or malformed existing markers', async t => {
  const { fixture, env } = await setup(t);
  const options = { installDir: fixture.root, env };
  assert.deepEqual(await dependencies.adoptDependencyInstallation(options),
    { refreshed: false, reason: 'adopted-installation' });
  await dependencies.assertDependenciesReady(options);
  const marker = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
  const before = await readFile(marker, 'utf8');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# provisioner has not installed this edit\n');
  await assert.rejects(dependencies.adoptDependencyInstallation(options),
    { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
  assert.equal(await readFile(marker, 'utf8'), before);
  await writeFile(marker, 'malformed existing marker');
  await assert.rejects(dependencies.adoptDependencyInstallation(options),
    { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
  assert.equal(await readFile(marker, 'utf8'), 'malformed existing marker');
});

test('only successful outer writers publish completion, including same-identity forced refreshes', async t => {
  const { fixture, env } = await setup(t);
  const options = { installDir: fixture.root, env };
  const generationPath = `${dependencies.resolveDependencyRefreshLockPath(fixture.root, env)}.generation`;
  const readGeneration = async () => JSON.parse(await readFile(generationPath, 'utf8'));
  await dependencies.withDependencyRefresh(options, async () => {});
  const initial = await readGeneration();
  assert.equal(initial.completedGeneration, initial.generation);
  const markerPath = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
  const marker = await readFile(markerPath, 'utf8');
  await dependencies.withDependencyRefresh({ ...options, force: true }, async () => {});
  const forced = await readGeneration();
  assert.equal((await dependencies.readDependencyPublicationState(options)).completedGeneration, forced.completedGeneration);
  assert.notEqual(forced.completedGeneration, initial.completedGeneration);
  assert.equal(forced.completedGeneration, forced.generation);
  assert.equal(await readFile(markerPath, 'utf8'), marker,
    'same-identity refresh is observable without changing install admission');
  await dependencies.withDependencyRefreshLock(options, async () => {
    await dependencies.markDependencyMutation(options);
    await dependencies.withDependencyRefreshLock({ ...options, env: dependencies.resolveLockedInstallEnv(env) }, async () => {
      await dependencies.markDependencyMutation(options);
    });
    assert.equal((await readGeneration()).completedGeneration, forced.completedGeneration,
      'nested prerequisite completion cannot publish before its containing writer succeeds');
  });
  const nested = await readGeneration();
  assert.equal(nested.completedGeneration, nested.generation);
  assert.notEqual(nested.completedGeneration, forced.completedGeneration);
  for (const phase of ['install', 'outputs']) {
    if (phase === 'outputs') await dependencies.withDependencyRefresh(options, async () => {});
    const beforeFailure = await readGeneration();
    let outputFailureReached = false;
    await assert.rejects(dependencies.withDependencyRefresh({ ...options, force: phase === 'install',
      onDependenciesReady: phase === 'outputs' ? async () => {
        outputFailureReached = true;
        await dependencies.markDependencyMutation(options);
        throw new Error('K1 repair failed');
      } : null },
    async () => {
      assert.equal(phase, 'install', 'a warm K1 repair must reach its own failure without reinstalling');
      throw new Error('installation failed');
    }));
    assert.equal(outputFailureReached, phase === 'outputs');
    const failed = await readGeneration();
    assert.notEqual(failed.generation, beforeFailure.generation);
    assert.equal(failed.completedGeneration, beforeFailure.completedGeneration,
      'a failed installation or K1 repair does not publish success');
  }
  const beforeNoop = await readFile(generationPath, 'utf8');
  await dependencies.withDependencyRefreshLock(options, async () => {});
  assert.equal(await readFile(generationPath, 'utf8'), beforeNoop,
    'read-only writer scopes do not rewrite completion state');
});

test('a same-identity partial forced install preserves its marker and the next ordinary command reinstalls and recovers', async t => {
  const { fixture, env } = await setup(t);
  const options = { installDir: fixture.root, env };
  const output = fixture.path('node_modules', 'installed.js');
  await dependencies.withDependencyRefresh(options, async () => { await writeFile(output, 'complete'); });
  const markerPath = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
  const marker = await readFile(markerPath, 'utf8');
  await assert.rejects(dependencies.withDependencyRefresh({ ...options, force: true }, async () => {
    // A real installer subprocess can fail after it has linked some bytes.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[1], 'partial'); process.exitCode = 2;", output],
    { encoding: 'utf8' });
    if (child.error) throw child.error;
    assert.equal(child.status, 2);
    throw new Error('installer subprocess failed after linking');
  }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  assert.equal(await readFile(markerPath, 'utf8'), marker);
  assert.equal(await readFile(output, 'utf8'), 'partial');
  assert.equal((await dependencies.inspectDependencyRefresh(options)).required, true,
    'the uncompleted writer attempt makes an unchanged install identity stale');
  let reinstalls = 0;
  const recovered = await dependencies.withDependencyRefresh(options, async () => {
    reinstalls++;
    await writeFile(output, 'complete');
  });
  assert.equal(recovered.refreshed, true);
  assert.equal(reinstalls, 1);
  assert.equal(await readFile(output, 'utf8'), 'complete');
  assert.equal((await dependencies.inspectDependencyRefresh(options)).required, false);
});

test('explicit adoption refuses an unfinished installation even without a prior marker', async t => {
  const { fixture, env } = await setup(t);
  const options = { installDir: fixture.root, env };
  await assert.rejects(dependencies.withDependencyRefresh(options, async () => {
    throw new Error('cold installer failed');
  }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  await assert.rejects(readFile(dependencies.resolveDependencyRefreshMarkerPath(fixture.root)), { code: 'ENOENT' });
  await assert.rejects(dependencies.adoptDependencyInstallation(options), { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
});
