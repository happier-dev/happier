import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { resolvePnpmCommandInvocation } from '../../../../../scripts/workspaces/execPnpmCommand.mjs';
import { resolveCliEntrypoint } from '../../runtime/launch/resolveCliEntrypoint.mjs';
import { assertDependenciesReady, inspectDependencyRefresh, resolveDependencyRefreshLockPath,
  resolveDependencyRefreshMarkerPath, waitForDependencyRefresh, withDependencyConsumption,
  withDependencyRefresh } from './dependency_refresh.mjs';

const execFileAsync = promisify(execFile);

test('remote consumers recover reverted inputs after a failed partial installation', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-remote-reverted-install-' });
  const { packageManager } = JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8'));
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_DEV_TARGET_EXECUTION: '1',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0',
    npm_execpath: fixture.path('installer-boundary.cjs') };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  const options = { installDir: fixture.root, env, signal: t.signal };
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, packageManager }));
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages: []\n');
  const inputA = '# successful input A\n';
  await writeFile(fixture.path('pnpm-lock.yaml'), inputA);
  await withDependencyRefresh(options, () => writeFile(fixture.path('node_modules', 'installed'), 'A'));
  const admitted = await readFile(resolveDependencyRefreshMarkerPath(fixture.root), 'utf8');
  // Only the package-manager process is replaced; publication, inspection,
  // failure recording, exclusion and recovery all run through the real owner.
  await writeFile(env.npm_execpath, `
    const fs = require('node:fs');
    if (process.argv[2] !== 'install') process.exit(0);
    if (!fs.existsSync(${JSON.stringify(resolveDependencyRefreshLockPath(fixture.root, env))})) process.exit(91);
    fs.appendFileSync('recovery-installs', 'installed\\n');
    fs.writeFileSync('node_modules/installed', 'A');
  `);
  await writeFile(fixture.path('recovery-installs'), '');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# failed input B\n');
  await assert.rejects(withDependencyRefresh(options, async () => {
    await writeFile(fixture.path('node_modules', 'installed'), 'partial B');
    throw Object.assign(new Error('fixture installer failed'), { code: 'ERR_PNPM_FETCH_503' });
  }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  await assert.rejects(waitForDependencyRefresh(options), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  assert.equal(await readFile(fixture.path('recovery-installs'), 'utf8'), '', 'unchanged failed inputs are not retried');
  assert.equal(await readFile(resolveDependencyRefreshMarkerPath(fixture.root), 'utf8'), admitted);
  await writeFile(fixture.path('pnpm-lock.yaml'), inputA);
  const reverted = await inspectDependencyRefresh(options);
  assert.equal(reverted.required, true);
  assert.equal(reverted.installedIdentity, reverted.installIdentity);
  assert.notEqual(reverted.failedInstallIdentity, reverted.installIdentity);
  const readRecovered = async () => assert.equal(await readFile(fixture.path('node_modules', 'installed'), 'utf8'), 'A');
  await Promise.all([
    waitForDependencyRefresh(options).then(readRecovered),
    withDependencyConsumption(options, readRecovered),
  ]);
  assert.equal(await readFile(fixture.path('recovery-installs'), 'utf8'), 'installed\n', 'concurrent recovery shares one installation');
  assert.equal((await inspectDependencyRefresh(options)).required, false);
  await assertDependenciesReady(options);
});

async function setup(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-remote-self-install-' });
  const { packageManager } = JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8'));
  const env = { ...process.env, CI: '', NODE_ENV: 'development', HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_DEV_TARGET_EXECUTION: '1',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  const options = { installDir: fixture.root, env, signal: t.signal };
  await mkdir(fixture.path('node_modules'));
  for (const name of ['cli', 'ui', 'server']) {
    await mkdir(fixture.path('apps', name), { recursive: true });
    await writeFile(fixture.path('apps', name, 'package.json'), '{}');
  }
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, packageManager,
    scripts: { install: 'node installed.cjs' } }));
  // Real pnpm runs this fixture lifecycle. It records effects only when the
  // real refresh writer holds custody; internal readiness/locking stay real.
  await writeFile(fixture.path('installed.cjs'), `
    const fs = require('node:fs');
    if (!fs.existsSync(${JSON.stringify(resolveDependencyRefreshLockPath(fixture.root, env))})) process.exit(91);
    fs.appendFileSync('installs', 'installed\\n');
    fs.writeFileSync('installed-lockfile', fs.readFileSync('pnpm-lock.yaml'));
  `);
  // Observe the real package-manager boundary, including failed attempts that
  // never reach lifecycle scripts. The wrapper forwards to real pinned pnpm.
  env.npm_execpath = fixture.path('pnpm-boundary.cjs');
  await writeFile(env.npm_execpath, `
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const args = process.argv.slice(2);
    if (args[0] === 'install') fs.appendFileSync('attempts', 'attempt\\n');
    (async () => {
      const { resolvePnpmCommandInvocation } = await import(${JSON.stringify(new URL('../../../../../scripts/workspaces/execPnpmCommand.mjs', import.meta.url).href)});
      const invocation = resolvePnpmCommandInvocation(args, { preferPath: true });
      const child = spawnSync(invocation.command, invocation.args, { stdio: 'inherit',
        windowsVerbatimArguments: invocation.windowsVerbatimArguments });
      if (child.error) throw child.error;
      process.exit(child.status ?? 1);
    })().catch(() => { process.exitCode = 1; });
  `);
  await writeFile(fixture.path('attempts'), '');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages: []\nautoInstallPeers: true\n');
  const pnpm = async args => {
    const invocation = resolvePnpmCommandInvocation(args, { preferPath: true });
    return await execFileAsync(invocation.command, invocation.args, { cwd: fixture.root, env,
      signal: t.signal, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
  };
  await pnpm(['install', '--lockfile-only', '--ignore-scripts', '--offline']);
  await withDependencyRefresh(options, () => pnpm(['install', '--frozen-lockfile', '--offline']));
  await writeFile(fixture.path('installs'), '');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages: []\nautoInstallPeers: false\n');
  // Simulate the controller's complete input publication, never a remote relock.
  await pnpm(['install', '--lockfile-only', '--ignore-scripts', '--offline']);
  const syncedLockfile = await readFile(fixture.path('pnpm-lock.yaml'), 'utf8');
  return { fixture, options, syncedLockfile };
}

test('stale remote consumers share one frozen installation before reading the synced tree', async t => {
  const { fixture, options, syncedLockfile } = await setup(t);
  const cliDir = fixture.path('apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(fixture.path('packages/cli-common'), { recursive: true });
  await mkdir(fixture.path('node_modules/tsx/dist/esm'), { recursive: true });
  await writeFile(join(cliDir, 'src/index.ts'), 'export {};\n');
  await writeFile(fixture.path('packages/cli-common/registerSourceRuntime.mjs'), '');
  await writeFile(fixture.path('node_modules/tsx/package.json'), '{"name":"tsx","version":"0.0.0"}\n');
  await writeFile(fixture.path('node_modules/tsx/dist/esm/index.mjs'), '');
  const readInstalled = async () => {
    assert.equal(await readFile(fixture.path('installed-lockfile'), 'utf8'), syncedLockfile);
    return 'consumed';
  };
  const results = await Promise.all([
    withDependencyConsumption(options, readInstalled),
    withDependencyConsumption(options, readInstalled),
    waitForDependencyRefresh(options).then(readInstalled),
    resolveCliEntrypoint({ cliDir, preferSource: true, env: options.env, signal: t.signal }),
  ]);
  assert.equal(results[3].kind, 'tsx');
  assert.equal(await readFile(fixture.path('installs'), 'utf8'), 'installed\n', 'one install per host/input change');
  assert.equal(await readFile(fixture.path('attempts'), 'utf8'), 'attempt\n');
  assert.equal(await readFile(fixture.path('pnpm-lock.yaml'), 'utf8'), syncedLockfile, 'remote preserves controller bytes');
  await withDependencyConsumption(options, readInstalled);
  assert.equal(await readFile(fixture.path('installs'), 'utf8'), 'installed\n', 'warm consumption never reinstalls');
  assert.equal((await inspectDependencyRefresh(options)).required, false);
  await assertDependenciesReady(options);
});

test('inconsistent synced remote inputs fail closed without relock, publication, or consumer retries', async t => {
  const { fixture, options, syncedLockfile } = await setup(t);
  const markerPath = resolveDependencyRefreshMarkerPath(fixture.root);
  const admitted = await readFile(markerPath, 'utf8');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages: []\nautoInstallPeers: true\n');
  const rejectsMismatch = error => error.code === 'HAPPIER_DEPENDENCY_REFRESH_FAILED'
    && error.pnpmErrorCode === 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH';
  const consumers = await Promise.allSettled([
    withDependencyConsumption(options, () => assert.fail('inconsistent tree consumed')),
    withDependencyConsumption(options, () => assert.fail('inconsistent tree consumed')),
    waitForDependencyRefresh(options),
  ]);
  for (const result of consumers) {
    assert.equal(result.status, 'rejected');
    assert.equal(rejectsMismatch(result.reason), true);
  }
  assert.equal(await readFile(fixture.path('attempts'), 'utf8'), 'attempt\n', 'concurrent consumers share the failed frozen attempt');
  const publicationPath = `${resolveDependencyRefreshLockPath(fixture.root, options.env)}.generation`;
  const failure = await readFile(publicationPath, 'utf8');
  await assert.rejects(waitForDependencyRefresh(options), rejectsMismatch);
  await assert.rejects(assertDependenciesReady(options), rejectsMismatch);
  assert.equal(await readFile(publicationPath, 'utf8'), failure, 'later consumers report the failed attempt without reinstalling');
  assert.equal(await readFile(fixture.path('installs'), 'utf8'), '', 'frozen validation precedes lifecycle effects');
  assert.equal(await readFile(fixture.path('pnpm-lock.yaml'), 'utf8'), syncedLockfile);
  assert.equal(await readFile(markerPath, 'utf8'), admitted, 'failed inputs never replace the prior admission');
  // The next controller publication corrects the mismatch. Import consumers
  // must recover too, even though the previous failed attempt is unpublished.
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages: []\nautoInstallPeers: false\n');
  assert.equal(await withDependencyConsumption(options, () => 'recovered'), 'recovered');
  assert.equal(await readFile(fixture.path('installs'), 'utf8'), 'installed\n');
  assert.equal(await readFile(fixture.path('attempts'), 'utf8'), 'attempt\nattempt\n', 'new inputs permit one new installation');
  assert.equal((await inspectDependencyRefresh(options)).required, false);
});

test('local and refresh-disabled consumers keep explicit dependency preparation', async t => {
  const { fixture, options } = await setup(t);
  for (const overrides of [{ HAPPIER_DEV_TARGET_EXECUTION: '' }, { HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' }]) {
    const scoped = { ...options, env: { ...options.env, ...overrides } };
    await waitForDependencyRefresh(scoped);
    await withDependencyConsumption(scoped, () => 'existing consumption policy');
    await assert.rejects(assertDependenciesReady(scoped), { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
  }
  assert.equal(await readFile(fixture.path('installs'), 'utf8'), '', 'no implicit local or disabled install');
});
