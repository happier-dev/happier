// @happier-test-preparation source
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv, installCliNativeCustodySourceFixture, installNativeAdmissionFixture, installWorkspaceAdmissionProcessFixture, rustToolchainFakeBins } from '../../testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { collectWorkspaceBuildBatchResources, ensureWorkspacePackagesBuiltForComponent } from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { withWorkspaceBundleLock } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from '../../../../../scripts/workspaces/workspacePackageBuildLock.mjs';
import { resolveTypeScriptCliInvocation } from '../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { prepareWorkspaceTypecheckDeclarations } from '../../../../../scripts/workspaces/prepareReferencedTypecheckDeclarations.mjs';
import { runWorkspaceBuildAdmission } from '../proc/workspace_build_admission.mjs';
import { runAdmissionCommand } from '../proc/admission_client.mjs';
import { resolveHeavyweightMemoryFloorKiB, resolveRemoteCommandPolicy } from './remote_commands.mjs';

import { prepareRemoteValidationWorkspace } from './remote_validation_preparation.mjs';
import { resolveCliBundledWorkspacePackageNames } from '../../../../cli/scripts/buildSharedDeps.mjs';
import { resolveDependencyRefreshLockPath, withDependencyRefresh } from '../proc/dependency_refresh.mjs';

const declarationFixtureBuild = `node ${JSON.stringify(fileURLToPath(new URL('../../../../../scripts/workspaces/buildTypeScriptPackageDist.mjs', import.meta.url)))} -p tsconfig.json`;

async function assertNativeAdmissionIdle(native) {
  const status = await native.brokerStatus();
  assert.equal(status.activeCount, 0);
  assert.equal(status.waitingCount, 0);
}

function readOutputPublicationIdentity(paths) {
  return paths.map(path => {
    const { ino, mtimeMs, ctimeMs, size } = statSync(path);
    return { ino, mtimeMs, ctimeMs, size };
  });
}

test('UI source preparation launches zero unadmitted esbuild producers', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-prep-admission-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const generator = fixture.path('apps/ui/tools/atmosphere/buildAtmosphereRenderers.mjs');
  const result = fixture.path('source-build-admission.json');
  mkdirSync(join(generator, '..'), { recursive: true });
  // The generator module is the external source compiler boundary. Keep the
  // real preparation, admission, reservation and subprocess owners underneath.
  writeFileSync(generator, `import { writeFileSync } from 'node:fs';
export async function buildAtmosphereRenderers(options) {
  if (process.env.HSTACK_SOURCE_PREPARATION_FIXTURE !== 'admitted'
    || process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT !== ${JSON.stringify(native.admissionRoot)}
    || !process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT) {
    throw Object.assign(new Error('Source compiler launched outside admission'), { code: 'UNADMITTED_SOURCE_COMPILATION' });
  }
  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ web: options.web, admitted: true }));
}
`);
  await prepareRemoteValidationWorkspace({ repoDir: fixture.root, componentRelativeDir: 'apps/ui',
    validationKind: 'source-test', env: { ...native.env, HSTACK_SOURCE_PREPARATION_FIXTURE: 'admitted' } });
  assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), { web: false, admitted: true });
  await assertNativeAdmissionIdle(native);
});

for (const entryLoads of [false, true]) test(`${entryLoads ? 'entry-load' : 'source reload'} preparation rebuilds stale package output once and publishes a capture before later edits`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-reload-stale-protocol-' });
  const root = fixture.root;
  for (const app of ['cli', 'ui', 'server', 'stack']) {
    mkdirSync(fixture.path('apps', app), { recursive: true });
    writeFileSync(fixture.path('apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
      ...((entryLoads ? app === 'cli' : app === 'stack') ? { dependencies: { '@happier-dev/protocol': 'workspace:*' } } : {}) }));
  }
  const packageManager = JSON.parse(readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8')).packageManager;
  writeFileSync(fixture.path('package.json'), JSON.stringify({ private: true, packageManager }));
  writeFileSync(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  if (entryLoads) {
    mkdirSync(fixture.path('packages/sdk'), { recursive: true });
    writeFileSync(fixture.path('packages/sdk/package.json'), JSON.stringify({ name: '@fixture/sdk' }));
    mkdirSync(fixture.path('apps/ui/scripts'), { recursive: true });
    writeFileSync(fixture.path('apps/ui/scripts/generateBundledPluginUiArtifacts.mjs'),
      'export async function generateBundledPluginUiArtifacts() {}');
  }
  const pkg = fixture.path('packages/protocol');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module',
    main: './dist/index.js', scripts: { build: 'node compile.mjs' } }));
  const source = join(pkg, 'src/index.ts');
  const output = join(pkg, 'dist/index.js');
  const countPath = fixture.path('compiler-count');
  writeFileSync(source, 'export const value = "published";');
  // Substitute only the external compiler process. Capture, fingerprints,
  // package publication and remote preparation all use their real owners.
  writeFileSync(join(pkg, 'compile.mjs'), `import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const countPath = process.env.HAPPIER_TEST_COMPILER_COUNT;
writeFileSync(countPath, String(Number(existsSync(countPath) ? readFileSync(countPath, 'utf8') : 0) + 1));
const output = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
mkdirSync(output, { recursive: true });
const captured = readFileSync('src/index.ts', 'utf8');
if (process.env.HAPPIER_TEST_LATER_SOURCE) writeFileSync(${JSON.stringify(source)}, 'export const value = "after-capture";');
writeFileSync(join(output, 'index.js'), captured);
`);
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  const env = { ...native.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1',
    HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_TEST_COMPILER_COUNT: countPath };
  await ensureWorkspacePackagesBuiltForComponent(fixture.path(entryLoads ? 'apps/cli' : 'apps/stack'), { env, quiet: true });
  assert.equal(readFileSync(countPath, 'utf8'), '1');
  const command = entryLoads ? ['node', './apps/stack/scripts/perf/entry-load.mjs']
    : ['node', './apps/stack/scripts/runtime/launch/prepareSourceRuntimeReload.mjs', '--worker', '{}'];
  const policy = resolveRemoteCommandPolicy(command, { cwd: root, repoRoot: root, env });
  const prepare = () => prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir: policy.component,
    validationKind: policy.kind, preparationScope: policy.preparationScope, defaultBuildMode: policy.preparationBuildMode, env });

  writeFileSync(source, `${entryLoads ? 'export const REQUESTER_SESSION_RUNTIME_REFUSAL_PREVIEWS = []; ' : ''}export const value = "synced-fix";`);
  await prepare();
  assert.match(readFileSync(output, 'utf8'), /"synced-fix"/,
    'the real reload policy must prepare the new package before the worker can import its dist');
  assert.equal(readFileSync(countPath, 'utf8'), '2', 'one demand compiles the changed package once');
  if (entryLoads) {
    const consumer = fixture.path('daemon-import.mjs');
    writeFileSync(consumer, 'export { REQUESTER_SESSION_RUNTIME_REFUSAL_PREVIEWS } from "./packages/protocol/dist/index.js";');
    assert.deepEqual((await import(pathToFileURL(consumer).href)).REQUESTER_SESSION_RUNTIME_REFUSAL_PREVIEWS, [],
      'a newly added Protocol export loads after entry preparation without a manual dist build');
  }
  await prepare();
  assert.equal(readFileSync(countPath, 'utf8'), '2', 'unchanged reload preparation performs zero compiler work');

  writeFileSync(source, 'export const value = "captured";');
  env.HAPPIER_TEST_LATER_SOURCE = '1';
  await prepare();
  assert.match(readFileSync(output, 'utf8'), /"captured"/);
  assert.equal(readFileSync(countPath, 'utf8'), '3', 'later source edits do not discard the completed capture');
  delete env.HAPPIER_TEST_LATER_SOURCE;
  await prepare();
  assert.match(readFileSync(output, 'utf8'), /"after-capture"/);
  assert.equal(readFileSync(countPath, 'utf8'), '4', 'the next demand rebuilds the later source once');
  await prepare();
  assert.equal(readFileSync(countPath, 'utf8'), '4');
});

test('explicit typecheck batch prepares strict producers once before its same-worker readers', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'happier-typecheck-batch-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  for (const name of ['ui', 'cli', 'server']) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}`,
      dependencies: { '@fixture/producer': 'workspace:*' } }));
  }
  const producer = join(root, 'packages/producer');
  mkdirSync(join(producer, 'src'), { recursive: true });
  writeFileSync(join(producer, 'package.json'), JSON.stringify({ name: '@fixture/producer', type: 'module',
    main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'node compile.mjs' } }));
  const source = join(producer, 'src/index.ts');
  writeFileSync(source, 'export const value = 1;\n');
  const builds = join(root, 'builds');
  writeFileSync(join(producer, 'compile.mjs'), `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
if (process.env.HAPPIER_WORKSPACE_BUILD_MODE !== 'strict') throw new Error('batch producer must be checked');
mkdirSync(out, { recursive: true });
writeFileSync(out + '/index.js', readFileSync('src/index.ts'));
writeFileSync(out + '/index.d.ts', 'export declare const value: number;');
appendFileSync(${JSON.stringify(builds)}, 'build\\n');`);
  const reads = join(root, 'reads');
  const reader = join(root, 'reader.mjs');
  writeFileSync(reader, `import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { requestAdmissionSample } from ${JSON.stringify(pathToFileURL(native.admissionClientPath).href)};
import { withWorkspaceBundleLock } from ${JSON.stringify(new URL('../../../../../packages/cli-common/workspaceBundleLock.mjs', import.meta.url).href)};
const output = readFileSync(${JSON.stringify(join(producer, 'dist/index.js'))}, 'utf8');
assert.equal(output, readFileSync(${JSON.stringify(source)}, 'utf8'));
assert.equal((await requestAdmissionSample(${JSON.stringify(native.admissionRoot)})).activeCount, 1);
await withWorkspaceBundleLock(() => {}, {
  lockPath: ${JSON.stringify(resolveWorkspacePackageBuildLockPath(producer, { name: '@fixture/producer' }))},
  env: {}, wait: false,
});
appendFileSync(${JSON.stringify(reads)}, output);`);
  const batch = () => prepareRemoteValidationWorkspace({ repoDir: root, validationKind: 'typecheck',
    componentRelativeDirs: ['apps/cli', 'apps/ui', 'apps/server'],
    batchReader: { command: process.execPath, args: [reader], cwd: root },
    env: { ...native.env, HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev', HAPPIER_STACK_REPO_DIR: root,
      HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root } });
  await assert.rejects(prepareRemoteValidationWorkspace({ repoDir: root, validationKind: 'typecheck',
    componentRelativeDirs: ['apps/cli', 'apps/missing'],
    batchReader: { command: process.execPath, args: [reader], cwd: root }, env: native.env }),
  { message: 'Workspace build batch components must belong to one monorepo' });
  assert.equal(existsSync(builds), false, 'an invalid batch cannot partially publish before rejection');
  assert.equal(existsSync(reads), false, 'an invalid batch cannot run its reader');
  await batch();
  assert.equal(existsSync(reads), true, 'the batch must run its reader after producer publication');
  const coldBuilds = readFileSync(builds, 'utf8');
  await batch();
  assert.equal(readFileSync(builds, 'utf8'), coldBuilds, 'an unchanged second batch must compile nothing');
  writeFileSync(source, 'export const value = 2;\n');
  await batch();
  assert.equal(readFileSync(builds, 'utf8'), `${coldBuilds}build\n`);
  assert.equal(readFileSync(reads, 'utf8'), 'export const value = 1;\nexport const value = 1;\nexport const value = 2;\n');
  await assertNativeAdmissionIdle(native);

  // The process preload changes the source graph only after the real native
  // owner has acquired the first batch's resources. This is an OS boundary,
  // while graph collection, custody, unwind and retry remain real.
  const changeGraph = join(root, 'change-graph.mjs');
  const changed = join(root, 'graph-changed');
  mkdirSync(join(root, 'packages/late'), { recursive: true });
  writeFileSync(join(root, 'packages/late/package.json'), JSON.stringify({ name: '@fixture/late' }));
  writeFileSync(changeGraph, `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv[2] === '--typecheck-batch-worker' && !existsSync(${JSON.stringify(changed)})) {
  const file = ${JSON.stringify(join(root, 'apps/cli/package.json'))};
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, '@fixture/late': 'workspace:*' } }));
  writeFileSync(${JSON.stringify(changed)}, 'changed');
}`);
  // A copied output still needs the publisher's verification pass even when
  // its bytes match. This reaches the queued worker without changing content.
  const publishedOutput = join(producer, 'dist/index.js');
  writeFileSync(publishedOutput, readFileSync(publishedOutput));
  await prepareRemoteValidationWorkspace({ repoDir: root, validationKind: 'typecheck',
    componentRelativeDirs: ['apps/cli', 'apps/ui', 'apps/server'],
    batchReader: { command: process.execPath, args: [reader], cwd: root },
    env: { ...native.env, NODE_OPTIONS: `${native.env.NODE_OPTIONS} --import=${pathToFileURL(changeGraph).href}`,
      HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root } });
  assert.equal(existsSync(changed), true, 'graph drift must be exercised beneath admitted producer custody');
  assert.equal(readFileSync(reads, 'utf8'), 'export const value = 1;\nexport const value = 1;\nexport const value = 2;\nexport const value = 2;\n',
    'a changed graph must unwind and admit its new resources before running the reader exactly once');
  await assertNativeAdmissionIdle(native);

  const beforeFailure = readFileSync(reads, 'utf8');
  const compilePath = join(producer, 'compile.mjs');
  const compiler = readFileSync(compilePath, 'utf8');
  writeFileSync(compilePath, `${compiler}\nthrow new Error('fixture producer rejected its input');\n`);
  writeFileSync(source, 'export const value = 3;\n');
  await assert.rejects(batch, error => {
    assert.equal(error.message, 'Typecheck preparation batch failed');
    assert.equal(error.exitCode, 1);
    assert.equal(error.cause.code, 'EEXIT', 'the original producer failure reason survives the batch worker');
    return true;
  });
  assert.equal(readFileSync(reads, 'utf8'), beforeFailure, 'producer failure must not start a reader');
  assert.equal(readFileSync(join(producer, 'dist/index.js'), 'utf8'), 'export const value = 2;\n',
    'producer failure must retain the last coherent publication');
  await assertNativeAdmissionIdle(native);
  writeFileSync(compilePath, compiler);
  await batch();
  assert.equal(readFileSync(reads, 'utf8'), `${beforeFailure}export const value = 3;\n`);

  await t.test('cancelling an admitted producer releases every resource before settling', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const connected = once(server, 'connection');
    const originalSource = readFileSync(source);
    const beforeReads = readFileSync(reads, 'utf8');
    writeFileSync(source, `${originalSource}\n`);
    // Hold only the compiler OS process, beneath the real batch/native owners.
    writeFileSync(compilePath, `import {connect} from 'node:net';
const socket=connect(${server.address().port},'127.0.0.1',()=>socket.write('compiling'));
socket.on('data',()=>{});
`);
    const cancellation = new AbortController();
    const pending = prepareRemoteValidationWorkspace({ repoDir: root, validationKind: 'typecheck',
      componentRelativeDirs: ['apps/cli', 'apps/ui', 'apps/server'],
      batchReader: { command: process.execPath, args: [reader], cwd: root },
      env: { ...native.env, HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root },
      signal: cancellation.signal });
    void pending.catch(() => {});
    let socket;
    try {
      [socket] = await Promise.race([connected, pending.then(() => { throw new Error('producer exited before compiling'); })]);
      await once(socket, 'data');
      cancellation.abort();
      await assert.rejects(pending, { name: 'AbortError' });
      assert.equal(readFileSync(reads, 'utf8'), beforeReads, 'a cancelled producer must never start its reader');
      assert.equal(readFileSync(join(producer, 'dist/index.js'), 'utf8'), originalSource.toString());
      await assertNativeAdmissionIdle(native);
    } finally {
      cancellation.abort();
      socket?.destroy();
      await pending.catch(() => {});
      await new Promise(resolve => server.close(resolve));
      writeFileSync(source, originalSource);
      writeFileSync(compilePath, compiler);
    }
  });

  await t.test('a live watcher retains no publication locks and an independent publisher proceeds', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    const watching = once(server, 'connection');
    const watchReader = join(root, 'watch-reader.mjs');
    writeFileSync(watchReader, `import { watch } from 'node:fs';
import { connect } from 'node:net';
const watcher = watch(${JSON.stringify(source)}, () => {});
const socket = connect(${port}, '127.0.0.1', () => socket.write('watching'));
socket.on('end', () => watcher.close());
socket.on('error', error => { watcher.close(); throw error; });`);
    const pending = prepareRemoteValidationWorkspace({ repoDir: root, validationKind: 'typecheck',
      componentRelativeDirs: ['apps/cli', 'apps/ui', 'apps/server'],
      batchReader: { command: process.execPath, args: [watchReader, '--watch'], cwd: root },
      env: { ...native.env, HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root } });
    let socket;
    try {
      [socket] = await Promise.race([watching, pending.then(() => { throw new Error('watcher exited before starting'); })]);
      await once(socket, 'data');
      for (const lockPath of [join(root, '.project/tmp/cli-dist-build.lock'),
        resolveWorkspacePackageBuildLockPath(producer, { name: '@fixture/producer' })]) {
        await withWorkspaceBundleLock(() => {}, { lockPath, env: {}, wait: false });
      }
      assert.equal(readFileSync(builds, 'utf8'), `${coldBuilds}build\nbuild\nbuild\n`,
        'starting the unchanged watcher must not rebuild any producer');
    } finally {
      socket?.end();
      await pending.finally(() => server.close());
    }
    await assertNativeAdmissionIdle(native);
  });

  const beforeReaderFailure = readFileSync(builds, 'utf8');
  await assert.rejects(prepareRemoteValidationWorkspace({ repoDir: root, validationKind: 'typecheck',
    componentRelativeDirs: ['apps/cli', 'apps/ui', 'apps/server'],
    batchReader: { command: process.execPath, args: ['-e', 'process.exit(7)'], cwd: root },
    env: { ...native.env, HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root } }),
  { exitCode: 7 });
  assert.equal(readFileSync(builds, 'utf8'), beforeReaderFailure,
    'a reader failure must not rebuild or retry producer preparation');
  await assertNativeAdmissionIdle(native);

  await t.test('a reader-bearing producer request is rejected before publication', async () => {
    // A queued controller can outlive a source update. It must not mistake
    // producer-only success for execution of the reader it still delegates.
    writeFileSync(source, 'export const value = 4;\n');
    const components = ['cli', 'ui', 'server'].map(name => join(root, 'apps', name));
    const resources = await collectWorkspaceBuildBatchResources(components, { env: native.env });
    const resultPath = join(root, 'rejected-reader-result.json');
    const before = readFileSync(builds, 'utf8');
    const result = await runWorkspaceBuildAdmission({
      command: process.execPath,
      args: [fileURLToPath(new URL('./remote_validation_preparation.mjs', import.meta.url)),
        '--typecheck-batch-worker', JSON.stringify({ repoDir: root, components,
          identity: resources.identity, readerAdmissionClass: 'compilation', resultPath,
          reader: { command: process.execPath, args: [reader], cwd: root } })],
      locks: resources.locks, admissionClass: resources.admissionClass, cwd: root,
      env: { ...native.env, HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root },
    });
    assert.notEqual(result.status, 0, 'a producer worker must reject a delegated reader');
    assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).code, 'HSTACK_TYPECHECK_PRODUCER_READER_FORBIDDEN');
    assert.equal(readFileSync(builds, 'utf8'), before, 'invalid worker requests must not publish');
    assert.equal(readFileSync(join(producer, 'dist/index.js'), 'utf8'), 'export const value = 3;\n');
    await batch();
    assert.equal(readFileSync(builds, 'utf8'), `${before}build\n`, 'a current controller explicitly retries once');
    assert.equal(readFileSync(join(producer, 'dist/index.js'), 'utf8'), 'export const value = 4;\n');
    await assertNativeAdmissionIdle(native);
  });

  await t.test('a queued legacy producer request keeps strict defaults without delegating a reader', async () => {
    writeFileSync(source, 'export const value = 5;\n');
    const components = ['cli', 'ui', 'server'].map(name => join(root, 'apps', name));
    const resources = await collectWorkspaceBuildBatchResources(components, { env: native.env });
    const resultPath = join(root, 'legacy-producer-result.json');
    const beforeReads = readFileSync(reads, 'utf8');
    const result = await runWorkspaceBuildAdmission({
      command: process.execPath,
      args: [fileURLToPath(new URL('./remote_validation_preparation.mjs', import.meta.url)),
        '--typecheck-batch-worker', JSON.stringify({ repoDir: root, components,
          identity: resources.identity, readerAdmissionClass: 'compilation', resultPath })],
      locks: resources.locks, admissionClass: resources.admissionClass, cwd: root,
      env: { ...native.env, HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev',
        HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root },
    });
    assert.equal(result.status, 0, 'legacy requests must still publish through the strict compiler boundary');
    assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')).result.built, ['@fixture/producer']);
    assert.equal(readFileSync(join(producer, 'dist/index.js'), 'utf8'), 'export const value = 5;\n');
    assert.equal(readFileSync(reads, 'utf8'), beforeReads, 'a finite legacy producer cannot run a reader');
    await assertNativeAdmissionIdle(native);
  });
});

test('CLI source preparation stages admitted native custody without package-dist capacity or a build-time publication lease', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-cli-source-native-preparation-' });
  const native = await installNativeAdmissionFixture({ root });
  const repoDir = join(root, 'native-owner');
  const source = await installCliNativeCustodySourceFixture(repoDir);
  const cliDir = join(repoDir, 'apps/cli');
  mkdirSync(join(cliDir, 'native/processcustody'), { recursive: true });
  const nativeSource = join(cliDir, 'native/processcustody/main.go');
  writeFileSync(nativeSource, 'native-custody');
  writeFileSync(join(repoDir, 'package.json'), '{"private":true}');
  writeFileSync(join(repoDir, 'pnpm-lock.yaml'), '# source fixture');
  writeFileSync(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  const buildRecord = join(root, 'native-build');
  const goEnvProbe = `if [ "$1" = env ] && [ "$2" = -json ]; then
  printf '%s\\n' '{"GOVERSION":"go1.25.0","GOFLAGS":"","GOEXPERIMENT":"","GOAMD64":"","GOARM":"","GOARM64":""}'
  exit 0
fi`;
  // Go and physical capacity are OS boundaries. The real source setup,
  // native admission, authenticated lease and staging owner remain live.
  writeFakeBin({ root, name: 'go', content: `#!/bin/sh
${goEnvProbe}
[ -n "$HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT" ] || exit 91
if [ -e '${join(repoDir, '.project/tmp/cli-dist-build.lock')}' ]; then
  '${process.execPath}' --input-type=module --eval 'import { readFileSync } from "node:fs";
if (JSON.parse(readFileSync(${JSON.stringify(join(repoDir, '.project/tmp/cli-dist-build.lock'))}, "utf8")).pid !== ${process.pid}) process.exit(92);'
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then shift; output=$1; fi
  shift
done
cat '${nativeSource}' > "$output"
printf 'compiled\\n' >> '${buildRecord}'
` });
  // This real admission path fits the measured native class, but cannot
  // admit the unrelated six-GiB package-dist envelope.
  writeFakeBin({ root, name: 'awk', content: '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "4194304 4194304\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n' });
  writeFakeBin({ root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const cargoBuilds = join(root, 'cargo-builds');
  const { cargo, rustup } = rustToolchainFakeBins();
  writeFakeBin({ root, name: 'rustup', content: rustup });
  writeFakeBin({ root, name: 'cargo', content: cargo + `printf '%s\\n' "$target" >> '${cargoBuilds}'\n` });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    HAPPIER_EXEC_CONFIG_PATH: '', HAPPIER_DEV_TARGET_EXECUTION: '1' };
  const preparation = { repoDir, componentRelativeDir: 'apps/cli', validationKind: 'source-test',
    requiredTools: 'go', preparationScope: 'host-native' };
  const prepare = (requiredTools = 'go') => prepareRemoteValidationWorkspace({ ...preparation, requiredTools, env });

  await prepare('');
  assert.throws(() => readFileSync(buildRecord), { code: 'ENOENT' },
    'projection-only source checks do not acquire a new native prerequisite');

  await prepare();
  assert.deepEqual(new Set(readFileSync(source.tracePath, 'utf8').trim().split('\n').map(value => JSON.parse(value))),
    new Set([source.runtimeTarget, source.setupTarget].map(value => pathToFileURL(value).href)),
    'the selected checkout owns both the source loader and native staging implementation');
  assert.equal(readFileSync(join(cliDir, 'tools/unpacked/happier-process-custody'), 'utf8'), 'native-custody');
  assert.throws(() => readFileSync(join(repoDir, '.project/tmp/cli-dist-build.lock')), { code: 'ENOENT' });
  assert.throws(() => readFileSync(join(cliDir, 'dist/index.mjs')), { code: 'ENOENT' });
  // Mutagen may replace inputs after the public preparation returns, while the test waits.
  const holderSourceDir = join(repoDir, 'packages/iroh-native/rust/happier-session-holder/src');
  mkdirSync(holderSourceDir, { recursive: true });
  const holderSource = join(holderSourceDir, 'main.rs');
  const setupFailure = join(root, 'setup-failure');
  const check = `import { writeFileSync } from 'node:fs';
    await import(${JSON.stringify(pathToFileURL(source.runtimeTarget).href)});
    const { setup } = await import(${JSON.stringify(pathToFileURL(source.setupTarget).href)});
    try {
      await setup({ buildMode: 'none', dependencies: { resolveProjectRoot: () => ${JSON.stringify(cliDir)} } });
    } catch (error) {
      writeFileSync(${JSON.stringify(setupFailure)}, error.message);
      throw error;
    }`;
  const runFocused = signal => runAdmissionCommand({
    root: native.admissionRoot, repoDir, env, className: 'focused-validation-cli',
    floorKiB: 2 * 1024 * 1024, machine: 'fixture', validationPreparation: preparation,
    command: process.execPath, args: ['--input-type=module', '--eval', check], signal,
  });
  const countCargoBuilds = () => readFileSync(cargoBuilds, 'utf8').trim().split('\n').length;

  await t.test('readmission refreshes changed Rust inputs once and subsequent tests reuse the holder', async t => {
    const before = countCargoBuilds();
    writeFileSync(holderSource, 'fn main() {}\n');
    assert.equal(await runFocused(t.signal), 0, 'source setup sees the current holder after admission');
    assert.equal(await runFocused(t.signal), 0);
    assert.equal(countCargoBuilds(), before + 1);
  });

  await t.test('a second source change reaches the original setup error without another recovery', async t => {
    const before = countCargoBuilds();
    writeFileSync(holderSource, 'fn main() {} // before admission\n');
    const write = process.stderr.write;
    let readmissions = 0;
    t.mock.method(process.stderr, 'write', function (chunk, ...args) {
      const line = String(chunk);
      if (line.includes('session-holder linux-') && line.includes('rebuilt')) {
        // Publication has completed by the time its diagnostic reaches this stream.
        writeFileSync(holderSource, 'fn main() {} // after publication\n');
      }
      if (line.includes('readmitting validation')) readmissions += 1;
      return write.call(this, chunk, ...args);
    });
    assert.equal(await runFocused(t.signal), 1);
    assert.match(readFileSync(setupFailure, 'utf8'), /CLI source tests require public native preparation/);
    assert.equal(readmissions, 1);
    assert.equal(countCargoBuilds(), before + 1);
  });

  writeFileSync(nativeSource, 'native-custody-current-source');
  await prepare();
  assert.equal(readFileSync(join(cliDir, 'tools/unpacked/happier-process-custody'), 'utf8'), 'native-custody-current-source',
    'an existing binary is not proof that the public preparation consumed current Go source');
  assert.equal(readFileSync(buildRecord, 'utf8'), 'compiled\ncompiled\n');
  assert.throws(() => readFileSync(join(repoDir, '.project/tmp/cli-dist-build.lock')), { code: 'ENOENT' });

  // A prior test may still be executing the published helper. Replacing its
  // path must preserve that process and publish complete new bytes atomically.
  writeFileSync(nativeSource, readFileSync('/bin/sleep'));
  await prepare();
  const executable = join(cliDir, 'tools/unpacked/happier-process-custody');
  const incumbent = spawn(executable, ['60'], { stdio: 'ignore' });
  const closed = once(incumbent, 'close');
  await once(incumbent, 'spawn');
  try {
    await prepare();
    assert.equal(incumbent.exitCode, null, 'publication must not retire an executing helper');
    assert.deepEqual(readFileSync(executable), readFileSync('/bin/sleep'));
  } finally {
    incumbent.kill('SIGTERM');
    await closed;
  }

  await t.test('a finite live publisher releases one waiting preparation without refusal or rebuild', { timeout: 30_000 }, async t => {
    const acquired = Promise.withResolvers();
    const release = Promise.withResolvers();
    const lockPath = join(repoDir, '.project/tmp/cli-dist-build.lock');
    const waiting = Promise.withResolvers();
    mkdirSync(join(repoDir, '.project/tmp'), { recursive: true });
    const watcher = watch(join(repoDir, '.project/tmp'), () => {
      if (existsSync(`${lockPath}.priority-claim`)) waiting.resolve();
    });
    const holder = withWorkspaceBundleLock(async () => {
      acquired.resolve();
      await release.promise;
    }, { lockPath });
    let preparation;
    t.after(async () => {
      watcher.close();
      release.resolve();
      await holder;
      await preparation?.catch(() => {});
    });
    await acquired.promise;
    const previousPayload = readFileSync(executable);
    const previousBuilds = readFileSync(buildRecord, 'utf8');
    writeFileSync(nativeSource, 'native-custody-after-wait');
    preparation = prepare();
    await Promise.race([waiting.promise, preparation.then(() => assert.fail('preparation must wait for publication'))]);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid,
      'a waiter preserves the live publication holder');
    assert.deepEqual(readFileSync(executable), previousPayload,
      'waiting preserves the existing native helper');
    assert.equal(readFileSync(buildRecord, 'utf8'), `${previousBuilds}compiled\n`,
      'native compilation completes once before publication waiting');
    release.resolve();
    await holder;
    await preparation;
    assert.equal(readFileSync(executable, 'utf8'), 'native-custody-after-wait');
    assert.equal(readFileSync(buildRecord, 'utf8'), `${previousBuilds}compiled\n`,
      'publication resumes the same prepared payload without retrying the native build');
    assert.equal(existsSync(`${lockPath}.priority-claim`), false);
  });
  writeFileSync(nativeSource, 'native-custody-after-release');
  await prepare();
  assert.equal(readFileSync(executable, 'utf8'), 'native-custody-after-release',
    'an explicit later preparation succeeds after the publication holder releases');

  await t.test('a failed Go preparation preserves a redacted typed cause at the refusal sink', async () => {
    const priorPayload = readFileSync(executable);
    const sensitiveValue = 'native-preparation-fixture-sensitive-value';
    env.HAPPIER_TEST_SECRET = sensitiveValue;
    writeFileSync(nativeSource, 'native-custody-rejected-source');
    writeFakeBin({ root, name: 'go', content: `#!/bin/sh
${goEnvProbe}
printf '%s\\n' 'compile: native input rejected' "$HAPPIER_TEST_SECRET" >&2
exit 23
` });
    await assert.rejects(prepare(), error => {
      assert.equal(error.code, 'HSTACK_CLI_NATIVE_CUSTODY_PREPARATION_FAILED');
      assert.equal(error.phase, 'native-custody-preparation');
      assert.equal(error.retryable, false);
      assert.equal(error.cause?.phase, 'native-custody-preparation');
      assert.equal(error.cause?.step, 'go-build');
      assert.equal(error.cause?.exitCode, 23);
      assert.equal(error.cause?.signal, null);
      assert.ok(error.cause?.errorLines.includes('compile: native input rejected'));
      assert.ok(!JSON.stringify(error).includes(sensitiveValue));
      return true;
    });
    assert.deepEqual(readFileSync(executable), priorPayload,
      'a failed preparation preserves the previously published helper');
  });
});

test('typecheck consumers share current canonical declarations through the package publisher without redirects', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-typecheck-current-declarations-' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters: {}\n");
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  const metadata = { name: '@happier-dev/protocol', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
    exports: { '.': { 'happier-source': './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' },
      './*': { types: './dist/*.d.ts', default: './dist/*.js' } },
    scripts: { build: declarationFixtureBuild } };
  const dependency = join(root, 'packages/protocol');
  mkdirSync(join(dependency, 'src'), { recursive: true });
  writeFileSync(join(dependency, 'package.json'), JSON.stringify(metadata));
  writeFileSync(join(dependency, 'src/index.ts'), 'export type { PromptModalityV1 } from "./widget.js"; export { value } from "./widget.js";\n');
  const widget = value => `export type PromptModalityV1 = "voice" | "text"; export type PromptPlanV1 = Readonly<{ modality: PromptModalityV1 }>; export function makePlan(): PromptPlanV1 { return { modality: "voice" }; } export const value = ${JSON.stringify(value)};\n`;
  writeFileSync(join(dependency, 'src/widget.tsx'), widget('current'));
  writeFileSync(join(dependency, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, types: [], target: 'es2022', module: 'esnext', moduleResolution: 'bundler',
    jsx: 'react-jsx', declaration: true, rootDir: 'src', outDir: 'dist',
  }, files: ['src/index.ts'] }));
  mkdirSync(join(dependency, 'dist'), { recursive: true });
  writeFileSync(join(dependency, 'dist/index.d.ts'), 'export declare const value: "stale";\n');
  writeFileSync(join(dependency, 'dist/index.js'), 'export const value = "stale";\n');
  const env = { CI: 'true', PATH: process.env.PATH, HAPPIER_STACK_REPO_DIR: root,
    HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root };
  for (const component of ['cli', 'ui', 'server']) {
    const dir = join(root, 'apps', component);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${component}`,
      dependencies: { '@happier-dev/protocol': 'workspace:*' } }));
  }
  const extra = join(root, 'packages/extra');
  mkdirSync(join(root, 'node_modules/@happier-dev'), { recursive: true });
  mkdirSync(join(root, 'node_modules/@fixture'), { recursive: true });
  symlinkSync(dependency, join(root, 'node_modules/@happier-dev/protocol'), 'junction');
  symlinkSync(extra, join(root, 'node_modules/@fixture/extra'), 'junction');
  mkdirSync(join(extra, 'src'), { recursive: true });
  writeFileSync(join(extra, 'package.json'), JSON.stringify({ name: '@fixture/extra', type: 'module', types: './dist/index.d.ts', scripts: { build: declarationFixtureBuild },
    dependencies: { '@happier-dev/protocol': 'workspace:*' } }));
  writeFileSync(join(extra, 'src/index.ts'), 'import { makePlan } from "@happier-dev/protocol/widget"; export function extra() { return makePlan(); }');
  writeFileSync(join(extra, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    declaration: true, rootDir: 'src', outDir: 'dist', types: [], module: 'esnext', moduleResolution: 'bundler',
  }, include: ['src/**/*.ts'] }));
  writeFileSync(join(root, 'apps/ui/package.json'), JSON.stringify({ name: '@fixture/ui',
    dependencies: { '@happier-dev/protocol': 'workspace:*', '@fixture/extra': 'workspace:*' } }));
  const source = join(dependency, 'src/widget.tsx');
  const consumer = join(root, 'apps/server');
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, types: [], module: 'esnext', moduleResolution: 'bundler',
    paths: { '@happier-dev/protocol': [join(dependency, 'dist/index.d.ts')] },
  }, files: ['consumer.ts'] }));
  const args = ['--noEmit', '-p', join(consumer, 'tsconfig.json'), '--pretty', 'false'];
  // Both compilation directions use the real compiler and retain strictness.
  const compiler = resolveTypeScriptCliInvocation({ args, workspaceDir: consumer, env: { CI: 'true' }, invocationKind: 'build' });
  const check = () => spawnSync(compiler.command, [...compiler.argsPrefix, ...args], { cwd: consumer, encoding: 'utf8' });
  let emissions = 0;
  const prepare = async component => {
    const prepared = await prepareWorkspaceTypecheckDeclarations(join(root, 'apps', component), { env });
    assert.equal(prepared.ok, true);
    emissions += prepared.declarations.filter(name => name === '@happier-dev/protocol').length;
    const result = check();
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  for (const [index, component] of ['cli', 'ui', 'server'].entries()) {
    const value = `moving-${component}`;
    writeFileSync(source, widget(value));
    writeFileSync(join(consumer, 'consumer.ts'), `import { value } from "@happier-dev/protocol"; const current: ${JSON.stringify(value)} = value;`);
    const stale = check();
    assert.equal(stale.status, 2, stale.stderr);
    assert.match(stale.stdout, /TS2322/);
    await Promise.all([prepare(component), prepare(component)]);
    assert.equal(emissions, index + 1, 'concurrent consumers share one declaration emission per changed input');
    const skipped = await prepareRemoteValidationWorkspace({ repoDir: root,
      componentRelativeDir: `apps/${component}`, validationKind: 'typecheck', env,
      loadWorkspaceBuildOwner: async () => { throw new Error('typecheck must never enter package-dist preparation'); },
    });
    assert.deepEqual(skipped.built, []);
    await prepare(component);
    await prepare(component === 'ui' ? 'cli' : 'ui');
    assert.equal(emissions, index + 1, 'unchanged inputs do not start another emitter');
  }
  assert.match(readFileSync(join(dependency, 'dist/widget.d.ts'), 'utf8'), /moving-server/);
  assert.match(readFileSync(join(dependency, 'dist/widget.js'), 'utf8'), /moving-server/);
  assert.equal(existsSync(join(root, 'apps/cli/dist')), false, 'typecheck preparation does not build the CLI host');
  for (const initial of [
    { project: null, args: ['--noEmit'] },
    { project: consumer, args: ['--noEmit', '--project', consumer] },
  ]) {
    const projects = [initial];
    await prepareWorkspaceTypecheckDeclarations(consumer, { projects, cwd: consumer, env });
    const result = spawnSync(compiler.command, [...compiler.argsPrefix, ...projects[0].args], { cwd: consumer, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  writeFileSync(join(consumer, 'portable.ts'), 'import { extra } from "@fixture/extra"; export function inferredPlan() { return extra(); }');
  const portable = join(consumer, 'tsconfig.portable.json');
  writeFileSync(portable, JSON.stringify({ extends: './tsconfig.json', compilerOptions: {
    noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: './portable',
  }, files: ['portable.ts'] }));
  const portableProjects = [{ project: portable, args: ['-p', portable] }];
  await prepareWorkspaceTypecheckDeclarations(join(root, 'apps/ui'), { projects: portableProjects, cwd: consumer, env });
  const portability = spawnSync(compiler.command, [...compiler.argsPrefix, ...portableProjects[0].args], { cwd: consumer, encoding: 'utf8' });
  assert.equal(portability.status, 0, portability.stdout + portability.stderr);
  assert.doesNotMatch(readFileSync(join(consumer, 'portable/portable.d.ts'), 'utf8'), /node_modules\/\.cache|typecheck-declarations/,
    'an emitting consumer names inferred dependency types through public exports');
  assert.equal(portableProjects[0].project, portable, 'package preparation must not redirect a consumer');
  assert.deepEqual(portableProjects[0].args, ['-p', portable]);
  const canonicalWidget = join(dependency, 'dist/widget.d.ts');
  writeFileSync(canonicalWidget, readFileSync(canonicalWidget, 'utf8').replace('moving-server', 'overwritten'));
  await prepare('server');
  unlinkSync(source);
  writeFileSync(join(dependency, 'src/index.ts'), 'export const value = "after-delete";');
  writeFileSync(join(extra, 'src/index.ts'), 'export const extra = true;');
  writeFileSync(join(consumer, 'consumer.ts'), 'import { makePlan } from "@happier-dev/protocol/widget"; export { makePlan };');
  const projects = [{ project: join(consumer, 'tsconfig.json'), args }];
  await prepareWorkspaceTypecheckDeclarations(consumer, { projects, env });
  const removed = spawnSync(compiler.command, [...compiler.argsPrefix, '--noEmit', '-p', projects[0].project], { cwd: consumer, encoding: 'utf8' });
  assert.equal(removed.status, 2, 'a removed wildcard export must not remain typecheckable through cached declarations');
  assert.match(removed.stdout, /TS2307/);
});

test('public compiler stays reader-only while an explicit batch prepares current declarations', { skip: process.platform !== 'linux', timeout: 60000 }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-typecheck-one-admission-' });
  writeFileSync(join(root, 'package.json'), '{"private":true}');
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  for (const name of ['cli', 'ui']) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
  }
  const dependency = join(root, 'packages/protocol');
  const consumer = join(root, 'apps/server');
  mkdirSync(join(dependency, 'src'), { recursive: true });
  mkdirSync(join(dependency, 'dist'), { recursive: true });
  mkdirSync(consumer, { recursive: true });
  const metadata = { name: '@happier-dev/protocol', type: 'module', types: './dist/index.d.ts',
    scripts: { build: 'node compile.mjs' } };
  writeFileSync(join(dependency, 'package.json'), JSON.stringify(metadata));
  const buildOwner = fileURLToPath(new URL('../../../../../scripts/workspaces/buildTypeScriptPackageDist.mjs', import.meta.url));
  writeFileSync(join(dependency, 'compile.mjs'), `import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, [${JSON.stringify(buildOwner)}, '--project', 'tsconfig.json'], { env: process.env, stdio: 'inherit' });
process.exitCode = result.status ?? 1;`);
  writeFileSync(join(dependency, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    declaration: true, rootDir: 'src', outDir: 'dist', types: [],
  }, include: ['src/**/*.ts'] }));
  writeFileSync(join(dependency, 'src/index.ts'), 'export const current = "source";');
  writeFileSync(join(dependency, 'dist/index.d.ts'), 'export declare const current = "stale";');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: '@fixture/server', dependencies: {
    '@happier-dev/protocol': 'workspace:*',
  } }));
  writeFileSync(join(consumer, 'consumer.ts'), 'import { current } from "@happier-dev/protocol"; const value: "source" = current;');
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, types: [], moduleResolution: 'bundler', module: 'esnext',
    paths: { '@happier-dev/protocol': [join(dependency, 'dist/index.d.ts')] },
  }, files: ['consumer.ts'] }));
  const native = await installWorkspaceAdmissionProcessFixture(t, root, { env: { PATH: process.env.PATH,
    HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root,
    HAPPIER_STACK_PM_CACHE_BASE_DIR: join(root, 'worker-cache') } });
  const runner = fileURLToPath(new URL('../../../../../scripts/workspaces/runTypeScriptCli.mjs', import.meta.url));
  const check = async () => {
    const child = spawn(process.execPath, [runner, '-p', 'tsconfig.json', '--pretty', 'false'], {
      cwd: consumer, env: native.env, signal: t.signal, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const admissions = [];
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => {
      stderr += value;
    });
    // Observe the actual native reservation rather than a compiler timing log;
    // the runner's measurement adapter need not emit a startup marker.
    let sampling = true;
    const sampled = (async () => {
      while (sampling) {
        const status = await native.brokerStatus();
        if (status.activeCount) admissions.push({ activeCount: status.activeCount, reservedMemoryKiB: status.reservedMemoryKiB });
        await delay(10);
      }
    })();
    let result;
    try {
      result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (status, signal) => resolve({ status, signal })); });
    } finally { sampling = false; await sampled; }
    assert.ok(admissions.length > 0, stderr);
    for (const status of admissions) assert.deepEqual(status,
      { activeCount: 1, reservedMemoryKiB: resolveHeavyweightMemoryFloorKiB('compilation') },
      'the reader retains one compilation envelope');
    assert.doesNotMatch(stderr, /class=declaration-emit|TS2883|TS2742|node_modules\/\.cache/);
    assert.doesNotMatch(stderr, /\[typecheck-preparation\]|\[typecheck-declarations\]/,
      'a public compiler must not revive withdrawn producer preparation');
    return { ...result, stdout, stderr };
  };
  const stale = await check();
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout + stale.stderr, /TS2322/);
  assert.equal(readFileSync(join(dependency, 'dist/index.d.ts'), 'utf8'), 'export declare const current = "stale";');
  await prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir: 'apps/server', validationKind: 'typecheck',
    batchReader: { command: process.execPath, args: [runner, '-p', 'tsconfig.json', '--pretty', 'false'], cwd: consumer },
    env: native.env });
  const current = await check();
  assert.equal(current.status, 0, current.stdout + current.stderr);
  assert.equal(existsSync(resolveWorkspacePackageBuildLockPath(dependency, metadata)), false);
  await assertNativeAdmissionIdle(native);
});

test('native declaration admission waits for package-build publication before emitting once', { skip: process.platform !== 'linux', timeout: 60000 }, async t => {
    const { root } = await createTempFixture(t, { prefix: 'hstack-declaration-busy-lock-' });
    writeFileSync(join(root, 'package.json'), '{"private":true}');
    writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters: {}\n");
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
    const dependency = join(root, 'packages/protocol');
    mkdirSync(join(dependency, 'src'), { recursive: true });
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol',
      types: './dist/index.d.ts', scripts: { build: declarationFixtureBuild } }));
    writeFileSync(join(dependency, 'src/index.ts'), 'export const current = true;');
    writeFileSync(join(dependency, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      declaration: true, rootDir: 'src', outDir: 'dist', types: [],
    }, include: ['src/**/*.ts'] }));
    const consumers = ['cli', 'ui', 'server'].map(name => {
      const dir = join(root, 'apps', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${name}`,
        dependencies: { '@happier-dev/protocol': 'workspace:*' } }));
      return dir;
    }).filter(dir => !dir.endsWith('/ui'));
    // Only physical-worker process/OS observations are adapted; native disk,
    // admission, package publication and Microsoft declaration emission stay real.
    const native = await installWorkspaceAdmissionProcessFixture(t, root, {
      env: { PATH: process.env.PATH, HAPPIER_STACK_REPO_DIR: root,
        HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root, HAPPIER_STACK_PM_CACHE_BASE_DIR: join(root, 'worker-cache') },
    });
    const controller = new AbortController();
    const observationSignal = AbortSignal.any([controller.signal, t.signal, AbortSignal.timeout(15000)]);
    const client = await import(pathToFileURL(native.admissionClientPath));
    const blocked = (async () => {
      for await (const status of client.watchAdmissionSamples(native.admissionRoot, { signal: observationSignal })) {
        if (status.waitingCount === consumers.length && status.activeCount === 0) return status;
      }
      assert.fail('admission observation ended before both requests queued');
    })();
    let terminal;
    try {
      await withWorkspaceBundleLock(async () => {
        terminal = Promise.all(consumers.map(consumer => prepareWorkspaceTypecheckDeclarations(consumer,
          { env: native.env, signal: t.signal })));
        const status = await Promise.race([blocked,
          terminal.then(() => assert.fail('declaration consumers did not wait for the held lock'))]);
        assert.equal(status.activeCount, 0, 'busy producers reserve no compiler capacity');
        assert.equal(existsSync(join(dependency, 'dist/index.d.ts')), false);
      }, { lockPath: resolveWorkspacePackageBuildLockPath(dependency, { name: '@happier-dev/protocol' }), signal: t.signal });
      const results = await terminal;
      assert.ok(results.every(result => result.ok));
      assert.deepEqual(results.flatMap(result => result.declarations), ['@happier-dev/protocol'],
        'concurrent cold consumers emit once after lock release');
    } finally {
      controller.abort();
      await Promise.allSettled([blocked, terminal]);
    }
    assert.match(readFileSync(join(dependency, 'dist/index.d.ts'), 'utf8'), /current = true/);
    await assertNativeAdmissionIdle(native);
});

test('declaration preparation leaves consumer admission and references untouched', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-declaration-producer-ownership-' });
  writeFileSync(join(root, 'package.json'), '{"private":true}');
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters: {}\n");
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  for (const app of ['cli', 'ui', 'server']) {
    const dir = join(root, 'apps', app);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
      dependencies: { '@happier-dev/protocol': 'workspace:*' } }));
    writeFileSync(join(dir, 'entry.ts'), 'export const current = true;');
  }
  const dependency = join(root, 'packages/protocol');
  mkdirSync(join(dependency, 'src'), { recursive: true });
  writeFileSync(join(dependency, 'src/index.ts'), 'export const current = true;');
  writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol',
    types: './dist/index.d.ts', scripts: { build: declarationFixtureBuild } }));
  writeFileSync(join(dependency, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    declaration: true, rootDir: 'src', outDir: 'dist', types: [],
  }, include: ['src/**/*.ts'] }));
  const uiProject = join(root, 'apps/ui/tsconfig.source.json');
  const cliProject = join(root, 'apps/cli/tsconfig.test.json');
  writeFileSync(uiProject, JSON.stringify({ compilerOptions: { types: [], composite: true,
    declaration: true, emitDeclarationOnly: true, rootDir: '.', outDir: './declarations' }, files: ['entry.ts'] }));
  writeFileSync(cliProject, JSON.stringify({ compilerOptions: { types: [], noEmit: true },
    files: ['entry.ts'], references: [{ path: uiProject }] }));
  const projects = [uiProject, cliProject].map(project => {
    const args = ['--noEmit', '-p', project];
    return { project, authoredProject: project, authoredArgs: args, args };
  });
  await prepareWorkspaceTypecheckDeclarations(join(root, 'apps/cli'), { projects,
    env: { CI: 'true', PATH: process.env.PATH } });
  const policy = project => resolveRemoteCommandPolicy(['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit', '-p', project],
    { cwd: 'apps/cli', repoRoot: root });
  assert.equal(policy(uiProject).heavyClass, 'compilation-ui');
  const invocation = resolveTypeScriptCliInvocation({ args: projects[0].args, admissionArgs: projects[0].authoredArgs,
    repoRoot: root, workspaceDir: join(root, 'apps/cli'), env: { CI: 'true', HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED: '1' }, platform: 'linux' });
  assert.ok(invocation.argsPrefix.includes(`--class=${policy(uiProject).heavyClass}`),
    'UI declaration preparation retains its producer envelope even when requested by CLI');
  const consumer = JSON.parse(readFileSync(projects[1].project, 'utf8'));
  assert.equal(consumer.references[0].path, projects[0].project,
    'a prepared consumer references the producer config with the same current dependency aliases');
});

test('runtime preparation publishes captured inputs and preserves last-green after compiler failure', async t => {
  for (const scenario of ['warm', 'cold', 'damaged', 'compiler-error', 'dependency-drift']) await t.test(scenario, async t => {
    const { root } = await createTempFixture(t, { prefix: 'hstack-finite-preparation-drift-' });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
    for (const app of ['cli', 'ui', 'server']) {
      mkdirSync(join(root, 'apps', app), { recursive: true });
      writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
        ...(app === 'server' ? { dependencies: { '@happier-dev/plugin-sdk': 'workspace:*' } } : {}) }));
    }
    const sdk = join(root, 'packages/plugin-sdk');
    mkdirSync(join(sdk, 'src'), { recursive: true });
    writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@happier-dev/plugin-sdk', type: 'module',
      main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'fixture-compiler' } }));
    const source = join(sdk, 'src/index.ts');
    const receipt = join(sdk, 'dist/.happier-build-inputs.json');
    const output = join(sdk, 'dist/index.js');
    writeFileSync(source, 'export const value = "green";\n');
    let moving = false, attempts = 0;
    // Replace only the compiler process. Captures, output integrity and
    // publication remain real, including an edit during compilation.
    const workspaceBuildBoundary = {
      prepareEnv: async (_dir, env) => ({ ...env }),
      runPackageBuild: async (dir, { env }) => {
        attempts++;
        if (moving && scenario === 'compiler-error') throw Object.assign(new Error('src/index.ts(1,1): error TS2322: incompatible value'), { code: 'EEXIT', exitCode: 1 });
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(join(dir, 'src/index.ts')));
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), 'export declare const value: string;\n');
        // An external dependency writer can advance its generation even when
        // it fails before publishing a new ready marker.
        if (moving && scenario === 'dependency-drift') writeFileSync(generationPath, JSON.stringify({ generation: 'after-failed-writer' }));
        if (moving) writeFileSync(source, `export const value = "moving-${attempts}";\n`);
      },
    };
    const env = { ...process.env, HAPPIER_WORKSPACE_BUILD_MODE: 'strict',
      HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root };
    const generationPath = `${resolveDependencyRefreshLockPath(root, env)}.generation`;
    if (scenario !== 'cold') await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps/server'), {
      env, workspaceBuildBoundary,
    });
    const greenRecord = scenario === 'cold' ? null : JSON.parse(readFileSync(receipt, 'utf8'));
    if (scenario === 'damaged') writeFileSync(output, 'damaged retained output');
    writeFileSync(source, 'export const value = "next";\n');
    moving = true;
    attempts = 0;
    const prepare = () => prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir: 'apps/server',
        validationKind: 'runtime',
        env,
        loadWorkspaceBuildOwner: async () => ({
          ensureWorkspacePackagesBuiltForComponent: (dir, options) => ensureWorkspacePackagesBuiltForComponent(dir, {
            ...options, workspaceBuildBoundary,
          }),
        }),
      });
    if (scenario === 'compiler-error') {
      await assert.rejects(prepare(), { code: 'EEXIT' });
      assert.equal(attempts, 1);
      assert.equal(readFileSync(output, 'utf8'), 'export const value = "green";\n');
      assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), greenRecord);
      return;
    }
    if (scenario === 'dependency-drift') {
      const publicationBefore = readOutputPublicationIdentity([output, receipt]);
      await assert.rejects(prepare(), { code: 'BUILD_INPUTS_CHANGED', trailingPassExhausted: false });
      assert.equal(attempts, 1, 'dependency drift rejects one artifact compile without an internal recompile');
      assert.equal(readFileSync(output, 'utf8'), 'export const value = "green";\n');
      assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), greenRecord);
      assert.deepEqual(readOutputPublicationIdentity([output, receipt]), publicationBefore, 'rejected artifacts cause zero package-output publications');
      return;
    }
    const result = await prepare();
    assert.equal(attempts, 1, 'a captured compiler input does not need a trailing pass');
    assert.deepEqual(result.built, ['@happier-dev/plugin-sdk']);
    assert.equal(readFileSync(output, 'utf8'), 'export const value = "next";\n');
    assert.equal(readFileSync(source, 'utf8'), 'export const value = "moving-1";\n');
    const capturedRecord = readFileSync(receipt, 'utf8');
    moving = false;
    const recovered = await prepare();
    assert.deepEqual(recovered.built, ['@happier-dev/plugin-sdk']);
    assert.equal(recovered.stalePackages?.length ?? 0, 0);
    assert.equal(readFileSync(output, 'utf8'), 'export const value = "moving-1";\n');
    assert.notEqual(readFileSync(receipt, 'utf8'), capturedRecord, 'the later source edit is prepared by the next producer invocation');
  });
});

test('cold CLI artifact publication builds the selected plugin before invoking its artifact consumer', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-cold-plugin-dist-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/plugins/*"\n');
  const cli = join(root, 'apps/cli');
  const plugin = join(root, 'packages/plugins/claude');
  for (const name of ['ui', 'server']) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
  }
  mkdirSync(join(cli, 'scripts/build-owned'), { recursive: true });
  mkdirSync(join(plugin, 'src'), { recursive: true });
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module',
    bundledDependencies: ['@happier-dev/plugins-claude'], dependencies: { '@happier-dev/plugins-claude': 'workspace:*' } }));
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-claude',
    version: '0.0.0', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
    scripts: { build: 'node compile.mjs' } }));
  writeFileSync(join(plugin, 'src/manifest.ts'), 'export const PLUGIN_MANIFEST = { id: "happier.agent.claude", runtime: { apiVersion: 1 }, contributes: {} };\n');
  writeFileSync(join(plugin, 'src/index.ts'), 'export const generation = 1;\n');
  writeFileSync(join(plugin, 'tsconfig.json'), JSON.stringify({ compilerOptions: { outDir: 'dist' }, include: ['src'] }));
  // Compiler and generator subprocesses are system boundaries. Real membership,
  // package build ordering, output admission and publication dispatch stay live.
  writeFileSync(join(plugin, 'compile.mjs'), `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR; mkdirSync(out, { recursive: true });
writeFileSync(out + '/index.js', readFileSync('src/index.ts')); writeFileSync(out + '/index.d.ts', 'export declare const generation: number;');`);
  const heapLauncher = fileURLToPath(new URL('../../../../cli/scripts/withNodeHeapLimit.mjs', import.meta.url));
  writeFileSync(join(cli, 'scripts/withNodeHeapLimit.mjs'), `import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, [${JSON.stringify(heapLauncher)}, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error; process.exit(result.status ?? 1);`);
  writeFileSync(join(cli, 'scripts/build-owned/generateBundledPluginEntries.ts'), `import { readFileSync, writeFileSync } from 'node:fs';
const root = process.argv[process.argv.indexOf('--root') + 1];
const dist = readFileSync(root + '/packages/plugins/claude/dist/index.js', 'utf8');
writeFileSync(root + '/published-plugin', dist);`);
  const prepare = () => prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir: 'apps/cli', validationKind: 'runtime', env: native.env });
  assert.deepEqual(resolveCliBundledWorkspacePackageNames({ repoRoot: root }), ['plugins-claude']);
  await prepare();
  assert.equal(readFileSync(join(root, 'published-plugin'), 'utf8'), 'export const generation = 1;\n');
  writeFileSync(join(plugin, 'src/index.ts'), 'export const generation = 2;\n');
  await prepare();
  assert.equal(readFileSync(join(root, 'published-plugin'), 'utf8'), 'export const generation = 2;\n');
});

test('UI source-test preparation materializes the replica-owned atmosphere core through the checkout generator', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-ui-atmosphere-preparation-' });
  const tools = join(root, 'apps/ui/tools/atmosphere');
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(root, 'apps/ui/package.json'), JSON.stringify({ name: '@fixture/ui' }));
  // The checkout's own generator is its process boundary (it needs the
  // replica's installed esbuild); preparation must call it, natively only.
  writeFileSync(join(tools, 'buildAtmosphereRenderers.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs';
export async function buildAtmosphereRenderers({ web = true } = {}) {
  mkdirSync(new URL('../../sources/components/atmosphere/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../../sources/components/atmosphere/backdropWorkletCore.generated.js', import.meta.url), 'web=' + web);
}
`);
  const output = join(root, 'apps/ui/sources/components/atmosphere/backdropWorkletCore.generated.js');
  await prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir: 'apps/cli', validationKind: 'source-test' });
  assert.equal(existsSync(output), false, 'only UI source tests consume the atmosphere core');
  await prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir: 'apps/ui', validationKind: 'source-test' });
  assert.equal(readFileSync(output, 'utf8'), 'web=false');
});

// Measured 2026-11-11 (controller, n2): the generator bundles one file in about
// 0.1 s at about 53 MB peak RSS. The 12 GiB 'source-bundle' floor queued every
// worker UI source test behind whole-host reservations before its payload.
test('UI atmosphere core preparation reserves the source-asset floor, not a source bundle', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-ui-atmosphere-floor-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const generator = fixture.path('apps/ui/tools/atmosphere/buildAtmosphereRenderers.mjs');
  const observed = fixture.path('atmosphere-floor.json');
  mkdirSync(join(generator, '..'), { recursive: true });
  writeFileSync(generator, `import { writeFileSync } from 'node:fs';
export async function buildAtmosphereRenderers() {
  writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ floorKiB: Number(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_FLOOR_KIB) }));
}
`);
  await prepareRemoteValidationWorkspace({ repoDir: fixture.root, componentRelativeDir: 'apps/ui',
    validationKind: 'source-test', env: native.env });
  assert.deepEqual(JSON.parse(readFileSync(observed, 'utf8')), { floorKiB: 1024 * 1024 });
  await assertNativeAdmissionIdle(native);
});

// Owner ruling 2026-11-16 ("small suites local"): a focused run placed on this
// machine starts without the shared queue, and so does its preparation.
test('focused UI source-test preparation runs the producers without an admission slot', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-ui-atmosphere-focused-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const generator = fixture.path('apps/ui/tools/atmosphere/buildAtmosphereRenderers.mjs');
  const observed = fixture.path('atmosphere-focused.json');
  mkdirSync(join(generator, '..'), { recursive: true });
  writeFileSync(generator, `import { writeFileSync } from 'node:fs';
export async function buildAtmosphereRenderers(options) {
  writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ options, pid: process.pid }));
}
`);
  await prepareRemoteValidationWorkspace({ repoDir: fixture.root, componentRelativeDir: 'apps/ui',
    validationKind: 'source-test', focusedTest: true, env: native.env });
  // No admitted child: the producer ran in the preparing process itself.
  assert.deepEqual(JSON.parse(readFileSync(observed, 'utf8')), { options: { web: false }, pid: process.pid });
  await assertNativeAdmissionIdle(native);
});

test('source-test readers leave cold, current and stale outputs to their producers', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-preparation-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  const cli = join(root, 'apps/cli');
  const protocol = join(root, 'packages/protocol');
  mkdirSync(cli, { recursive: true });
  for (const name of ['ui', 'server']) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
  }
  mkdirSync(join(protocol, 'src'), { recursive: true });
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@fixture/cli', dependencies: { '@fixture/protocol': 'workspace:*' } }));
  writeFileSync(join(protocol, 'package.json'), JSON.stringify({ name: '@fixture/protocol', type: 'module', main: './dist/index.js', scripts: { build: 'node compile.mjs' } }));
  const count = join(root, 'compiler-count');
  // Only the external compiler is substituted. Policy, graph, admission,
  // capture and atomic package publication use the production owners.
  writeFileSync(join(protocol, 'compile.mjs'), `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(count)}, 'compile\\n');
writeFileSync(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR + '/index.js', readFileSync('src/index.ts'));
`);
  const source = join(protocol, 'src/index.ts');
  const output = join(protocol, 'dist/index.js');
  const receipt = join(protocol, 'dist/.happier-build-inputs.json');
  const env = { ...native.env, HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root };
  writeFileSync(source, 'export const value = 1;\n');
  const prepare = async () => {
    for (const componentRelativeDir of ['apps/cli', 'apps/ui', 'packages/plugin-sdk']) {
      await prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir, validationKind: 'source-test', env });
    }
    const args = ['vitest', 'run', '--config=vitest.inMemory.config.ts', 'selected.test.ts'];
    const policies = [resolveRemoteCommandPolicy(args, { cwd: cli, repoRoot: root })];
    if (process.platform !== 'win32') {
      const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
      const result = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2/apps/cli; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_kind" "$policy_component"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const [kind, component] = result.stdout.split(',');
      policies.push({ kind, component });
    }
    const compilesBefore = existsSync(count) ? readFileSync(count, 'utf8') : '';
    const publicationBefore = existsSync(output) ? readOutputPublicationIdentity([output, receipt]) : null;
    for (const policy of policies) {
      const result = await prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir: policy.component,
        validationKind: policy.kind, env });
      assert.equal(existsSync(count) ? readFileSync(count, 'utf8') : '', compilesBefore,
        'in-memory source preparation executes zero workspace-package compilers');
      assert.equal(policy.kind, 'source-test');
      assert.deepEqual(result.built, []);
      assert.deepEqual(existsSync(output) ? readOutputPublicationIdentity([output, receipt]) : null, publicationBefore,
        'in-memory source preparation performs zero atomic package-output publications');
    }
  };
  await prepare();
  assert.throws(() => readFileSync(output), { code: 'ENOENT' });
  await ensureWorkspacePackagesBuiltForComponent(cli, { env, quiet: true });
  assert.equal(readFileSync(count, 'utf8'), 'compile\n', 'the real producer admits the fixture output');
  await prepare();
  writeFileSync(source, 'export const value = 2;\n');
  await prepare();
  assert.equal(readFileSync(output, 'utf8'), 'export const value = 1;\n');
  await ensureWorkspacePackagesBuiltForComponent(cli, { env, quiet: true });
  assert.equal(readFileSync(count, 'utf8'), 'compile\ncompile\n', 'the unrelated stale output really needs rebuilding');
  assert.equal(readFileSync(output, 'utf8'), 'export const value = 2;\n');
});

test('source-test collection follows Protocol source edits and rejects malformed reachable source without dist', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-collection-' });
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const vitestEntry = fileURLToPath(import.meta.resolve('vitest'));
  const vitestCli = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'));
  const source = join(root, 'protocol/src');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(root, 'protocol/package.json'), JSON.stringify({
    name: '@happier-dev/protocol', exports: { '.': { default: './dist/index.js' } },
  }));
  const config = join(root, 'vitest.config.mts');
  writeFileSync(config, `import { createWorkspacePackageSourcesPlugin } from ${JSON.stringify(join(repoRoot, 'scripts/testing/vitestWorkspacePackageResolution.ts'))};
export default { plugins: [createWorkspacePackageSourcesPlugin([{ packageName: '@happier-dev/protocol', packageSourceRoot: ${JSON.stringify(source)} }])], test: { include: ['owner.test.ts'], pool: 'forks', maxWorkers: 1 } };`);
  const writeSourceAndExpectation = value => {
    writeFileSync(join(source, 'index.ts'), `export const value = ${value};\n`);
    writeFileSync(join(root, 'owner.test.ts'), `import { test, expect } from ${JSON.stringify(vitestEntry)}; import { value } from '@happier-dev/protocol'; test('current source', () => expect(value).toBe(${value}));`);
  };
  // This isolated resolver fixture already runs beneath the containing native
  // test's admission. A second package dispatch would prepare unrelated dist.
  const collect = () => spawnSync(process.execPath, [vitestCli, 'run', `--root=${root}`, `--config=${config}`], {
    cwd: join(repoRoot, 'apps/cli'), env: process.env, encoding: 'utf8',
  });
  writeSourceAndExpectation(1);
  let result = collect();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  writeSourceAndExpectation(2);
  result = collect();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  writeFileSync(join(source, 'index.ts'), 'export const value = ;\n');
  result = collect();
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Failed Suites|Transform failed/);
});

test('artifact-consuming preparation publishes cold outputs, reuses current outputs and rebuilds stale outputs', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-artifact-preparation-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  for (const name of ['ui', 'cli', 'server']) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}`, version: '1.0.0' }));
  }
  const sdk = join(root, 'packages/plugin-sdk');
  const protocol = join(root, 'packages/protocol');
  mkdirSync(sdk, { recursive: true });
  mkdirSync(join(protocol, 'src'), { recursive: true });
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@fixture/sdk', dependencies: { '@fixture/protocol': '1.0.0' } }));
  writeFileSync(join(protocol, 'package.json'), JSON.stringify({ name: '@fixture/protocol', type: 'module', version: '1.0.0', main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'node compile.mjs' } }));
  const count = join(root, 'builds');
  writeFileSync(join(protocol, 'compile.mjs'), `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'; const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR; mkdirSync(out, { recursive: true }); const source = readFileSync('src/index.ts', 'utf8'); writeFileSync(out + '/index.js', source); writeFileSync(out + '/index.d.ts', 'export declare const value: number;'); appendFileSync(${JSON.stringify(count)}, 'build\\n');`);
  const source = join(protocol, 'src/index.ts');
  const prepare = () => prepareRemoteValidationWorkspace({
    repoDir: root, componentRelativeDir: 'packages/plugin-sdk', validationKind: 'runtime',
    // The fixture owns both the physical inputs and canonical checkout identity.
    env: { ...native.env, HAPPIER_WORKSPACE_BUILD_MODE: 'strict',
      HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root },
  });
  writeFileSync(source, 'export const value = 1;\n');
  await prepare();
  assert.equal(readFileSync(join(protocol, 'dist/index.js'), 'utf8'), 'export const value = 1;\n');
  await prepare();
  assert.equal(readFileSync(count, 'utf8'), 'build\n');
  // A public build's prebuild repeats ordinary strict preparation after the
  // remote producer has released its capture/publication custody.
  await ensureWorkspacePackagesBuiltForComponent(sdk, {
    env: { ...native.env, HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_STACK_REPO_DIR: root },
  });
  assert.equal(readFileSync(count, 'utf8'), 'build\n', 'the admitted payload must reuse its captured strict prerequisites');
  writeFileSync(source, 'export const value = 2;\n');
  await prepare();
  assert.equal(readFileSync(join(protocol, 'dist/index.js'), 'utf8'), 'export const value = 2;\n');
  assert.equal(readFileSync(count, 'utf8'), 'build\nbuild\n');
});

test('remote validation preparation delegates component dependency outputs to the canonical workspace owner', async () => {
  const calls = [];
  const publicationCalls = [];
  const result = await prepareRemoteValidationWorkspace({
    repoDir: '/remote/happier',
    componentRelativeDir: 'apps/cli',
    env: { TEST_ENV: '1', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: async (...args) => {
        calls.push(args);
        return { ok: true, built: ['@happier-dev/plugins-codex'], skipped: [] };
      },
    }),
    loadCliBuildOwner: async () => ({
      resolveCliBundledWorkspacePackageNames: (options) => {
        assert.deepEqual(options, { repoRoot: '/remote/happier' });
        // Exact mixed CLI bundled selection shape: host workspaces plus bundled
        // plugins, as produced by the canonical bundled workspace resolver.
        return ['protocol', 'agents', 'plugins-codex', 'plugins-claude'];
      },
      publishBundledPluginArtifactsAfterWorkspaceBuild: async (options) => {
        publicationCalls.push(options);
        return true;
      },
    }),
  });

  assert.deepEqual(calls, [[
    '/remote/happier/apps/cli',
    { env: { TEST_ENV: '1', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1' }, isolatePluginFailures: true },
  ]]);
  assert.deepEqual(result, {
    ok: true,
    built: ['@happier-dev/plugins-codex'],
    skipped: [],
  });
  assert.deepEqual(publicationCalls, [{
    repoRoot: '/remote/happier',
    workspaceNames: ['protocol', 'agents', 'plugins-codex', 'plugins-claude'],
    env: { TEST_ENV: '1', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1' },
    publicationMode: 'live',
    bundledPluginArtifactPublication: { mode: 'write', targetOwnedOnly: true },
  }]);
});

test('remote development validation isolates an optional plugin at the real package build boundary', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-optional-validation-' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/plugins/*"\n');
  const ui = join(root, 'apps/ui');
  const inspector = join(root, 'packages/plugins/inspector');
  mkdirSync(ui, { recursive: true });
  mkdirSync(join(root, 'apps/cli'), { recursive: true });
  mkdirSync(join(root, 'apps/server'), { recursive: true });
  writeFileSync(join(root, 'apps/cli/package.json'), JSON.stringify({ name: '@fixture/cli' }));
  writeFileSync(join(root, 'apps/server/package.json'), JSON.stringify({ name: '@fixture/server' }));
  mkdirSync(inspector, { recursive: true });
  writeFileSync(join(ui, 'package.json'), JSON.stringify({
    name: '@fixture/ui', dependencies: { '@happier-dev/plugins-inspector': 'workspace:*' },
  }));
  writeFileSync(join(inspector, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-inspector', main: './dist/index.js', scripts: { build: 'fixture-compiler' },
  }));
  const result = await prepareRemoteValidationWorkspace({
    repoDir: root, componentRelativeDir: 'apps/ui', validationKind: 'runtime',
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: (dir, options) => ensureWorkspacePackagesBuiltForComponent(dir, {
        ...options, quiet: true,
        workspaceBuildBoundary: {
          prepareEnv: async (_dir, env) => ({ ...env }),
          runPackageBuild: async () => { throw new Error('optional UI compiler failed'); },
        },
      }),
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pluginFailures.map((failure) => failure.packageName), ['@happier-dev/plugins-inspector']);
  assert.match(result.pluginFailures[0].diagnostic.message, /optional UI compiler failed/);
});

test('remote validation preparation does not publish CLI projections for unrelated components', async () => {
  let loadedCliOwner = false;
  await prepareRemoteValidationWorkspace({
    repoDir: '/remote/happier',
    componentRelativeDir: 'packages/protocol',
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: async () => ({ ok: true, built: [], skipped: [] }),
    }),
    loadCliBuildOwner: async () => {
      loadedCliOwner = true;
      throw new Error('unrelated component must not load the CLI publisher');
    },
  });
  assert.equal(loadedCliOwner, false);
});

test('remote UI validation publishes source-derived manifests before component preparation validates plugins', async () => {
  const events = [];
  await prepareRemoteValidationWorkspace({
    repoDir: '/remote/happier',
    componentRelativeDir: 'apps/ui',
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: async (componentDir) => {
        events.push(`prepare:${componentDir}`);
        return { ok: true, built: [], skipped: [] };
      },
    }),
    loadCliBuildOwner: async () => ({
      resolveCliBundledWorkspacePackageNames: () => ['protocol', 'plugins-codex'],
      publishBundledPluginArtifactsAfterWorkspaceBuild: async () => {
        events.push('publish');
        return true;
      },
    }),
  });
  assert.deepEqual(events, [
    'publish',
    'prepare:/remote/happier/apps/ui',
    'prepare:/remote/happier/apps/cli',
  ]);
});

test('remote validation preparation rejects paths outside the synchronized repository', async () => {
  await assert.rejects(
    prepareRemoteValidationWorkspace({
      repoDir: '/remote/happier',
      componentRelativeDir: '../outside',
    }),
    /inside the synchronized repository/i,
  );
});

// TRIAGE-JOURNEY-E2E 2026-11-18: a packages/tests E2E imports UI source through
// the UI production hooks, so its replica needs the generated atmosphere core
// (backdropWorkletCore.generated) just like an apps/ui test.
test('a component whose Vitest configs load UI source prepares the UI source assets', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-ui-assets-consumer-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const generator = fixture.path('apps/ui/tools/atmosphere/buildAtmosphereRenderers.mjs');
  const observed = fixture.path('atmosphere-consumer.log');
  mkdirSync(join(generator, '..'), { recursive: true });
  writeFileSync(generator, `import { appendFileSync } from 'node:fs';
export async function buildAtmosphereRenderers(options) { appendFileSync(${JSON.stringify(observed)}, JSON.stringify(options) + '\\n'); }
`);
  mkdirSync(fixture.path('packages/tests'), { recursive: true });
  writeFileSync(fixture.path('packages/tests/vitest.core.config.ts'),
    "import { createUiProductionHooksVitestConfig } from './vitest.uiProductionHooks';\nexport default createUiProductionHooksVitestConfig();\n");
  mkdirSync(fixture.path('packages/other'), { recursive: true });
  writeFileSync(fixture.path('packages/other/vitest.config.ts'), 'export default {};\n');
  // Workspace package publication has its own owner tests; this case isolates the UI asset decision.
  const loadWorkspaceBuildOwner = async () => ({ ensureWorkspacePackagesBuiltForComponent: async () => ({ ok: true, built: [] }) });
  for (const validationKind of ['source-test', 'runtime']) {
    await prepareRemoteValidationWorkspace({ repoDir: fixture.root, componentRelativeDir: 'packages/tests',
      validationKind, focusedTest: true, env: native.env, loadWorkspaceBuildOwner });
    await prepareRemoteValidationWorkspace({ repoDir: fixture.root, componentRelativeDir: 'packages/other',
      validationKind, focusedTest: true, env: native.env, loadWorkspaceBuildOwner });
  }
  assert.deepEqual(readFileSync(observed, 'utf8').trim().split('\n'), ['{"web":false}', '{"web":false}'],
    'packages/tests prepares once per validation kind; a component without UI source consumers does not');
});
