import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { startRunningStackOwner } from '../../testkit/core/running_stack_owner.mjs';
import { assertDependenciesReady, markDependencyMutation, waitForDependencyRefresh,
  withDependencyConsumption, withDependencyRefresh, withDependencyRefreshLock } from './dependency_refresh.mjs';
import { ensureDepsInstalled } from './pm.mjs';

test('queued publication consumers survive failed installation and repair without package writes', { timeout: 60_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-consume-repair-' });
  const options = { installDir: fixture.root, env: { ...process.env,
    HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' } };
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await mkdir(fixture.path('node_modules'));
  await withDependencyRefresh({ ...options, force: true }, async () => {});
  await assert.rejects(withDependencyRefresh({ ...options, force: true }, async () => {
    throw new Error('fixture installation failed');
  }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  const controller = new AbortController();
  let result;
  const consume = withDependencyConsumption({ ...options, signal: controller.signal, waitForPublication: true }, () => 'repaired');
  void consume.then(value => { result = value; }, error => { result = error.code; });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(result, undefined, 'queued file-map work must remain pending after a failed install');
    await withDependencyRefresh({ ...options, force: true }, async () => {});
    assert.equal(await consume, 'repaired');
    await assert.rejects(withDependencyRefresh({ ...options, force: true }, async () => {
      throw new Error('fixture installation failed again');
    }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
    const cancelled = withDependencyConsumption({ ...options, signal: controller.signal, waitForPublication: true }, () => assert.fail('unfinished bytes consumed'));
    void cancelled.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
  } finally {
    controller.abort();
    await consume.catch(() => {});
  }
});

test('consumers wait for active installation then receive its failure and recover after retry', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-consume-publication-' });
  const options = { installDir: fixture.root, env: { ...process.env,
    HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' } };
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await mkdir(fixture.path('node_modules'));
  await withDependencyRefresh({ ...options, force: true }, async () => {});
  assert.equal(await withDependencyConsumption(options, () => 'ready'), 'ready');
  let releaseInstall, startedInstall;
  const installHeld = new Promise(resolve => { releaseInstall = resolve; });
  const installStarted = new Promise(resolve => { startedInstall = resolve; });
  const installation = withDependencyRefresh({ ...options, force: true }, async () => {
    startedInstall();
    await installHeld;
    throw Object.assign(new Error('installer input mismatch'), { code: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH' });
  });
  await installStarted;
  let consumed = false;
  let settled = 0;
  const consume = withDependencyConsumption(options, () => { consumed = true; });
  const readiness = assertDependenciesReady(options);
  for (const pending of [consume, readiness]) pending.then(() => { settled++; }, () => { settled++; });
  await new Promise(setImmediate);
  assert.equal(settled, 0, 'the active installer, rather than a consumer timer, settles readiness');
  releaseInstall();
  const rejectsInstallationFailure = error => {
    assert.equal(error.code, 'HAPPIER_DEPENDENCY_REFRESH_FAILED');
    assert.equal(error.pnpmErrorCode, 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH');
    assert.match(error.message, /ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/u);
    assert.match(error.message, /fix.*retry/iu);
    return true;
  };
  await assert.rejects(installation, rejectsInstallationFailure);
  await assert.rejects(consume, rejectsInstallationFailure);
  await assert.rejects(readiness, rejectsInstallationFailure);
  await assert.rejects(withDependencyConsumption(options, () => { consumed = true; }), rejectsInstallationFailure);
  await assert.rejects(assertDependenciesReady(options), rejectsInstallationFailure);
  assert.equal(consumed, false, 'no package reads follow a failed installation');
  await withDependencyRefreshLock(options, async () => {
    await markDependencyMutation({ ...options, output: 'server-generated-client:prisma' });
  });
  await assert.rejects(withDependencyConsumption(options, () => assert.fail('partial bytes admitted')),
    rejectsInstallationFailure);
  await withDependencyRefresh({ ...options, force: true }, async () => {});
  assert.equal(await withDependencyConsumption(options, () => 'repaired'), 'repaired');
  await assertDependenciesReady(options);
});

test('an interrupted publication without a writer refuses consumers with a repair remedy', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-consume-interrupted-' });
  const options = { installDir: fixture.root, env: { ...process.env,
    HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' } };
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await mkdir(fixture.path('node_modules'));
  await withDependencyRefresh(options, async () => {});
  await assert.rejects(withDependencyRefreshLock(options, async () => {
    await markDependencyMutation(options);
    throw new Error('writer stopped before settlement');
  }));
  for (const read of [() => waitForDependencyRefresh(options),
    () => withDependencyConsumption(options, () => assert.fail('unfinished bytes cannot be consumed'))]) {
    await assert.rejects(read(), error => {
      assert.equal(error.code, 'HAPPIER_DEPENDENCIES_NEED_REFRESH');
      assert.equal(error.reason, 'unfinished-installation');
      assert.match(error.message, /retry.*preparation/iu);
      return true;
    });
  }
  await withDependencyRefresh(options, async () => {});
  assert.equal(await withDependencyConsumption(options, () => 'repaired'), 'repaired');
});

test('an installer can consume its own admitted mutation and readers can nest', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-consume-nested-' });
  const options = { installDir: fixture.root, env: { ...process.env,
    HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' } };
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await mkdir(fixture.path('node_modules'));
  await withDependencyRefresh({ ...options, force: true }, async () => {
    assert.equal(await withDependencyConsumption(options, () => 'installer'), 'installer');
  });
  assert.equal(await withDependencyConsumption(options, () => withDependencyConsumption(options, () => 'nested')), 'nested');
});

test('the package installer publishes its pnpm diagnostic for later consumers', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-installer-process-publication-' });
  const installer = fixture.path('pnpm.cjs');
  await writeFile(installer, `
    if (process.argv.includes('--version')) { console.log('12.14.0'); }
    else { process.stderr.write('ERR_PNPM_LOCKFILE_CONFIG_MISMATCH'); process.exitCode = 1; }
  `);
  const options = { installDir: fixture.root, env: { ...process.env,
    npm_execpath: installer, HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' } };
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  // Only the external package-manager process is replaced. The public package
  // installer, diagnostic capture, refresh and publication remain real.
  await assert.rejects(ensureDepsInstalled(fixture.root, 'fixture', {
    env: options.env, quiet: true, prepareComponentOutputs: false,
  }), error => {
    assert.equal(error.code, 'HAPPIER_DEPENDENCY_REFRESH_FAILED');
    assert.equal(error.pnpmErrorCode, 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH');
    return true;
  });
  await assert.rejects(withDependencyConsumption(options, () => assert.fail('partial bytes admitted')),
    error => error.code === 'HAPPIER_DEPENDENCY_REFRESH_FAILED'
      && error.pnpmErrorCode === 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH');
  await writeFile(installer, `
    if (process.argv.includes('--version')) { console.log('12.14.0'); }
    else { require('node:fs').mkdirSync('node_modules', { recursive: true }); }
  `);
  await ensureDepsInstalled(fixture.root, 'fixture', {
    env: options.env, quiet: true, prepareComponentOutputs: false,
  });
  assert.equal(await withDependencyConsumption(options, () => 'repaired'), 'repaired');
});

test('later consumers name the real cause of a codeless pnpm 12 installer failure, redacted', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-installer-pnpm12-diagnostic-' });
  const installer = fixture.path('pnpm.cjs');
  const secret = 'fixture-secret-value-0123456789';
  // pnpm 12.14.0 (pacquet) output, verbatim from mac-outer on 2026-11-17: no
  // ERR_PNPM_* code, a wrapped miette headline and cause chain.
  const pnpm12Stderr = [
    'Progress: resolved 1568, reused 1567, downloaded 1, added 0',
    `npm_config__authToken=${secret}`,
    `fixture token: ${secret}`,
    'Error:   × installing dependencies',
    '  ╰─▶ failed to import "/Users/u/.happier/stacks/s/cli/cache/pnpm/store/v11/files/87/',
    '      aec4d76127de0ee5eaead6c6c69b0a9086aea431d1b2f51c7242146228ce9de85453917c',
    '      1ca9a3812f5f2fa05acf665177ce0202adf027b109e7a3713b8960" to "/Users/',
    '      u/repo/node_modules/@expo/ngrok-bin-darwin-arm64_pacquet-stage_1_2_3/',
    '      package.json_pacquet-stage_1_4_5": No such file or directory (os error 2)',
    '',
  ].join('\n');
  await writeFile(installer, `
    if (process.argv.includes('--version')) { console.log('12.14.0'); }
    else { process.stderr.write(${JSON.stringify(pnpm12Stderr)}); process.exitCode = 1; }
  `);
  const options = { installDir: fixture.root, env: { ...process.env,
    npm_execpath: installer, HAPPIER_STACK_ENV_FILE: '', HAPPIER_FIXTURE_TOKEN: secret,
    HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' } };
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  const namesRealCause = error => {
    assert.equal(error.code, 'HAPPIER_DEPENDENCY_REFRESH_FAILED');
    assert.equal(error.pnpmErrorCode, null);
    assert.match(error.message, /installing dependencies: failed to import "\S+\/files\/87\/aec4d761\S+8960" to "\S+\/package\.json_pacquet-stage_1_4_5": No such file or directory \(os error 2\)/u);
    assert.equal(error.message.includes(secret), false, 'the reported cause is redacted');
    return true;
  };
  await assert.rejects(ensureDepsInstalled(fixture.root, 'fixture', {
    env: options.env, quiet: true, prepareComponentOutputs: false,
  }), namesRealCause);
  // The consumer replays the persisted record, not the writer's live error.
  await assert.rejects(withDependencyConsumption(options, () => assert.fail('partial bytes admitted')), namesRealCause);
});

for (const kind of ['pending start', 'running Expo']) test(`refresh retains ${kind} lifecycle ownership and only advises restart`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-refresh-advice-' });
  const options = { installDir: fixture.root, env: { ...process.env,
    HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'),
    HAPPIER_STACK_REPO_DIR: fixture.root, HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' } };
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await mkdir(fixture.path('node_modules'));
  await withDependencyRefresh({ ...options, force: true }, async () => {});
  const base = fixture.path('stacks', 'qa');
  // A running Expo is a real process launched with this Stack's identity.
  const { ownerPid: expoPid } = await startRunningStackOwner(t, base);
  await writeFile(fixture.path('stacks', 'qa', 'env'), `HAPPIER_STACK_REPO_DIR=${fixture.root}\n`);
  const directory = kind === 'pending start'
    ? fixture.path('stacks', 'qa', 'source-runtime') : fixture.path('stacks', 'qa', 'expo-dev', 'app');
  const statePath = kind === 'pending start' ? `${directory}/start.pending.json` : `${directory}/expo.state.json`;
  await mkdir(directory, { recursive: true });
  const state = kind === 'pending start' ? { pid: process.pid, phase: 'preparing' }
    : { pid: expoPid, uiDir: fixture.root, stackName: 'qa' };
  await writeFile(statePath, JSON.stringify(state));
  const before = await readFile(statePath, 'utf8');
  const result = await withDependencyRefresh({ ...options, force: true }, async () => {});
  assert.equal(result.refreshed, true);
  assert.deepEqual(result.stacksNeedingRestart, kind === 'running Expo' ? ['qa'] : []);
  assert.equal(await readFile(statePath, 'utf8'), before, 'the installer never changes lifecycle ownership');
});
