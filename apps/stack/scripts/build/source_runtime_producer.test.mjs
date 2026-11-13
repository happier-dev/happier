import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { mkdir, readFile, writeFile, symlink, chmod, readdir, lstat, rm, utimes } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { installSourceAdmissionFixture, installSourcePreparationInputs } from '../testkit/core/source_runtime_fixture.mjs';
import { markDependencyMutation, withDependencyRefreshLock } from '../utils/proc/dependency_refresh.mjs';
import { watch } from 'node:fs';
import { beginPendingSourceStart } from '../runtime/shared/pending_source_start.mjs';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { parseSourceReloadRefusalLine } from '../runtime/shared/source_reload_refusal.mjs';
import { parseArgs } from '../utils/cli/args.mjs';
import { isDevStartupSourceDrift } from '../utils/dev/devReloadCoordinator.mjs';
import { Writable } from 'node:stream';

test('reload defaults to last-green adoption and preserves an explicit fix boundary', async () => {
  const { resolveSourceRuntimeReloadArguments } = await import('../runtime/launch/prepareSourceRuntimeReload.mjs');
  const requestStartedAt = Date.parse('2026-11-09T12:00:00.000Z');
  const past = '2026-11-09T11:00:00.000Z';
  const future = '2026-11-09T13:00:00.000Z';
  for (const { args, expected } of [
    { args: ['--no-ui'], expected: undefined },
    { args: [`--source-after=${past}`], expected: Date.parse(past) },
    { args: [`--source-after=${future}`], expected: Date.parse(future) },
    { args: ['--allow-older-source'], expected: undefined },
    { args: ['--allow-older-source', `--source-after=${past}`], expected: Date.parse(past) },
  ]) {
    const request = resolveSourceRuntimeReloadArguments({ args, requestStartedAt });
    assert.equal(request.sourceCapturedAfter, expected);
    assert.equal(parseArgs(request.args).kv.get('--source-after'), expected == null ? undefined : new Date(expected).toISOString());
  }
  const controller = resolveSourceRuntimeReloadArguments({ args: ['--no-ui'], requestStartedAt });
  const worker = resolveSourceRuntimeReloadArguments({ args: controller.args, requestStartedAt: Date.parse(future) });
  assert.equal(worker.sourceCapturedAfter, controller.sourceCapturedAfter, 'a later worker clock must preserve the controller boundary');
  const fix = resolveSourceRuntimeReloadArguments({ args: [`--source-after=${past}`], requestStartedAt });
  assert.equal(resolveSourceRuntimeReloadArguments({ args: fix.args, requestStartedAt: Date.parse(future) }).sourceCapturedAfter,
    Date.parse(past), 'an explicit fix boundary also survives dispatch to a later worker');
});

async function writable(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  await chmod(path, info.isDirectory() ? 0o755 : 0o644);
  if (info.isDirectory()) for (const name of await readdir(path)) await writable(join(path, name));
}

async function createProducerFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'source-producer-', registerCleanup: false });
  t.after(async () => { await writable(fixture.root); await fixture.cleanup(); });
  const native = await installSourceAdmissionFixture(fixture.root);
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  const locators = join(cliDir, 'src/plugins/projection/registry/sources');
  await mkdir(locators, { recursive: true });
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await mkdir(join(cliDir, 'node_modules'));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'), 'dir');
  const entry = join(cliDir, 'src/index.ts');
  const compilers = fixture.path('compilers');
  await writeFile(entry, 'export const value = 1;');
  await writeFile(join(locators, 'generatedBundledPluginManifests.ts'), `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(compilers)},process.env.HAPPIER_STACK_STACK+'\\n'); export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];`);
  await installSourcePreparationInputs(repoDir, 'daemon');
  const env = { ...native.env, HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'repo-producer' };
  const stacks = ['qa-one', 'qa-two'].map(name => fixture.path(`stacks/${name}`));
  return { fixture, native, repoDir, cliDir, entry, compilers, env, stacks };
}

test('source runtime results survive child writes to inherited stdout through both build paths', { skip: process.platform !== 'linux' }, async t => {
  for (const producer of [true, false]) await t.test(producer ? 'producer admission' : 'standalone build', async context => {
    const { fixture, native, repoDir, env, stacks } = await createProducerFixture(context);
    const childMarker = fixture.path('stdout-child-ran');
    const child = `process.stdout.write('native-child-output\\n'); require('node:fs').writeFileSync(${JSON.stringify(childMarker)}, 'ran');`;
    // Inject only the OS child boundary into the copied genuine worker. A
    // preload can also run in loader threads, whose fd 1 is not this channel.
    const worker = await readFile(native.runtimePath, 'utf8');
    await writeFile(native.runtimePath, `import { execFileSync } from 'node:child_process';\n` + worker.replace(
      'options = JSON.parse(process.argv[2]);',
      `execFileSync(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'inherit' }); options = JSON.parse(process.argv[2]);`));
    let diagnostics = '';
    const stderrStream = new Writable({ write(chunk, _encoding, done) { diagnostics += chunk; done(); } });
    const built = await native.build({ repoDir, component: 'daemon', env, signal: context.signal, stderrStream,
      ...(producer ? { stackBaseDir: stacks[0] } : { outputDir: fixture.path('standalone-output') }) });
    assert.equal(await readFile(childMarker, 'utf8'), 'ran', 'the real nested child wrote to inherited fd 1');
    assert.match(diagnostics, /native-child-output/, 'inherited child diagnostics reach stderr without corrupting the result');
    assert.equal((await import(pathToFileURL(built.entrypoint))).value, 1);
  });
});

test('QA requests adopt one producer capture across source movement and join an explicit newer request', { skip: process.platform !== 'linux' }, async t => {
  const { native, repoDir, entry, compilers, env, stacks } = await createProducerFixture(t);
  const options = { repoDir, component: 'daemon', env, waitForSourceChanges: false };
  const first = await Promise.all(stacks.map(stackBaseDir => native.build({ ...options, stackBaseDir })));
  assert.equal(first[0].entrypoint, first[1].entrypoint);
  assert.deepEqual((await readFile(compilers, 'utf8')).trim().split('\n'), ['repo-producer'], 'only the repository producer may compile, once for concurrent consumers');
  const unchangedFreshnessRequest = await native.build({ ...options, stackBaseDir: stacks[0], sourceCapturedAfter: Date.now() });
  assert.equal(unchangedFreshnessRequest.entrypoint, first[0].entrypoint,
    'an unchanged authored input identity reuses the completed product across a reload freshness boundary');
  assert.deepEqual((await readFile(compilers, 'utf8')).trim().split('\n'), ['repo-producer'],
    'unchanged daemon reloads launch no additional producer compiler');
  await writeFile(entry, 'export const value = 2;');
  const adopted = await native.build({ ...options, stackBaseDir: stacks[0] });
  assert.equal(adopted.entrypoint, first[0].entrypoint, 'moving authored source does not force QA compilation');
  const sourceCapturedAfter = Date.now();
  const newer = await Promise.all(stacks.map(stackBaseDir => native.build({ ...options, stackBaseDir, sourceCapturedAfter })));
  assert.equal(newer[0].entrypoint, newer[1].entrypoint);
  assert.notEqual(newer[0].entrypoint, first[0].entrypoint);
  assert.ok(Date.parse(newer[0].sourceCapture.capturedAt) >= sourceCapturedAfter);
  assert.equal((await import(pathToFileURL(newer[0].entrypoint))).value, 2);
  assert.deepEqual((await readFile(compilers, 'utf8')).trim().split('\n'), ['repo-producer', 'repo-producer']);
  const publication = newer[0].dependencyPublication;
  // Exercise the installed-tree publication owner, not manifest-only drift.
  await withDependencyRefreshLock({ installDir: repoDir, env }, async () => {
    await markDependencyMutation({ installDir: repoDir, env });
    await mkdir(dirname(publication.markerPath), { recursive: true });
    await writeFile(publication.markerPath, JSON.stringify({ identity: 'changed-installed-dependencies' }));
  });
  const dependencyChanged = await native.build({ ...options, stackBaseDir: stacks[0] });
  assert.notEqual(dependencyChanged.entrypoint, newer[0].entrypoint, 'changed installed dependencies cannot adopt the previous capture');
  assert.deepEqual((await readFile(compilers, 'utf8')).trim().split('\n'), ['repo-producer', 'repo-producer', 'repo-producer']);
  let captureDiagnostics = '';
  const captureStderr = new Writable({ write(chunk, _encoding, done) { captureDiagnostics += chunk; done(); } });
  await assert.rejects(native.build({ ...options, stackBaseDir: stacks[0], sourceCapturedAfter: '2999-01-01T00:00:00.000Z', stderrStream: captureStderr }),
    { code: 'source_runtime_producer_failed', reason: 'source_runtime_producer_capture_unavailable', sourceStack: 'repo-producer', retryable: false });
  const refusals = captureDiagnostics.split('\n').map(line => parseSourceReloadRefusalLine(line)).filter(Boolean);
  assert.ok(refusals.length > 0, 'the real producer child must publish its refusal');
  for (const refusal of refusals) {
    assert.equal(refusal.retryable, false, 'the first child refusal must already be terminal');
    assert.match(refusal.nextAction, /--source-after/);
  }
  assert.equal(JSON.parse(await readFile(join(stacks[0], 'source-runtime/selected-daemon.json'), 'utf8')).entrypoint, dependencyChanged.entrypoint,
    'an unavailable future capture must preserve the incumbent');
  await writeFile(entry, 'this is invalid syntax !');
  await assert.rejects(native.build({ ...options, stackBaseDir: stacks[0], sourceCapturedAfter: Date.now() }), { code: 'source_runtime_producer_failed', sourceStack: 'repo-producer', phase: 'source-producer' });
  assert.equal(JSON.parse(await readFile(join(stacks[0], 'source-runtime/selected-daemon.json'), 'utf8')).entrypoint, dependencyChanged.entrypoint);
});


test('fresh controlled start replaces a retained daemon after dependency refresh', { skip: process.platform !== 'linux' }, async t => {
  const { native, repoDir, cliDir, entry, env, stacks } = await createProducerFixture(t);
  const identityOwner = join(repoDir, 'apps/stack/scripts/build/source_author_inputs.mjs');
  await mkdir(dirname(identityOwner), { recursive: true });
  await symlink(fileURLToPath(new URL('./source_author_inputs.mjs', import.meta.url)), identityOwner);
  const dependency = join(cliDir, 'node_modules/start-input');
  await mkdir(dependency);
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'start-input', main: 'index.cjs' }));
  await writeFile(join(dependency, 'index.cjs'), 'module.exports = 1;');
  await writeFile(entry, 'export { default as value } from "start-input";');
  const options = { repoDir, component: 'daemon', env, stackBaseDir: stacks[0] };
  const first = await native.build(options);
  await withDependencyRefreshLock({ installDir: repoDir, env }, async () => {
    await markDependencyMutation({ installDir: repoDir, env });
    await writeFile(join(dependency, 'index.cjs'), 'module.exports = 2;');
    await mkdir(dirname(first.dependencyPublication.markerPath), { recursive: true });
    await writeFile(first.dependencyPublication.markerPath, JSON.stringify({ identity: 'refreshed-start-input' }));
  });
  // runControlledRemoteStack prepares its controller daemon through this path:
  // startup admission plus a preparation handle, with an explicit fix boundary.
  const replacement = await native.build({ ...options, devStartup: true, preparation: {}, sourceCapturedAfter: Date.now() });
  assert.notEqual(replacement.entrypoint, first.entrypoint);
  assert.equal((await import(pathToFileURL(replacement.entrypoint))).value, 2);
  assert.equal(JSON.parse(await readFile(join(stacks[0], 'source-runtime/selected-daemon.json'), 'utf8')).entrypoint,
    replacement.entrypoint);
});

test('completed adoption bypasses busy producer and fingerprint leases', { skip: process.platform !== 'linux' }, async t => {
  const { native, repoDir, compilers, env, stacks } = await createProducerFixture(t);
  const options = { repoDir, component: 'daemon', env, stackBaseDir: stacks[0], waitForSourceChanges: false };
  const first = await native.build(options);
  const record = JSON.parse(await readFile(resolve(first.runtimeDir, '../../source-bundle.json'), 'utf8'));
  const bundleRoot = join(dirname(stacks[0]), 'source-bundles');
  // Prior development producers wrote these exact three locator fields.
  // The current context locator still proves the successful whole producer.
  let publishedAt = 0;
  for (const name of await readdir(bundleRoot)) {
    if (!name.startsWith('candidate-') || !name.endsWith('.json')) continue;
    const path = join(bundleRoot, name);
    const { outputName, inputIdentity, reuseFingerprint } = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ outputName, inputIdentity, reuseFingerprint }));
    publishedAt = Math.max(publishedAt, (await lstat(path)).mtimeMs);
  }
  const history = join(repoDir, '.project/tmp/load-sentinel/HISTORY.txt');
  await mkdir(dirname(history), { recursive: true });
  const passedAt = new Date(Math.ceil(publishedAt)).toISOString();
  await writeFile(history, `${passedAt} PASS failed=0 passStartedAt~${passedAt} passEndedAt~${passedAt} graphs=5\n`);
  const { sourceBundleBuildLockPath, sourceRuntimeProducerBuildLockPath } = await import(pathToFileURL(native.runtimePath));
  await withWorkspaceBundleLock(() => withWorkspaceBundleLock(async () => {
    const adopted = await native.build({ ...options, requireLastGreen: true, env: { ...env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0' } });
    assert.equal(adopted.entrypoint, first.entrypoint);
    assert.deepEqual((await readFile(compilers, 'utf8')).trim().split('\n'), ['repo-producer'],
      'a completed capture needs no new producer allocation');
  }, { lockPath: sourceBundleBuildLockPath(join(dirname(stacks[0]), 'source-bundles'), record.reuseFingerprint), env, signal: t.signal }),
  { lockPath: sourceRuntimeProducerBuildLockPath(stacks[0]), env, signal: t.signal });
});

test('last-green reload selection uses the post-producer sentinel verdict and retains the incumbent when none passed', { skip: process.platform !== 'linux' }, async t => {
  const { native, repoDir, entry, compilers, env, stacks } = await createProducerFixture(t);
  const { prepareSourceRuntimeProducer } = await import(pathToFileURL(native.runtimePath));
  const options = { repoDir, stackBaseDir: stacks[0], components: [{ component: 'daemon' }], env, signal: t.signal };
  const first = (await prepareSourceRuntimeProducer(options)).daemon;
  await assert.rejects(prepareSourceRuntimeProducer({ ...options, requireLastGreen: true }),
    { code: 'source_runtime_producer_unavailable', reason: 'source_runtime_producer_capture_unavailable' });
  const history = join(repoDir, '.project/tmp/load-sentinel/HISTORY.txt');
  await mkdir(dirname(history), { recursive: true });
  const startedAt = new Date().toISOString();
  await writeFile(history, `${startedAt} PASS failed=0 passStartedAt~${startedAt} passEndedAt~${startedAt} graphs=5\n`);
  await assert.rejects(prepareSourceRuntimeProducer({ ...options, requireLastGreen: true, loadSentinelPasses: [] }),
    { code: 'source_runtime_producer_unavailable', reason: 'source_runtime_producer_capture_unavailable' },
    'an explicitly forwarded empty verdict must not be replaced by a worker-local history');
  await writeFile(entry, 'export const value = 2;');
  const second = (await prepareSourceRuntimeProducer({ ...options, sourceCapturedAfter: Date.now() })).daemon;
  assert.notEqual(second.entrypoint, first.entrypoint);
  const adopted = (await prepareSourceRuntimeProducer({ ...options, requireLastGreen: true })).daemon;
  assert.equal(adopted.entrypoint, first.entrypoint, 'a newer producer completion without its post-capture sentinel PASS cannot replace the last green');
  assert.deepEqual((await readFile(compilers, 'utf8')).trim().split('\n'), ['repo-producer', 'repo-producer']);
  const passedAt = new Date().toISOString();
  await writeFile(history, `${passedAt} PASS failed=0 passStartedAt~${passedAt} passEndedAt~${passedAt} graphs=5\n`, { flag: 'a' });
  const { readLoadSentinelPasses } = await import('../perf/load-sentinel.mjs');
  const loadSentinelPasses = await readLoadSentinelPasses(repoDir);
  await rm(history);
  // Ordinary remote starts invoke --restart, rather than the reload worker.
  const { buildRemoteStackCommand } = await import('../utils/dev_targets/remote_commands.mjs');
  const { resolveSourceRuntimeReloadArguments } = await import('../runtime/launch/prepareSourceRuntimeReload.mjs');
  const command = buildRemoteStackCommand({ name: 'worker', platform: 'posix', ssh: 'worker',
    repoDir: '/remote/repo', cliHomeDir: '/remote/home' }, {
    services: { daemon: true }, serverUrl: 'http://127.0.0.1:43005', stackName: 'qa',
    runtimeMode: 'source-snapshot', env: {}, loadSentinelPasses,
  });
  const transportedValue = /--source-load-sentinel-passes='([^']+)'/.exec(command.replaceAll("'\"'\"'", "'"))?.[1];
  const transported = transportedValue == null ? undefined : `--source-load-sentinel-passes=${transportedValue}`;
  const workerRequest = resolveSourceRuntimeReloadArguments({ args: ['--restart', ...(transported ? [transported] : [])] });
  assert.equal((await prepareSourceRuntimeProducer({ ...options, requireLastGreen: true,
    loadSentinelPasses: workerRequest.loadSentinelPasses })).daemon.entrypoint, second.entrypoint,
    'the worker adopts the newest producer from the forwarded sentinel verdict without a local HISTORY file');
});

test('an explicit daemon-only reload boundary adopts an unchanged capture without compiling', { skip: process.platform !== 'linux' }, async t => {
  const { native, repoDir, compilers, env, stacks } = await createProducerFixture(t);
  const first = await native.build({ repoDir, stackBaseDir: stacks[1], component: 'daemon', env });
  const history = join(repoDir, '.project/tmp/load-sentinel/HISTORY.txt');
  await mkdir(dirname(history), { recursive: true });
  const passedAt = new Date().toISOString();
  await writeFile(history, `${passedAt} PASS failed=0 passStartedAt~${passedAt} passEndedAt~${passedAt} graphs=5\n`);
  const sourceCapturedAfter = Date.now();
  let capture;
  await native.prepareReload({ repoDir, stackName: 'qa-one', stackBaseDir: stacks[0], onHost: true,
    args: ['--no-ui', '--no-server', `--source-after=${new Date(sourceCapturedAfter).toISOString()}`],
    env: { ...env, HAPPIER_STACK_DAEMON: '1', HAPPIER_SERVER_URL: 'http://127.0.0.1:45454' },
    onPrepared({ sourceCaptures }) { capture = sourceCaptures.daemon; } });
  // Identical consumed input identity means identical bytes: the boundary is already satisfied (Systemic 12:43Z ruling).
  assert.equal(capture.capturedAt, first.sourceCapture.capturedAt,
    'an explicit reload boundary adopts the completed capture whose consumed inputs are unchanged');
  assert.equal(JSON.parse(await readFile(join(stacks[0], 'source-runtime/selected-daemon.json'), 'utf8')).entrypoint, first.entrypoint);
  assert.deepEqual((await readFile(compilers, 'utf8')).trim().split('\n'), ['repo-producer'], 'an unchanged daemon reload compiles nothing');
});

test('an explicit-cutoff remote server start prepares without a last-green capture', { skip: process.platform !== 'linux' }, async t => {
  const { native, repoDir, env, stacks } = await createProducerFixture(t);
  const serverDir = join(repoDir, 'apps/server');
  for (const path of ['sources', 'scripts', 'node_modules']) await mkdir(join(serverDir, path), { recursive: true });
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'sources/main.light.ts'), `
    import { createServer } from 'node:http';
    createServer((request,response) => { response.setHeader('content-type','application/json'); response.end(JSON.stringify({status:'ok',service:'happier-server'})); }).listen(Number(process.env.PORT),process.env.HOST);
  `);
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'), 'dir');
  const { buildRemoteStackCommand, resolveRemoteServerRuntimeConfig } = await import('../utils/dev_targets/remote_commands.mjs');
  const sourceCapturedAfter = new Date().toISOString();
  const command = buildRemoteStackCommand({ name: 'fixture', platform: 'posix', repoDir, cliHomeDir: join(stacks[0], 'cli') }, {
    stackName: 'qa-one', runtimeMode: 'source-snapshot', sourceCapturedAfter, sourceUi: 'disabled',
    services: { server: true, daemon: false, expo: false }, remoteServerPort: 45454,
    publicServerUrl: 'http://happier-qa-one.localhost:45454',
    remoteServerRuntimeConfig: resolveRemoteServerRuntimeConfig({ serverComponentName: 'happier-server-light', env: {} }),
    env: { HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'repo-producer' },
  });
  // Read only the preparation flags from the real remote command. The SSH/OS
  // boundary is omitted; no Stack lifecycle is started by this regression.
  const script = execFileSync('/bin/bash', ['-c', `printf '%s' ${command.slice('exec bash -lc '.length)}`], { encoding: 'utf8' });
  const startArgs = script.split(' stack start ')[1].split(';')[0];
  const args = execFileSync('/bin/bash', ['-c', `set -- ${startArgs}; printf '%s\\n' "$@"`], { encoding: 'utf8' }).trim().split('\n');
  let capture;
  await native.prepareReload({ repoDir, stackName: 'qa-one', stackBaseDir: stacks[0], onHost: true, args,
    env: { ...env, HAPPIER_STACK_DAEMON: '0', HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light' },
    onPrepared({ sourceCaptures }) { capture = sourceCaptures.server; } });
  assert.ok(Date.parse(capture.capturedAt) >= Date.parse(sourceCapturedAfter));
});

test('real source reload adopts a coherent producer pair and waits for activation before selection', { skip: process.platform !== 'linux' }, async t => {
  const { native, repoDir, entry, compilers, env, stacks } = await createProducerFixture(t);
  const serverDir = join(repoDir, 'apps/server');
  for (const path of ['sources', 'scripts', 'node_modules']) await mkdir(join(serverDir, path), { recursive: true });
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'sources/main.light.ts'), `
    import { createServer } from 'node:http';
    createServer((request,response) => { response.setHeader('content-type','application/json'); response.end(JSON.stringify({status:'ok',service:'happier-server'})); }).listen(Number(process.env.PORT),process.env.HOST);
  `);
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'), 'dir');
  const { prepareSourceRuntimeProducer } = await import(pathToFileURL(native.runtimePath));
  await prepareSourceRuntimeProducer({ repoDir, stackBaseDir: stacks[1], components: [
    { component: 'server', serverComponent: 'happier-server-light', dbProvider: 'sqlite' }, { component: 'daemon' },
  ], env, sourceCapturedAfter: Date.now(), signal: t.signal });
  const bundleRoot = join(dirname(stacks[0]), 'source-bundles');
  const legacyCompletedAt = Date.now() - 1000;
  let locatorIndex = 0;
  for (const name of (await readdir(bundleRoot)).filter(name => name.startsWith('candidate-'))) {
    const locatorPath = join(bundleRoot, name);
    const { outputName, inputIdentity, reuseFingerprint } = JSON.parse(await readFile(locatorPath, 'utf8'));
    await writeFile(locatorPath, JSON.stringify({ outputName, inputIdentity, reuseFingerprint }));
    const pointerTime = new Date(legacyCompletedAt + locatorIndex++);
    await utimes(locatorPath, pointerTime, pointerTime);
  }
  const history = join(repoDir, '.project/tmp/load-sentinel/HISTORY.txt');
  await mkdir(dirname(history), { recursive: true });
  const passedAt = new Date().toISOString();
  await writeFile(history, `${passedAt} PASS failed=0 passStartedAt~${passedAt} passEndedAt~${passedAt} graphs=5\n`);
  let activate;
  const activation = new Promise(resolve => { activate = resolve; });
  let capture;
  await native.prepareReload({ repoDir, stackName: 'qa-one', stackBaseDir: stacks[0], args: ['--no-ui'], onHost: true,
    env: { ...env, HAPPIER_STACK_DAEMON: '1', HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light' }, activation,
    async onPrepared({ sourceCaptures }) {
      capture = sourceCaptures;
      for (const component of ['server', 'daemon']) await assert.rejects(readFile(join(stacks[0], `source-runtime/selected-${component}.json`)), { code: 'ENOENT' });
      activate(true);
    } });
  assert.equal(capture.server.capturedAt, capture.daemon.capturedAt, 'server and daemon must consume one completed producer capture');
  const records = await Promise.all(['server', 'daemon'].map(async component => {
    const selected = JSON.parse(await readFile(join(stacks[0], `source-runtime/selected-${component}.json`), 'utf8'));
    return JSON.parse(await readFile(resolve(dirname(selected.entrypoint), '../../../source-bundle.json'), 'utf8'));
  }));
  assert.deepEqual(records.map(record => record.sourceCapture.capturedAt), [capture.server.capturedAt, capture.server.capturedAt]);
  assert.deepEqual((await readFile(compilers, 'utf8')).trim().split('\n'), ['repo-producer']);
  const newerUnverifiedPair = await prepareSourceRuntimeProducer({ repoDir, stackBaseDir: stacks[1], components: [
    { component: 'server', serverComponent: 'happier-server-light', dbProvider: 'sqlite' }, { component: 'daemon' },
  ], env, sourceCapturedAfter: Date.now(), signal: t.signal });
  for (const component of ['server', 'daemon']) assert.equal(newerUnverifiedPair[component].sourceCapture.capturedAt, capture[component].capturedAt,
    `a paired boundary request adopts the unchanged ${component} capture`);
  assert.deepEqual((await readFile(compilers, 'utf8')).trim().split('\n'), ['repo-producer'], 'an unchanged pair compiles nothing');
  await native.prepareReload({ repoDir, stackName: 'qa-one', stackBaseDir: stacks[0], args: ['--no-ui'], onHost: true,
    env: { ...env, HAPPIER_STACK_DAEMON: '1', HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light' },
    onPrepared({ sourceCaptures }) {
      for (const component of ['server', 'daemon']) assert.equal(sourceCaptures[component].capturedAt, capture[component].capturedAt,
        'a newer unverified pair with unchanged inputs must retain the prior coherent green pair');
    } });
  const reloadRequestedAt = Date.now();
  await writeFile(entry, 'export const value = 2;');
  await native.prepareReload({ repoDir, stackName: 'qa-one', stackBaseDir: stacks[0], args: ['--no-ui'], onHost: true,
    env: { ...env, HAPPIER_STACK_DAEMON: '1', HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light' },
    onPrepared({ sourceCaptures }) {
      for (const component of ['server', 'daemon']) assert.equal(sourceCaptures[component].capturedAt, capture[component].capturedAt,
        `plain reload adopts the last-green ${component} capture across authored source movement`);
    } });
  assert.deepEqual((await readFile(compilers, 'utf8')).trim().split('\n'), ['repo-producer']);
  await native.prepareReload({ repoDir, stackName: 'qa-one', stackBaseDir: stacks[0],
    args: ['--no-ui', `--source-after=${new Date(reloadRequestedAt).toISOString()}`], onHost: true,
    env: { ...env, HAPPIER_STACK_DAEMON: '1', HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light' } });
  const daemonSelection = JSON.parse(await readFile(join(stacks[0], 'source-runtime/selected-daemon.json'), 'utf8'));
  assert.equal((await import(pathToFileURL(daemonSelection.entrypoint))).value, 2);
  const completed = JSON.parse(await readFile(resolve(dirname(daemonSelection.entrypoint), '../../../source-bundle.json'), 'utf8'));
  const compilerCount = (await readFile(compilers, 'utf8')).trim().split('\n').length;
  await writeFile(entry, 'export const value = 3;');
  await native.prepareReload({ repoDir, stackName: 'qa-one', stackBaseDir: stacks[0],
    args: ['--no-ui', '--no-dev-targets', `--source-after=${completed.sourceCapture.capturedAt}`],
    env: { ...env, HAPPIER_STACK_DAEMON: '1', HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light' } });
  assert.equal((await readFile(compilers, 'utf8')).trim().split('\n').length, compilerCount,
    'an explicit fix time adopts the finished producer pair with zero compiler work');
  assert.equal(JSON.parse(await readFile(join(stacks[0], 'source-runtime/selected-daemon.json'), 'utf8')).entrypoint,
    daemonSelection.entrypoint, 'fast adoption keeps the eligible finished capture');
  const selectedBeforeFailure = await Promise.all(['server', 'daemon'].map(component =>
    readFile(join(stacks[0], `source-runtime/selected-${component}.json`), 'utf8')));
  await writeFile(entry, 'this is invalid syntax !');
  await assert.rejects(native.prepareReload({ repoDir, stackName: 'qa-one', stackBaseDir: stacks[0],
    args: ['--no-ui', `--source-after=${new Date().toISOString()}`], onHost: true,
    env: { ...env, HAPPIER_STACK_DAEMON: '1', HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light' } }),
  { code: 'source_runtime_producer_failed', sourceStack: 'repo-producer' });
  assert.deepEqual(await Promise.all(['server', 'daemon'].map(component =>
    readFile(join(stacks[0], `source-runtime/selected-${component}.json`), 'utf8'))), selectedBeforeFailure);
});

test('a cold source CLI bootstrap adopts a selection activated during its producer request', { skip: process.platform !== 'linux' }, async t => {
  const command = await createProducerFixture(t);
  const startup = await createProducerFixture(t);
  const stackBaseDir = command.stacks[0];
  const pending = await beginPendingSourceStart({ stackBaseDir });
  t.after(() => pending.dispose());
  const prepared = await startup.native.build({ repoDir: startup.repoDir, stackBaseDir, component: 'daemon',
    env: command.env, pending });
  const { admitSourceRuntimeReload } = await import(pathToFileURL(command.native.runtimePath));
  const admission = await admitSourceRuntimeReload({ stackBaseDir, components: { daemon: prepared }, pending, env: command.env });
  const started = command.fixture.path('started');
  const release = command.fixture.path('release');
  const watcher = watch(command.fixture.root);
  t.after(() => watcher.close());
  const active = new Promise((resolve, reject) => {
    watcher.on('error', reject);
    watcher.on('change', (_event, name) => { if (name === 'started') resolve(); });
  });
  await writeFile(join(command.cliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'),
    `import {writeFileSync,existsSync} from 'node:fs'; writeFileSync(${JSON.stringify(started)},'ready'); while(!existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,10)); export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];`);
  const controller = new AbortController();
  const request = command.native.build({ repoDir: command.repoDir, stackBaseDir, component: 'daemon', env: command.env,
    reuseSelected: 'if-available', signal: AbortSignal.any([controller.signal, t.signal]) });
  const completion = request.then(built => ({ built }), error => ({ error }));
  t.after(async () => { controller.abort(); await completion; });
  await active;
  await admission.activate();
  await writeFile(release, 'release');
  const outcome = await completion;
  if (outcome.error) throw outcome.error;
  assert.equal(outcome.built.entrypoint, prepared.entrypoint);
  assert.equal(JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/selected-daemon.json'), 'utf8')).entrypoint, prepared.entrypoint);
});

test('a queued component worker from before the producer cutover translates to the canonical producer', { skip: process.platform !== 'linux' }, async t => {
  const { native, repoDir, compilers, env, stacks } = await createProducerFixture(t);
  const { runWorkspaceBuildAdmission } = await import(new URL('../utils/proc/workspace_build_admission.mjs', pathToFileURL(native.runtimePath)));
  const { sourceBundleBuildLockPath, sourceRuntimeProducerBuildLockPath } = await import(pathToFileURL(native.runtimePath));
  const fingerprint = 'queued-before-producer-cutover';
  const invoke = () => runWorkspaceBuildAdmission({ repoDir,
    launcherPath: resolve(dirname(native.runtimePath), '../../bin/hstack-exec'), command: process.execPath,
    args: [native.runtimePath, JSON.stringify({ repoDir, stackBaseDir: stacks[0], component: 'daemon', fingerprint })],
    locks: [{ path: sourceBundleBuildLockPath(join(dirname(stacks[0]), 'source-bundles'), fingerprint), kind: 'workspace', timeoutMs: null }],
    cwd: repoDir, env: { ...env, HAPPIER_STACK_STACK: 'qa-one' }, devStartup: true,
    signal: t.signal, admissionClass: 'source-bundle', stdio: ['ignore', 'pipe', 'pipe'],
    onStderr: chunk => process.stderr.write(chunk) });
  await withWorkspaceBundleLock(async () => {
    const refused = await invoke();
    assert.equal(refused.status, 1);
    const refusal = refused.stderr.split('\n').map(line => parseSourceReloadRefusalLine(line, env)).find(Boolean);
    assert.equal(refusal.code, 'source_runtime_producer_failed',
      'inherited fingerprint custody must settle instead of waiting for a busy producer lock');
    assert.equal(refusal.sourceStack, 'repo-producer');
    assert.equal(isDevStartupSourceDrift({ code: refused.status, message: refused.stderr }, 'daemon'), false,
      'a legacy parent must surface producer contention instead of waiting for a source edit');
    await assert.rejects(readFile(compilers), { code: 'ENOENT' });
  }, { lockPath: sourceRuntimeProducerBuildLockPath(stacks[0]), env, signal: t.signal });
  const result = await invoke();
  assert.equal(result.status, 0, result.stderr);
  const built = JSON.parse(result.stdout);
  assert.equal((await import(pathToFileURL(built.entrypoint))).value, 1, 'the old single-component response shape remains loadable');
  assert.deepEqual((await readFile(compilers, 'utf8')).trim().split('\n'), ['repo-producer']);
  assert.equal(JSON.parse(await readFile(join(stacks[0], 'source-runtime/selected-daemon.json'), 'utf8')).entrypoint, built.entrypoint);
});

// RELOAD-RETRY-1110: the real producer reads captured bytes while the author fixes live source.
test('producer JSON entry keeps in-process console diagnostics off stdout', { skip: process.platform !== 'linux' }, async t => {
  const { fixture, native, repoDir, env } = await createProducerFixture(t);
  const diagnostic = '[local] refreshing fixture dependencies';
  const preload = fixture.path('diagnostic.mjs');
  // An OS process exit listener supplies an in-process writer without replacing
  // any producer logic or requiring a mutation of the shared dependency tree.
  await writeFile(preload, `if (process.argv[1] === ${JSON.stringify(native.runtimePath)}) process.on('exit', () => console.log(${JSON.stringify(diagnostic)}));`);
  const stdout = await native.runSourceCommand({ repoDir, scriptPath: native.runtimePath,
    args: [JSON.stringify({ repoDir, outputDir: fixture.path('output'), component: 'daemon', resultPath: fixture.path('worker-result.json') })],
    env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}` }, captureStderr: true });
  assert.equal(stdout, '', 'worker stdout is diagnostic-only and empty for console diagnostics');
  const built = JSON.parse(await readFile(fixture.path('worker-result.json'), 'utf8'));
  assert.equal((await import(pathToFileURL(built.entrypoint))).value, 1);
});

for (const mode of ['fixed', 'old', 'still-broken']) {
  test(`producer capture retry: ${mode}`, { skip: process.platform !== 'linux' }, async t => {
    const { native, repoDir, cliDir, entry, compilers, env, stacks } = await createProducerFixture(t);
    await writeFile(entry, 'this is invalid syntax !');
    const locator = join(cliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
    const repair = mode === 'old' ? '' : `writeFileSync(${JSON.stringify(entry)}, ${JSON.stringify(mode === 'fixed' ? 'export const value = 42;' : 'this is invalid syntax !')});`;
    await writeFile(locator, `import {appendFileSync, writeFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(compilers)}, 'attempt\\n'); ${repair} export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];`);
    let diagnostics = '';
    const stderrStream = new Writable({ write(chunk, _encoding, done) { diagnostics += chunk; done(); } });
    const options = { repoDir, component: 'daemon', env, stackBaseDir: stacks[0], waitForSourceChanges: false, stderrStream };
    if (mode === 'fixed') {
      const built = await native.build(options);
      assert.equal((await import(pathToFileURL(built.entrypoint))).value, 42);
    } else {
      await assert.rejects(native.build(options), { code: 'source_runtime_producer_failed' });
    }
    assert.equal((diagnostics.match(/phase=input-capture /g) ?? []).length, mode === 'old' ? 1 : 2,
      'only a post-capture edit permits exactly one new producer capture');
    assert.equal((diagnostics.match(/\[source-capture\] retry file="apps\/cli\/src\/index.ts" capturedAt=\S+ fileMtime=\S+/g) ?? []).length,
      mode === 'old' ? 0 : 1, 'one retry diagnostic names the failing source and both timestamps');
  });
}

test('recovering dependency drift does not publish a refusal before the producer settles', { skip: process.platform !== 'linux' }, async t => {
  const { fixture, native, repoDir, entry, env, stacks } = await createProducerFixture(t);
  const { resolveDependencyRefreshLockPath } = await import('../utils/proc/dependency_refresh.mjs');
  const generationPath = `${resolveDependencyRefreshLockPath(repoDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  await writeFile(generationPath, JSON.stringify({ generation: 'initial', completedGeneration: 'initial' }));
  const witness = fixture.path('drift-once');
  await writeFile(entry, `import {existsSync,writeFileSync} from 'node:fs';
    if (!existsSync(${JSON.stringify(witness)})) {
      writeFileSync(${JSON.stringify(witness)}, 'drifted');
      writeFileSync(${JSON.stringify(generationPath)}, JSON.stringify({generation:'new',completedGeneration:'new'}));
    }
    export const value = 42;`);
  let diagnostics = '';
  const stderrStream = new Writable({ write(chunk, _encoding, done) { diagnostics += chunk; done(); } });
  const built = await native.build({ repoDir, component: 'daemon', env, stackBaseDir: stacks[0], stderrStream });
  assert.equal((await import(pathToFileURL(built.entrypoint))).value, 42);
  assert.doesNotMatch(diagnostics, /^HSTACK_SOURCE_RELOAD_REFUSAL=/m,
    'a worker with a trailing pass available cannot publish a terminal reload refusal');
});
