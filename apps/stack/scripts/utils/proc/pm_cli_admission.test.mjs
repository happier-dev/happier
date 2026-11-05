import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, watch } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withWorkspaceBundleLock } from '../../../../../scripts/workspaces/workspaceBundleLock.mjs';
import { buildNativeAdmissionFixtureEnv, holdNativeAdmissionFixtureMemory, installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { spawnTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { readHappyCliRuntimeInputFreshness } from './cli_runtime_inputs.mjs';

test('Stack CLI readiness jointly admits its complete locked publication transaction', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-pm-cli-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps/cli');
  const lockPath = join(root, '.project/tmp/cli-dist-build.lock');
  await Promise.all(['apps/cli', 'apps/ui', 'apps/server', 'node_modules', '.project/tmp'].map(path => mkdir(join(root, path), { recursive: true })));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@12.14.0' }));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  for (const name of ['cli', 'ui', 'server']) await writeFile(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`, packageManager: 'pnpm@12.14.0' }));
  const native = await installNativeAdmissionFixture({ root });
  const { admissionRoot } = native;
  const memoryPath = join(root, 'memory');
  const observedPath = join(root, 'compiler-boundary.json');
  await writeFile(memoryPath, '1 73400320\n');
  const pressure = await holdNativeAdmissionFixtureMemory(t, native, { totalKiB: 73400320, availableKiB: 1 });
  assert.equal((await native.brokerStatus()).activeCount, 1);
  writeFakeBin({ root, name: 'awk', content: '#!/bin/sh\ncase "$*" in */proc/meminfo*) /usr/bin/awk \'{print $1, $2}\' "$FIXTURE_MEMORY" ;; *) exec /usr/bin/awk "$@" ;; esac\n' });
  writeFakeBin({ root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  writeFakeBin({ root, name: 'sleep', content: '#!/bin/sh\nexec /bin/sleep 0.02\n' });
  // The package manager is the genuine external build boundary. Its failure
  // must retain the public readiness error while releasing the joint lease.
  writeFakeBin({ root, name: 'pnpm', content: `#!${process.execPath}
import { mkdirSync, writeFileSync } from 'node:fs';
if (process.argv.includes('install')) {
  mkdirSync('node_modules', { recursive: true });
  writeFileSync('node_modules/.modules.yaml', 'layoutVersion: 5\\nnodeLinker: hoisted\\npackageManager: pnpm@12.14.0\\n');
  process.exit(0);
}
if (process.argv.includes('--version')) console.log('12.14.0');
else if (process.argv.includes('build:prepared')) {
  const { requestAdmissionSample } = await import(${JSON.stringify(pathToFileURL(native.admissionClientPath).href)});
  writeFileSync(process.env.FIXTURE_OBSERVED, JSON.stringify({ admitted: (await requestAdmissionSample(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT)).activeCount === 1,
    leases: JSON.parse(process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES || '[]'), held: process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD }));
  console.error('fixture CLI compiler diagnostic'); process.exitCode = 7;
}
` });
  const loader = join(root, 'os-loader.mjs');
  await writeFile(loader, `export async function resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/proc/pm.mjs') && specifier === './workspace_build_admission.mjs')
      return { url: ${JSON.stringify(pathToFileURL(join(root, 'native-owner/apps/stack/scripts/utils/proc/workspace_build_admission.mjs')).href)}, shortCircuit: true };
    return next(specifier, context);
  }`);
  const api = join(root, 'api.mjs');
  await writeFile(api, `import { ensureCliBuilt } from ${JSON.stringify(new URL('./pm.mjs', import.meta.url).href)};
    try { await ensureCliBuilt(${JSON.stringify(cliDir)}, { buildCli: true, quiet: true }); }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code, exitCode: error.exitCode, signal: error.signal, diagnostic: error.message.includes('fixture CLI compiler diagnostic'), message: error.message })); process.exitCode = error.exitCode ?? 1; }`);
  let release, entered;
  const ready = new Promise(resolveReady => { entered = resolveReady; });
  const holder = withWorkspaceBundleLock(async () => { entered(); await new Promise(resolveRelease => { release = resolveRelease; }); }, { lockPath });
  await ready;
  const env = {
    ...buildNativeAdmissionFixtureEnv(), PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, NODE_OPTIONS: `--experimental-loader=${loader}`,
    FIXTURE_MEMORY: memoryPath, FIXTURE_OBSERVED: observedPath, CI: '', HAPPIER_DEV_TARGET_EXECUTION: '1',
    HAPPIER_STACK_CLI_BUILD_MODE: 'always', HAPPIER_STACK_ENV_FILE: '', HAPPIER_STACK_PM_CACHE_BASE_DIR: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '',
  };
  const child = spawnTestProcess(process.execPath, [api], { cwd: cliDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolveExit => child.once('close', (status, signal) => resolveExit({ status, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM'); await exited; });
  const waitFor = condition => new Promise((resolveReady, reject) => {
    let checking = false;
    const cleanup = () => { watchers.forEach(watcher => watcher.close()); child.stderr.off('data', check); child.off('close', failed); };
    const failed = () => { cleanup(); reject(new Error(`Readiness exited before expected admission state: ${stdout}\n${stderr}`)); };
    const check = async () => { if (checking) return; checking = true; try { if (await condition()) { cleanup(); resolveReady(); } } catch (error) { cleanup(); reject(error); } finally { checking = false; } };
    const watchers = [dirname(lockPath), admissionRoot].map(path => watch(path, check));
    child.stderr.on('data', check); child.once('close', failed); void check();
  });
  try {
    await waitFor(async () => (await native.brokerStatus()).waitingCount === 1);
    assert.equal(existsSync(`${lockPath}.priority-claim`), false,
      'an unreserved joint-admission waiter must not retain a publication claim');
    const blocked = await native.brokerStatus();
    assert.equal(blocked.waitingCount, 1, 'B wait belongs to unreserved joint producer, not a parent publication lock');
    assert.equal(blocked.activeCount, 1, 'only the pressure holder is admitted');
    release(); await holder;
    await waitFor(async () => (await native.brokerStatus()).waitingCount === 1);
    assert.equal(existsSync(lockPath), false, 'capacity waiter must release B');
    assert.equal(existsSync(observedPath), false);
    await pressure.release(() => withWorkspaceBundleLock(() => writeFile(memoryPath, '31457280 73400320\n'), { lockPath }));
    assert.deepEqual(await exited, { status: 7, signal: null }, stderr);
  const { message, ...failure } = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.deepEqual(failure, { code: 'EEXIT', exitCode: 7, signal: null, diagnostic: true });
    assert.match(message, /fixture CLI compiler diagnostic/);
    const observed = JSON.parse(await readFile(observedPath, 'utf8'));
    assert.equal(observed.admitted, true, 'the compiler runs under its real admitted broker slot');
    assert.ok(observed.leases.some(value => JSON.parse(value).path === lockPath));
    assert.equal(existsSync(lockPath), false);
    const finished = await native.brokerStatus();
    assert.equal(finished.activeCount, 0);
    assert.equal(finished.waitingCount, 0);
    // Reusing a valid warm CLI is metadata-only and must stay usable even
    // while this physical worker cannot admit a compiler envelope.
    await mkdir(join(cliDir, 'dist'), { recursive: true });
    const entrypoint = join(cliDir, 'dist/index.mjs');
    await writeFile(entrypoint, 'export const warm = true;\n');
    const { writeCliDistBuildManifest } = createRequire(import.meta.url)('../../../../../packages/cli-common/cliDistBuildManifest.cjs');
    writeCliDistBuildManifest(entrypoint, { inputFingerprint: (await readHappyCliRuntimeInputFreshness(cliDir)).fingerprint });
    await writeFile(memoryPath, '1 73400320\n');
    const warmApi = join(root, 'warm-api.mjs');
    await writeFile(warmApi, `import { ensureCliBuilt } from ${JSON.stringify(new URL('./pm.mjs', import.meta.url).href)};
      process.stdout.write(JSON.stringify(await ensureCliBuilt(${JSON.stringify(cliDir)}, { buildCli: true, quiet: true })));`);
    const warm = spawnTestProcess(process.execPath, [warmApi], { cwd: cliDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, HAPPIER_STACK_CLI_BUILD_MODE: 'auto' } });
    let warmOut = '', warmErr = '';
    warm.stdout.on('data', chunk => { warmOut += chunk; }); warm.stderr.on('data', chunk => { warmErr += chunk; });
    const warmExited = new Promise(resolveExit => warm.once('close', (status, signal) => resolveExit({ status, signal })));
    t.after(async () => { if (warm.exitCode === null && warm.signalCode === null) process.kill(-warm.pid, 'SIGTERM'); await warmExited; });
    assert.deepEqual(await warmExited, { status: 0, signal: null }, warmErr);
    assert.deepEqual(JSON.parse(warmOut), { built: false, current: true, reason: 'up_to_date' });
    const warmFinished = await native.brokerStatus();
    assert.equal(warmFinished.activeCount, 0);
    assert.equal(warmFinished.waitingCount, 0);
  } finally { release(); await holder; }
});
