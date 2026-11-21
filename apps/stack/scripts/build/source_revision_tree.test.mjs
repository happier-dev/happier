// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { inspectDependencyRefresh } from '../utils/proc/dependency_refresh.mjs';
import { generateServerClients, installServerGeneratorFixture, readGeneratedClientFields, writeServerSchemas, FIXTURE_MACHINE_SCHEMA } from '../testkit/core/server_generator_fixture.mjs';
import { resolveSourceRevision, resolveSourceRevisionIdentity, writeSourceRevisionDescriptor } from './source_revision.mjs';
import { beginPendingSourceStart } from '../runtime/shared/pending_source_start.mjs';
import { prepareSourceTreeRuntimeComponents, prepareStackSourceRevisionTree, releaseStackSourceRevisionTree, releaseStackSourceTrees,
  recordSourceTreeBases, resolveSourceTreeRevision, selectsSourceTreeReload, setSourceRevisionTreeWritable, sourceRevisionTreesRoot, sweepSourceRevisionBases,
  writeSourceRevisionArchive } from './source_revision_tree.mjs';

const COMMITTED_MAIN = 'export { marker } from "@happier-dev/shared";';
const COMMITTED_SHARED = 'export const marker = "committed";';

test('source tree release retains a surviving Session host until that process exits', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t);
  const stackBaseDir = fixture.path('stack');
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  const incumbent = join(sourceRoot, 'tree-daemon-01234567');
  const replacement = join(sourceRoot, 'tree-daemon-89abcdef');
  const entry = join(incumbent, 'session-host.mjs');
  await mkdir(incumbent, { recursive: true });
  await mkdir(replacement, { recursive: true });
  await writeFile(entry, 'process.on("message", () => process.disconnect()); process.send("ready");');
  await writeFile(join(sourceRoot, 'selected-daemon.json'), JSON.stringify({ entrypoint: join(replacement, 'index.mjs') }));
  const host = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (host.exitCode === null) host.kill(); });
  const exited = once(host, 'exit');
  assert.deepEqual(await once(host, 'message'), ['ready', undefined]);
  const retained = await releaseStackSourceTrees({ stackBaseDir, components: ['daemon'] });
  assert.deepEqual(retained, [], 'a surviving host keeps its source and native support available');
  assert.equal(await releaseStackSourceRevisionTree({ treesRoot: sourceRevisionTreesRoot(stackBaseDir), treeDir: incumbent }), null,
    'direct release shares the same live-process retention owner');
  assert.equal(await readFile(entry, 'utf8'), 'process.on("message", () => process.disconnect()); process.send("ready");');
  host.send('exit');
  await exited;
  if (process.platform === 'linux') {
    const readDirectory = fs.promises.readdir;
    // Procfs is the OS boundary; the retention owner remains real.
    t.mock.method(fs.promises, 'readdir', async (path, ...args) => {
      if (path === '/proc') throw Object.assign(new Error('process observation unavailable'), { code: 'EACCES' });
      return await readDirectory(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(await releaseStackSourceTrees({ stackBaseDir, components: ['daemon'] }), []);
      assert.equal((await lstat(incumbent)).isDirectory(), true, 'unavailable process observation retains the source tree');
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }
  assert.deepEqual(await releaseStackSourceTrees({ stackBaseDir, components: ['daemon'] }), [incumbent]);
  assert.equal(await lstat(incumbent).catch(error => error.code), 'ENOENT');
  assert.equal((await lstat(replacement)).isDirectory(), true);
});

test('tree retirement honors selections and rollback from sibling stacks', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t);
  const stackBaseDir = fixture.path('owner');
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  const peerRoot = fixture.path('peer/source-runtime');
  const selected = join(sourceRoot, 'tree-server-01234567');
  const rollback = join(sourceRoot, 'tree-daemon-89abcdef');
  const stale = join(sourceRoot, 'tree-server-abcdef01');
  await Promise.all([selected, rollback, stale, peerRoot].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(selected, 'main.mjs'), '');
  await writeFile(join(rollback, 'main.mjs'), '');
  await writeFile(join(peerRoot, 'selected-server.json'), JSON.stringify({ runtimeDir: selected }));
  await writeFile(join(peerRoot, 'rollback.json'), JSON.stringify({ selections: {
    daemon: { entrypoint: join(rollback, 'main.mjs') },
  } }));

  assert.deepEqual(await releaseStackSourceTrees({ stackBaseDir }), [stale]);
  assert.equal((await lstat(selected)).isDirectory(), true);
  assert.equal((await lstat(rollback)).isDirectory(), true);
});

test('daemon revision trees publish voice graphs at their declared plugin roots and reuse unchanged inputs', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const ownerUrl = path => new URL(path, import.meta.url).href;
  await writeFile(join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs'),
    `import ${JSON.stringify(ownerUrl('../../../../packages/cli-common/registerSourceRuntime.mjs'))};`);
  await mkdir(join(repoDir, 'apps/cli/scripts'), { recursive: true });
  await writeFile(join(repoDir, 'apps/cli/scripts/prepareSourcePluginUiArtifacts.mjs'),
    `export { prepareSourceCliPluginUiArtifacts } from ${JSON.stringify(ownerUrl('../../../cli/scripts/prepareSourcePluginUiArtifacts.mjs'))};`);
  await mkdir(join(repoDir, 'apps/cli/node_modules'), { recursive: true });
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')),
    join(repoDir, 'apps/cli/node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  const locators = [];
  for (const directory of ['voice-one', 'voice-two', 'voice-broken', 'no-ui']) {
    const root = join(repoDir, 'packages/plugins', directory);
    const name = `@happier-dev/plugins-${directory}`;
    const manifest = { schemaVersion: 2, id: `happier.${directory}`, version: '0.0.0', displayName: directory,
      runtime: { apiVersion: 1 }, hostAccess: { required: [], optional: [] }, contributes: {} };
    const exports = { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } };
    if (directory !== 'no-ui') {
      manifest.contributes.voiceProviders = [{ id: 'conversation', title: directory, kind: 'conversation',
        roles: ['realtime_conversation', 'turn_control'], platforms: ['web', 'ios', 'android'],
        capabilities: { turn: { cancelResponse: false, bargeIn: false } },
        client: { artifactId: 'voice-runtime', exportName: 'activate' } }];
      exports['./happier-plugin-ui/voice-runtime'] = { 'happier-source': './src/voice.ts', default: './dist/happier-plugin-ui/react-native/voice-runtime/entry.cjs.bundle' };
    }
    await mkdir(join(root, 'src'), { recursive: true });
    const declarationPath = join(repoDir, 'apps/cli/assets/bundled-plugin-manifests', `${directory}.json`);
    await mkdir(dirname(declarationPath), { recursive: true });
    await writeFile(declarationPath, JSON.stringify(manifest));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', exports }));
    await writeFile(join(root, 'src/index.ts'), 'export {};');
    await writeFile(join(root, 'src/voice.ts'), directory === 'voice-broken' ? 'export function activate( {'
      : `import { marker } from '@happier-dev/shared'; export function activate() { return ${JSON.stringify(directory)} + marker; }`);
    locators.push({ sourceSpec: { locator: name }, daemonEntryPath: null, manifest });
  }
  const locatorPath = 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts';
  await mkdir(dirname(join(repoDir, locatorPath)), { recursive: true });
  await writeFile(join(repoDir, locatorPath), `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = ${JSON.stringify(locators)};
export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES = ${JSON.stringify(locators.map(locator => locator.sourceSpec.locator))};`);
  await mkdir(join(repoDir, 'apps/ui'), { recursive: true });
  await writeFile(join(repoDir, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/app', dependencies: {} }));
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await gitIn('add', 'apps/cli', 'apps/ui', 'packages/plugins', 'packages/cli-common');
  await gitIn('commit', '--quiet', '-m', 'voice declarations and real compiler entry');
  await publishFixtureInstall(repoDir);
  const revision = await resolveSourceTreeRevision({ repoDir, treesRoot: fixture.path('trees'), rev: 'HEAD', overlay: [], outputDir: fixture.path('descriptors') });
  // This fixture supplies its own installed OS/tool boundary, never an installer.
  const env = { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
    TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../cli/tsconfig.runtime.json', import.meta.url)),
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: join(repoDir, 'manual-payload') };
  const prepare = component => prepareSourceTreeRuntimeComponents({ repoDir, env, stackBaseDir: fixture.path('stacks/qa'),
    descriptorPath: revision.descriptorPath, components: [{ component }], logger: { error() {} } });
  const { server } = await prepare('server');
  const manifestAt = tree => join(tree, 'packages/plugins/voice-one/dist/happier-plugin-ui/ui-artifacts.json');
  assert.equal(await lstat(manifestAt(dirname(dirname(server.serverDir)))).catch(error => error.code), 'ENOENT',
    'server-only preparation does not compile Plugin UI');
  const { daemon } = await prepare('daemon');
  assert.equal((await lstat(manifestAt(dirname(dirname(daemon.cliDir)))).catch(error => error.code))?.isFile?.(), true,
    'daemon preparation publishes the declared voice graph manifest');
  const { stdout: serverMarker } = await promisify(execFile)(process.execPath, ['--conditions=happier-source', '--input-type=module', '-e',
    'const {pathToFileURL}=await import("node:url"); console.log((await import(pathToFileURL(process.argv[1]))).marker);',
    join(server.serverDir, 'sources/main.light.ts')]);
  assert.equal(serverMarker.trim(), 'committed', 'an existing server clone keeps importing its own workspace after daemon preparation');
  const tree = dirname(dirname(daemon.cliDir));
  const { readGeneratedPluginUiArtifactsManifest } = await import('../../../cli/src/plugins/install/ui/generatedArtifacts.ts');
  const { findGeneratedReactNativeArtifactEntry } = await import('../../../cli/src/plugins/projection/registry/ui/generatedUiArtifactOwners.ts');
  for (const directory of ['voice-one', 'voice-two', 'voice-broken']) {
    const root = join(tree, 'packages/plugins', directory);
    const generated = await readGeneratedPluginUiArtifactsManifest(root);
    const admitted = findGeneratedReactNativeArtifactEntry({ platform: 'web', owner: {
      kind: 'voiceProvider', pluginId: `happier.${directory}`, pluginSource: { kind: 'package' },
      contributionId: 'conversation', artifactId: 'voice-runtime', pluginRootPath: root,
      manifestPath: join(root, '.happier-plugin/plugin.json'), generatedUiArtifactsManifest: generated ?? undefined,
      declaredPlatforms: ['web', 'ios', 'android'], expectedExecutable: { exportName: 'activate' }, requiredHostMethods: [],
    } });
    if (directory === 'voice-broken') {
      assert.equal(admitted.failure, 'generated_react_native_artifact_missing',
        'an optional plugin compiler failure stays typed unavailable without refusing the daemon or its healthy siblings');
      continue;
    }
    assert.ok(generated, `${directory}: the declaration reader must find its generated manifest`);
    assert.equal(admitted.failure, null, `${directory}: generated Voice runtime must be admitted`);
    const entry = admitted.entry;
    assert.equal(entry?.tier, 'reactNative');
    assert.ok(entry.executable.exports.includes('activate'));
    const bytes = await readFile(join(root, 'dist/happier-plugin-ui', entry.entry), 'utf8');
    assert.match(bytes, new RegExp(directory));
  }
  const first = await lstat(manifestAt(tree));
  // Keep the incumbent selected while the replacement prepares, as a reload does.
  await writeFile(fixture.path('stacks/qa/source-runtime/selected-daemon.json'), JSON.stringify({ entrypoint: daemon.entrypoint }));
  const { daemon: again } = await prepare('daemon');
  assert.equal((await lstat(manifestAt(dirname(dirname(again.cliDir))))).ino, first.ino,
    'unchanged daemon trees inherit one prepared base graph');
  assert.equal((await readGeneratedPluginUiArtifactsManifest(join(tree, 'packages/plugins/no-ui')))?.entries.length ?? 0, 0);
  const before = await readFile(manifestAt(tree), 'utf8');
  const changedPath = 'packages/plugins/voice-one/src/voice.ts';
  await writeFile(join(repoDir, changedPath), 'export function activate() { return "changed voice source"; }');
  const changed = await resolveSourceTreeRevision({ repoDir, treesRoot: fixture.path('trees'), rev: 'HEAD', overlay: [changedPath],
    outputDir: fixture.path('changed-descriptors') });
  const { daemon: overlaid } = await prepareSourceTreeRuntimeComponents({ repoDir, env, stackBaseDir: fixture.path('stacks/qa'),
    descriptorPath: changed.descriptorPath, components: [{ component: 'daemon' }], logger: { error() {} } });
  assert.notEqual(await readFile(manifestAt(dirname(dirname(overlaid.cliDir))), 'utf8'), before,
    'a changed executable gets its own newly compiled graph');
  assert.equal(await readFile(manifestAt(tree), 'utf8'), before, 'an overlay never changes an earlier daemon graph');
  const sharedPath = 'packages/shared/src/index.ts';
  await writeFile(join(repoDir, sharedPath), 'export const marker = "changed shared input";');
  const shared = await resolveSourceTreeRevision({ repoDir, treesRoot: fixture.path('trees'), rev: 'HEAD', overlay: [sharedPath],
    outputDir: fixture.path('shared-descriptors') });
  const { daemon: withSharedChange } = await prepareSourceTreeRuntimeComponents({ repoDir, env, stackBaseDir: fixture.path('stacks/qa'),
    descriptorPath: shared.descriptorPath, components: [{ component: 'daemon' }], logger: { error() {} } });
  assert.notEqual(await readFile(manifestAt(dirname(dirname(withSharedChange.cliDir))), 'utf8'), before,
    'a shared dependency overlay recompiles its consuming graph');
  assert.equal(await readFile(manifestAt(tree), 'utf8'), before, 'shared dependency compilation preserves the active daemon graph');
  const preparerPath = 'apps/cli/scripts/prepareSourcePluginUiArtifacts.mjs';
  await writeFile(join(repoDir, preparerPath), await readFile(join(repoDir, preparerPath), 'utf8') + '\n');
  await gitIn('add', preparerPath);
  await gitIn('commit', '--quiet', '-m', 'change the base preparer contract');
  const withNewPreparer = await resolveSourceTreeRevision({ repoDir, treesRoot: fixture.path('trees'), rev: 'HEAD', overlay: [],
    outputDir: fixture.path('preparer-descriptors') });
  assert.equal(withNewPreparer.base, withNewPreparer.revision,
    'base preparation must use the selected revision\'s preparer contract before commit overlays can run');
});

const FIXTURE_SUPPORT_OWNER = `import { createHash } from 'node:crypto';
import { resolveInstalledRuntimePackage } from ${JSON.stringify(new URL('../../../../packages/cli-common/workspaceRuntimeDependencies.mjs', import.meta.url).href)};
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function ensureDaemonSupportArtifact({ stackBaseDir, repoDir, dependencyRootDir }) {
  if (existsSync(join(repoDir, 'node_modules/fixture-dep/package.json'))) {
    resolveInstalledRuntimePackage({ packageName: 'fixture-dep', resolveFromPackageJsonPath: join(repoDir, 'apps/cli/package.json'), dereferenceRootDir: dependencyRootDir });
  }
  const fingerprint = createHash('sha256').update(await readFile(join(repoDir, 'apps/cli/native/version.txt'))).digest('hex');
  const payloadDir = join(stackBaseDir, 'artifacts/daemon-support', fingerprint, 'payload');
  if (!existsSync(payloadDir)) {
    await mkdir(join(payloadDir, 'tools/unpacked'), { recursive: true });
    await writeFile(join(payloadDir, 'tools/unpacked/happier-cliproxyapi-managed'), '#!/bin/sh\\n# ' + fingerprint + '\\n');
    await chmod(join(payloadDir, 'tools/unpacked/happier-cliproxyapi-managed'), 0o755);
    await mkdir(join(payloadDir, 'node_modules/@happier-dev/iroh-native/native'), { recursive: true });
    await writeFile(join(payloadDir, 'node_modules/@happier-dev/iroh-native/native/happier-session-holder'), fingerprint);
    await appendFile(join(stackBaseDir, 'builds.log'), fingerprint + '\\n');
  }
  return { fingerprint, payloadDir };
}
`;

// The dependency owner's publication (the refresh marker) for the checkout's
// installed fixture tree: its current dependency inputs, so a base of a revision
// with the same inputs reuses this installation.
async function publishFixtureInstall(repoDir) {
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  const { installIdentity } = await inspectDependencyRefresh({ installDir: repoDir });
  await writeFile(join(repoDir, 'node_modules/.happier-stack-dependencies-ready'), JSON.stringify({ version: 7, identity: installIdentity }));
}

async function createRevisionFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-revision-tree-', registerCleanup: false });
  t.after(async () => { await setSourceRevisionTreeWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = fixture.path('repo');
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await mkdir(repoDir);
  await gitIn('init', '--quiet');
  await gitIn('config', 'user.email', 'test@example.invalid');
  await gitIn('config', 'user.name', 'test');
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(repoDir, '.gitignore'), 'node_modules\n');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  for (const [directory, name] of [['apps/server', '@happier-dev/server'], ['apps/cli', '@happier-dev/cli'], ['packages/shared', '@happier-dev/shared']]) {
    await mkdir(join(repoDir, directory, 'src'), { recursive: true });
    await writeFile(join(repoDir, directory, 'package.json'), JSON.stringify({ name, type: 'module',
      exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  }
  const server = join(repoDir, 'apps/server');
  await mkdir(join(server, 'sources'));
  await mkdir(join(server, 'scripts'));
  await mkdir(join(server, 'node_modules/@happier-dev'), { recursive: true });
  await writeFile(join(server, 'tsconfig.json'), '{}');
  // A tracked runner file no bundle consumes: a source runtime still needs it.
  await writeFile(join(server, 'scripts/dev.light.ts'), 'export const runner = true;');
  await writeFile(join(server, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(server, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  // The checkout's installed workspace link, as pnpm writes it.
  await symlink('../../../../packages/shared', join(server, 'node_modules/@happier-dev/shared'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(server, 'sources/main.light.ts'), COMMITTED_MAIN);
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export {};\n');
  await writeFile(join(repoDir, 'packages/shared/src/index.ts'), COMMITTED_SHARED);
  // Native support is built by the daemon support owner (Go, Rust and pnpm builds: a
  // system boundary). This stand-in keeps the owner's contract: one artifact per
  // support identity under the store, `tools/unpacked` plus the Iroh `native/` dir.
  await mkdir(join(repoDir, 'packages/cli-common'), { recursive: true });
  await writeFile(join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs'), '// fixture source runtime\n');
  await mkdir(join(repoDir, 'apps/stack/scripts/build'), { recursive: true });
  await writeFile(join(repoDir, 'apps/stack/scripts/build/build_daemon_artifact.mjs'), FIXTURE_SUPPORT_OWNER);
  await mkdir(join(repoDir, 'apps/cli/native'), { recursive: true });
  await writeFile(join(repoDir, 'apps/cli/native/version.txt'), 'native-1');
  // Tree-mechanics fixtures use the supported manual interpreter payload;
  // build_source_guest_payload.test.mjs exercises native payload production.
  await mkdir(join(repoDir, 'manual-payload'));
  await writeFile(join(repoDir, 'manual-payload/happier'), '#!/bin/sh\nexit 0\n');
  // A tracked file outside every component's inputs (like apps/ui for a server/daemon base).
  await mkdir(join(repoDir, 'docs'));
  await writeFile(join(repoDir, 'docs/notes.md'), 'committed notes');
  await gitIn('add', '-A');
  await gitIn('commit', '--quiet', '-m', 'rev');
  await publishFixtureInstall(repoDir);
  // The shared checkout moves: another lane edits a committed file and adds an
  // untracked one; this lane edits the file it declares as its overlay.
  await writeFile(join(repoDir, 'packages/shared/src/index.ts'), 'export const marker = "other-lane";');
  await writeFile(join(repoDir, 'packages/shared/src/new.ts'), 'export const added = "other-lane";');
  await writeFile(join(server, 'sources/main.light.ts'), 'export const marker = "my-overlay";');
  return { fixture, repoDir };
}

// Owner 2026-11-14: one shared base per HEAD, each Stack's overlay applied at
// runtime from source. Stacks on one revision with different overlays must not
// rebuild anything shared; only their declared files differ.
test('a described revision base inventories its selected manifests after the live checkout changes', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const revision = await resolveSourceRevision({ repoDir, outputDir: fixture.path('descriptors'), fullTree: true });
  await writeFile(join(repoDir, 'apps/cli/package.json'), '{"dependencies":');
  const tree = await prepareStackSourceRevisionTree({ repoDir, treesRoot: fixture.path('trees'),
    treeDir: fixture.path('stacks/qa/tree'), descriptorPath: revision.descriptorPath });
  assert.equal(await readFile(join(tree.treeDir, 'packages/shared/src/index.ts'), 'utf8'), COMMITTED_SHARED);
  assert.equal(JSON.parse(await readFile(join(tree.treeDir, 'apps/cli/package.json'), 'utf8')).name, '@happier-dev/cli');
});

test('stacks on one revision share one base tree; each runs only its own declared overlay', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const treesRoot = fixture.path('trees');
  const prepare = async (stack, overlay) => {
    const revision = await resolveSourceRevision({ repoDir, overlay, outputDir: fixture.path(`descriptors-${stack}`),
      components: ['server', 'daemon'], fullTree: true });
    return await prepareStackSourceRevisionTree({ repoDir, treesRoot, treeDir: fixture.path(`stacks/${stack}/tree`),
      descriptorPath: revision.descriptorPath });
  };
  const a = await prepare('a', []);
  const b = await prepare('b', ['apps/server/sources/main.light.ts']);
  const c = await prepare('c', []);
  assert.deepEqual([a.baseBuilt, b.baseBuilt, c.baseBuilt].filter(Boolean).length, 1, 'one base build for one revision');
  assert.equal(a.baseDir, b.baseDir);
  assert.deepEqual([a.overlaid, b.overlaid, c.overlaid], [0, 1, 0]);

  const read = (tree, path) => readFile(join(tree, path), 'utf8');
  assert.equal(await read(a.treeDir, 'apps/server/sources/main.light.ts'), COMMITTED_MAIN);
  assert.equal(await read(b.treeDir, 'apps/server/sources/main.light.ts'), 'export const marker = "my-overlay";');
  assert.equal(await read(a.baseDir, 'apps/server/sources/main.light.ts'), COMMITTED_MAIN, 'an overlay never writes through to the base');
  for (const tree of [a.treeDir, b.treeDir, a.baseDir]) {
    // Isolation: another lane's dirty and untracked files never enter a tree.
    assert.equal(await read(tree, 'packages/shared/src/index.ts'), COMMITTED_SHARED);
    assert.equal(await lstat(join(tree, 'packages/shared/src/new.ts')).catch(error => error.code), 'ENOENT');
    // A source runtime gets the whole tracked tree, not only bundle inputs.
    assert.equal(await read(tree, 'apps/server/scripts/dev.light.ts'), 'export const runner = true;');
    // Workspace imports resolve inside the tree; installed packages stay shared.
    assert.equal(await realpath(join(tree, 'apps/server/node_modules/@happier-dev/shared')), await realpath(join(tree, 'packages/shared')));
  }
  // Clones share the base's bytes instead of copying them.
  const [baseInfo, cloneInfo] = await Promise.all([lstat(join(a.baseDir, 'packages/shared/src/index.ts')),
    lstat(join(c.treeDir, 'packages/shared/src/index.ts'))]);
  assert.equal(cloneInfo.ino, baseInfo.ino);
});

test('a cold source reload prepares one shared base for the server and daemon', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const descriptor = await resolveSourceTreeRevision({ repoDir, treesRoot: fixture.path('trees'),
    rev: 'HEAD', overlay: [], outputDir: fixture.path('descriptors') });
  const prepare = stack => prepareSourceTreeRuntimeComponents({ repoDir, stackBaseDir: fixture.path(`stacks/${stack}`),
    descriptorPath: descriptor.descriptorPath, components: [{ component: 'server' }, { component: 'daemon' }],
    env: { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: join(repoDir, 'manual-payload') }, logger: { error() {} } });

  const cold = await prepare('cold');
  const warm = await prepare('warm');
  const countBaseBuilds = roles => Object.values(roles).filter(role => role.sourceTree.baseBuilt).length;
  assert.equal(cold.server.sourceCapture.inputIdentity, cold.daemon.sourceCapture.inputIdentity);
  assert.equal(countBaseBuilds(cold), 1);
  assert.equal(countBaseBuilds(warm), 0);
});

test('a daemon revision tree resolves runtime dependencies only within the tree and its declared install', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const guard = 'packages/cli-common/workspaceRuntimeDependencies.mjs';
  await cp(new URL(`../../../../${guard}`, import.meta.url), join(repoDir, guard));
  await promisify(execFile)('git', ['-C', repoDir, 'add', guard]);
  await promisify(execFile)('git', ['-C', repoDir, 'commit', '--quiet', '-m', 'runtime dependency guard']);
  await cp(dirname(createRequire(import.meta.url).resolve('semver/package.json')), join(repoDir, 'node_modules/semver'), { recursive: true });
  const stackBaseDir = fixture.path('stacks/daemon');
  for (const [root, name] of [[repoDir, 'tweetnacl'], [stackBaseDir, 'outside-dep']]) {
    const packageDir = join(root, 'node_modules', name);
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.3' }));
  }
  const descriptor = await resolveSourceTreeRevision({ repoDir, treesRoot: sourceRevisionTreesRoot(stackBaseDir),
    rev: 'HEAD', overlay: [], outputDir: fixture.path('descriptors') });
  const { daemon } = await prepareSourceTreeRuntimeComponents({ repoDir, stackBaseDir,
    descriptorPath: descriptor.descriptorPath, components: [{ component: 'daemon' }],
    env: { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: join(repoDir, 'manual-payload') }, logger: { error() {} } });
  const treeDir = daemon.sourceTree.dir;
  const { resolveInstalledRuntimePackage } = await import(pathToFileURL(join(treeDir, guard)).href);
  const resolveFromPackageJsonPath = join(daemon.cliDir, 'package.json');
  const resolveDependency = (packageName, dereferenceRootDir) => resolveInstalledRuntimePackage({
    packageName, resolveFromPackageJsonPath, dereferenceRootDir,
  }).packageDir;

  assert.equal(await realpath(resolveDependency('outside-dep')), await realpath(join(stackBaseDir, 'node_modules/outside-dep')));
  assert.throws(() => resolveDependency('outside-dep', treeDir), /outside the caller-approved root/u);
  assert.throws(() => resolveDependency('tweetnacl', daemon.cliDir), /outside the caller-approved root/u);
  assert.equal(await realpath(resolveDependency('tweetnacl', treeDir)), await realpath(join(treeDir, 'node_modules/tweetnacl')));
});

test('a declared overlay keeps its selected bytes when the checkout moves after description', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const added = 'apps/server/sources/selected-new.ts';
  await writeFile(join(repoDir, added), 'export const selected = true;');
  const revision = await resolveSourceRevision({ repoDir, overlay: ['apps/server/sources/main.light.ts', added],
    outputDir: fixture.path('descriptors'), components: ['server', 'daemon'], fullTree: true });
  await writeFile(join(repoDir, 'apps/server/sources/main.light.ts'), 'export const marker = "edited-after";');
  await rm(join(repoDir, added));
  const tree = await prepareStackSourceRevisionTree({ repoDir, treesRoot: fixture.path('trees'),
    treeDir: fixture.path('stack/tree'), descriptorPath: revision.descriptorPath });
  assert.equal(await readFile(join(tree.treeDir, 'apps/server/sources/main.light.ts'), 'utf8'),
    'export const marker = \"my-overlay\";');
  assert.equal(await readFile(join(repoDir, 'apps/server/sources/main.light.ts'), 'utf8'),
    'export const marker = "edited-after";');
  assert.equal(await readFile(join(tree.treeDir, added), 'utf8'), 'export const selected = true;');
  assert.equal(await lstat(join(repoDir, added)).catch(error => error.code), 'ENOENT');
});

test('an overlay changed during description refuses before its bytes are shipped', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const path = 'apps/server/sources/main.light.ts';
  const identity = await resolveSourceRevisionIdentity({ repoDir, overlay: [path] });
  await writeFile(join(repoDir, path), 'export const marker = "changed-during-description";');
  await assert.rejects(writeSourceRevisionDescriptor({ repoDir, identity, fullTree: true,
    outputDir: fixture.path('descriptors') }), { code: 'BUILD_INPUTS_CHANGED' });
});

// HEAD moves every few minutes on the shared checkout. A reload at a newer commit
// runs the newest built base plus that commit's changes as overlay; only a change
// to the installed-dependency shape needs a new base.
test('reloads at later commits run the existing base plus the commit diff; a dependency change builds one new base', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  // Discard the moving-checkout edits from the shared fixture; this test moves HEAD.
  await gitIn('checkout', '--quiet', '--', '.');
  await gitIn('clean', '-fdq');
  const treesRoot = fixture.path('trees');
  let reloads = 0;
  const reload = async () => {
    const stack = `s${reloads += 1}`;
    const revision = await resolveSourceTreeRevision({ repoDir, treesRoot, rev: 'HEAD', overlay: [],
      outputDir: fixture.path(`descriptors-${stack}`) });
    return await prepareStackSourceRevisionTree({ repoDir, treesRoot, treeDir: fixture.path(`stacks/${stack}/tree`),
      descriptorPath: revision.descriptorPath });
  };
  const first = await reload();
  const commitEdit = async (path, text) => {
    await writeFile(join(repoDir, path), text);
    await gitIn('commit', '--quiet', '-am', path);
  };
  await commitEdit('packages/shared/src/index.ts', 'export const marker = "second-commit";');
  const second = await reload();
  await commitEdit('apps/server/sources/main.light.ts', 'export const marker = "third-commit";');
  const third = await reload();
  assert.deepEqual([first.baseBuilt, second.baseBuilt, third.baseBuilt], [true, false, false]);
  assert.equal(second.baseDir, first.baseDir);
  assert.equal(await readFile(join(second.treeDir, 'packages/shared/src/index.ts'), 'utf8'), 'export const marker = "second-commit";');
  assert.equal(await readFile(join(third.treeDir, 'apps/server/sources/main.light.ts'), 'utf8'), 'export const marker = "third-commit";');
  assert.equal(await readFile(join(first.baseDir, 'packages/shared/src/index.ts'), 'utf8'), COMMITTED_SHARED, 'the base keeps its own revision');
  // The installed dependency closure is part of the base: a manifest change rebases.
  await commitEdit('packages/shared/package.json', JSON.stringify({ name: '@happier-dev/shared', type: 'module', dependencies: { esbuild: '*' },
    exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  const fourth = await reload();
  assert.equal(fourth.baseBuilt, true);
  assert.notEqual(fourth.baseDir, first.baseDir);
});

// Disk: a base is ~2 GB. Keep one only while a Stack tree, or the host's newest
// base, references it; release happens on Stack stop and on new-base creation.
test('a base is deleted when its last Stack reference goes, and the newest base is kept', { skip: process.platform === 'win32' }, async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await gitIn('checkout', '--quiet', '--', '.');
  await gitIn('clean', '-fdq');
  const treesRoot = fixture.path('trees');
  const treeOf = stack => fixture.path(`stacks/${stack}/tree`);
  let described = 0;
  const reload = async stack => {
    const revision = await resolveSourceTreeRevision({ repoDir, treesRoot, rev: 'HEAD', overlay: [],
      outputDir: fixture.path(`descriptors-${described += 1}`) });
    return await prepareStackSourceRevisionTree({ repoDir, treesRoot, treeDir: treeOf(stack), descriptorPath: revision.descriptorPath });
  };
  const bases = async () => (await readdir(treesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{40}$/.test(entry.name)).map(entry => entry.name).sort();
  const first = await reload('a');
  await reload('b');
  // A dependency-shape commit makes a new base; a and b still hold the first.
  await writeFile(join(repoDir, 'packages/shared/package.json'), JSON.stringify({ name: '@happier-dev/shared', type: 'module', version: '2.0.0' }));
  await gitIn('commit', '--quiet', '-am', 'manifest');
  const second = await reload('c');
  assert.equal(second.baseBuilt, true);
  assert.deepEqual((await bases()).length, 2);
  // Stack a moves to the new base; b still references the first.
  await reload('a');
  assert.deepEqual(await bases(), [first.baseDir, second.baseDir].map(dir => dir.split(/[\\/]/).pop()).sort());
  // The last reference stops: the first base goes, the newest stays.
  await releaseStackSourceRevisionTree({ treesRoot, treeDir: treeOf('b') });
  assert.deepEqual(await bases(), [second.baseDir.split(/[\\/]/).pop()]);
  assert.equal(await lstat(treeOf('b')).catch(error => error.code), 'ENOENT');
  // With no Stack left, the host's newest base is kept for the next reload.
  await releaseStackSourceRevisionTree({ treesRoot, treeDir: treeOf('a') });
  await releaseStackSourceRevisionTree({ treesRoot, treeDir: treeOf('c') });
  assert.deepEqual(await bases(), [second.baseDir.split(/[\\/]/).pop()]);
});

// nl3 2026-11-17 (P03-NL3-DISK): 25 bases (63 GiB) had no marker. Their builds failed
// (pnpm, ENOSPC) or were killed after the staging rename, and the sweep only saw
// published bases, so nothing ever retired them. A builder holds the base lock until
// it publishes; an unpublished base or staging directory no live builder holds goes.
test('the base sweep retires unpublished bases and staging that no live builder holds', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-revision-unpublished-' });
  const treesRoot = fixture.path('trees');
  const exited = spawn(process.execPath, ['-e', '']);
  await once(exited, 'exit');
  const lock = (dir, pid) => writeFile(`${dir}.lock`, JSON.stringify({ pid, createdAtMs: Date.now(), updatedAtMs: Date.now() }));
  const abandoned = join(treesRoot, 'a'.repeat(40));
  const killed = join(treesRoot, 'b'.repeat(40));
  const building = join(treesRoot, 'c'.repeat(40));
  const staging = `${join(treesRoot, 'd'.repeat(40))}.tmp-0f6c9a5e-4d8b-4e43-9a27-5d3f0f6b9e11`;
  for (const dir of [abandoned, killed, building, staging]) {
    await mkdir(join(dir, 'apps'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{}');
  }
  await lock(killed, exited.pid);
  await lock(building, process.pid);
  await sweepSourceRevisionBases({ treesRoot });
  const exists = dir => lstat(dir).then(() => true, () => false);
  assert.equal(await exists(abandoned), false, 'a failed build without a lock is retired');
  assert.equal(await exists(killed), false, 'a killed builder\'s base is retired');
  assert.equal(await exists(staging), false, 'a killed builder\'s staging is retired');
  assert.equal(await exists(building), true, 'a live builder keeps its unpublished base');
});

// nl3 2026-11-15 (P03-INFRA-OPS run 1): a mirror host has no Git objects. Its base
// copied the moving mirror and refused BUILD_INPUTS_CHANGED when another lane edited
// a tracked file the description shipped no bytes for. A base takes every tracked
// byte from the revision's Git objects: here, the controller's archive of it.
test('a mirror without Git objects builds its base from the revision archive, never from moving mirror bytes', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const revision = await resolveSourceRevision({ repoDir, overlay: ['apps/server/sources/main.light.ts'],
    outputDir: fixture.path('descriptors'), components: ['server', 'daemon'], fullTree: true });
  // The host's replica: the working tree (with its install) and a `.git` entry without objects.
  const mirror = fixture.path('mirror');
  await cp(repoDir, mirror, { recursive: true, verbatimSymlinks: true });
  await rm(join(mirror, '.git'), { recursive: true, force: true });
  await mkdir(join(mirror, '.git'));
  // Other lanes keep editing after the description: a tracked runner file and a committed input.
  await writeFile(join(mirror, 'apps/server/scripts/dev.light.ts'), 'export const runner = "edited-after";');
  await writeFile(join(mirror, 'packages/shared/src/index.ts'), 'export const marker = "edited-after";');
  await writeFile(join(mirror, 'docs/notes.md'), 'edited after the description');
  const archives = [];
  const requestBaseArchive = async ({ revision: requested, path }) => {
    archives.push(requested);
    await writeSourceRevisionArchive({ repoDir, revision: requested, outputPath: path });
  };
  const treesRoot = fixture.path('mirror-trees');
  const prepare = stack => prepareStackSourceRevisionTree({ repoDir: mirror, treesRoot, treeDir: fixture.path(`mirror-stacks/${stack}/tree`),
    descriptorPath: revision.descriptorPath, requestBaseArchive });
  const a = await prepare('a');
  const b = await prepare('b');
  assert.deepEqual([a.baseBuilt, b.baseBuilt], [true, false]);
  assert.deepEqual(archives, [revision.revision], 'one archive per base per host');
  const read = (tree, path) => readFile(join(tree, path), 'utf8');
  for (const tree of [a.baseDir, a.treeDir]) {
    assert.equal(await read(tree, 'apps/server/scripts/dev.light.ts'), 'export const runner = true;');
    assert.equal(await read(tree, 'packages/shared/src/index.ts'), COMMITTED_SHARED);
    assert.equal(await read(tree, 'docs/notes.md'), 'committed notes');
    assert.equal(await lstat(join(tree, 'packages/shared/src/new.ts')).catch(error => error.code), 'ENOENT');
  }
  assert.equal(await read(a.baseDir, 'apps/server/sources/main.light.ts'), COMMITTED_MAIN);
  // The declared overlay alone comes from the (mirror) checkout, verified against its recorded hash.
  assert.equal(await read(a.treeDir, 'apps/server/sources/main.light.ts'), 'export const marker = "my-overlay";');
  assert.deepEqual((await readdir(treesRoot)).filter(name => name.includes('.archive-')), [], 'the shipped archive is deleted after use');
});

// agent-qa-perf 2026-11-15 (P03-INFRA-OPS run 2): the restart's stop released the
// tree the reload had just selected, so the runner refused source_bundle_unavailable.
test('a restart onto a new tree keeps the tree it selected; stop releases only the incumbent', { skip: process.platform === 'win32' }, async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await gitIn('checkout', '--quiet', '--', '.');
  await gitIn('clean', '-fdq');
  const stackBaseDir = fixture.path('stacks-root/qa');
  const selection = join(stackBaseDir, 'source-runtime/selected-server.json');
  let described = 0;
  const reload = async () => {
    const revision = await resolveSourceTreeRevision({ repoDir, treesRoot: sourceRevisionTreesRoot(stackBaseDir), rev: 'HEAD', overlay: [],
      outputDir: fixture.path(`descriptors-${described += 1}`) });
    const { server } = await prepareSourceTreeRuntimeComponents({ repoDir, env: { ...process.env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: join(repoDir, 'manual-payload') }, stackBaseDir, descriptorPath: revision.descriptorPath,
      components: [{ component: 'server' }], logger: { error() {} } });
    return server;
  };
  const select = async record => { await mkdir(dirname(selection), { recursive: true }); await writeFile(selection, JSON.stringify({ entrypoint: record.entrypoint })); };
  const incumbent = await reload();
  await select(incumbent);
  await writeFile(join(repoDir, 'apps/server/sources/main.light.ts'), 'export const marker = "next-commit";');
  await gitIn('commit', '--quiet', '-am', 'next');
  const replacement = await reload();
  // The incumbent keeps running from its own tree while the replacement prepares.
  assert.equal(await lstat(incumbent.entrypoint).then(() => true, () => false), true, 'preparing never deletes the running tree');
  assert.notEqual(replacement.serverDir, incumbent.serverDir);
  // A stop while that reload is still in flight keeps its finished, not yet selected tree.
  const inFlight = await beginPendingSourceStart({ stackBaseDir });
  try {
    await releaseStackSourceTrees({ stackBaseDir, components: ['server'] });
    assert.equal(await lstat(replacement.entrypoint).then(() => true, () => false), true, 'an in-flight reload keeps its tree');
  } finally { await inFlight.dispose(); }
  // Restart order: select the replacement, then stop the incumbent.
  await select(replacement);
  await releaseStackSourceTrees({ stackBaseDir, components: ['server'] });
  assert.equal(await lstat(replacement.entrypoint).then(() => true, () => false), true, 'the selected tree stays');
  assert.equal(await readFile(join(replacement.serverDir, 'sources/main.light.ts'), 'utf8'), 'export const marker = "next-commit";');
  assert.equal(JSON.parse(await readFile(selection, 'utf8')).entrypoint, replacement.entrypoint, 'the selection stays');
  assert.equal(await lstat(incumbent.serverDir).catch(error => error.code), 'ENOENT', 'the incumbent tree is released');
  // A later plain stop keeps the selected tree for the next start.
  await releaseStackSourceTrees({ stackBaseDir, components: ['server'] });
  assert.equal(await lstat(replacement.entrypoint).then(() => true, () => false), true);
});

// 2026-11-17 (P03-ACTIVATION-SWAP): the PostgreSQL and MySQL deploy scripts run only
// when invoked as the process entry, so importing them from the tree's launcher
// deployed nothing and exited 0. A bundle rewrites import.meta.url; a tree calls them.
test('a source tree migration launcher runs the provider deploy, not only its import', { skip: process.platform === 'win32' }, async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await gitIn('checkout', '--quiet', '--', '.');
  await gitIn('clean', '-fdq');
  const witness = fixture.path('deployed');
  for (const [script, exported] of [['full', 'runPostgresMigrationDeploy'], ['mysql', 'runMysqlMigrationDeployMain']]) {
    await writeFile(join(repoDir, `apps/server/scripts/migrate.${script}.deploy.ts`), `import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export async function ${exported}() { appendFileSync(${JSON.stringify(witness)}, '${script}\\n'); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await ${exported}();
`);
  }
  await gitIn('add', '-A');
  await gitIn('commit', '--quiet', '-m', 'deploy scripts');
  const stackBaseDir = fixture.path('stacks-root/qa');
  for (const dbProvider of ['postgres', 'mysql']) {
    const revision = await resolveSourceTreeRevision({ repoDir, treesRoot: sourceRevisionTreesRoot(stackBaseDir), rev: 'HEAD', overlay: [],
      outputDir: fixture.path(`descriptors-${dbProvider}`) });
    const { server } = await prepareSourceTreeRuntimeComponents({ repoDir, env: { ...process.env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: join(repoDir, 'manual-payload') }, stackBaseDir, descriptorPath: revision.descriptorPath,
      components: [{ component: 'server', dbProvider }], logger: { error() {} } });
    await promisify(execFile)(process.execPath, [server.migration.command], { cwd: server.migration.cwd });
  }
  assert.deepEqual((await readFile(witness, 'utf8')).trim().split('\n'), ['full', 'mysql']);
});

// P03 ORCH 2026-11-17: a replacement that fails readiness after retirement restarts
// the incumbent's revision, so the retirement stop keeps that tree until the reload settles.
test('the retirement stop keeps the incumbent tree a pending reload rollback names', { skip: process.platform === 'win32' }, async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await gitIn('checkout', '--quiet', '--', '.');
  await gitIn('clean', '-fdq');
  const stackBaseDir = fixture.path('stacks-root/qa');
  const selection = join(stackBaseDir, 'source-runtime/selected-server.json');
  let described = 0;
  const reload = async () => {
    const revision = await resolveSourceTreeRevision({ repoDir, treesRoot: sourceRevisionTreesRoot(stackBaseDir), rev: 'HEAD', overlay: [],
      outputDir: fixture.path(`descriptors-${described += 1}`) });
    const { server } = await prepareSourceTreeRuntimeComponents({ repoDir, env: { ...process.env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: join(repoDir, 'manual-payload') }, stackBaseDir, descriptorPath: revision.descriptorPath,
      components: [{ component: 'server' }], logger: { error() {} } });
    return server;
  };
  const select = async record => { await mkdir(dirname(selection), { recursive: true }); await writeFile(selection, JSON.stringify({ entrypoint: record.entrypoint })); };
  const incumbent = await reload();
  await select(incumbent);
  await writeFile(join(repoDir, 'apps/server/sources/main.light.ts'), 'export const marker = "next-commit";');
  await gitIn('commit', '--quiet', '-am', 'next');
  const replacement = await reload();
  const { recordSourceSelectionRollback, settleSourceSelectionRollback } = await import('../runtime/shared/source_selection_rollback.mjs');
  await recordSourceSelectionRollback({ stackBaseDir });
  await select(replacement);
  await releaseStackSourceTrees({ stackBaseDir, components: ['server'] });
  assert.equal(await lstat(incumbent.entrypoint).then(() => true, () => false), true, 'the rollback revision survives retirement');
  await settleSourceSelectionRollback({ stackBaseDir });
  await releaseStackSourceTrees({ stackBaseDir, components: ['server'] });
  assert.equal(await lstat(incumbent.serverDir).catch(error => error.code), 'ENOENT', 'a settled reload releases the incumbent tree');
  assert.equal(await lstat(replacement.entrypoint).then(() => true, () => false), true);
});

// nl3 2026-11-17 (P03-NL3-DISK): beds that are reloaded but rarely stopped kept every
// refused reload's tree (pfc1113-bed: 5 of 7 trees, ~2.8 GiB each), and those trees
// pinned their bases. The Stack's next preparation releases them; the selected tree stays.
test('a later preparation releases a refused reload\'s tree and keeps the selected one', { skip: process.platform === 'win32' }, async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await gitIn('checkout', '--quiet', '--', '.');
  await gitIn('clean', '-fdq');
  const stackBaseDir = fixture.path('stacks-root/qa');
  let described = 0;
  const reload = async () => {
    const revision = await resolveSourceTreeRevision({ repoDir, treesRoot: sourceRevisionTreesRoot(stackBaseDir), rev: 'HEAD', overlay: [],
      outputDir: fixture.path(`descriptors-${described += 1}`) });
    const { server } = await prepareSourceTreeRuntimeComponents({ repoDir, env: { ...process.env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: join(repoDir, 'manual-payload') }, stackBaseDir, descriptorPath: revision.descriptorPath,
      components: [{ component: 'server' }], logger: { error() {} } });
    return server;
  };
  const selected = await reload();
  await writeFile(join(stackBaseDir, 'source-runtime/selected-server.json'), JSON.stringify({ entrypoint: selected.entrypoint }));
  const refused = await reload();
  // The next reload runs under its own pending request, as every reload does.
  const pending = await beginPendingSourceStart({ stackBaseDir });
  let next;
  try { next = await reload(); } finally { await pending.dispose(); }
  const exists = path => lstat(path).then(() => true, () => false);
  assert.equal(await exists(refused.serverDir), false, 'the refused reload\'s tree is released');
  assert.equal(await exists(selected.entrypoint), true, 'the selected tree stays');
  assert.equal(await exists(next.entrypoint), true, 'the new preparation keeps its own tree');
});

// 2026-11-15: a runtime labelled with a clean revision ran clients generated from
// another lane's uncommitted schema. A base's generated clients come from its own
// revision; a committed schema change cannot ride a commit overlay over them.
test('a base derives generated server clients from its revision schema; a committed schema change builds a new base', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await writeFile(join(repoDir, '.gitignore'), 'node_modules\napps/server/generated/\n');
  await installServerGeneratorFixture(repoDir);
  // nl3 reload 170d: Prisma 7 is installed at the server workspace, not the root.
  // The third-party generator boundary must resolve its tools from that workspace.
  const generatorPath = join(repoDir, 'apps/server/scripts/generateClients.ts');
  await writeFile(generatorPath, `import { createRequire } from 'node:module';
createRequire(import.meta.url)('prisma/build/index.js');
` + await readFile(generatorPath, 'utf8'));
  await mkdir(join(repoDir, 'apps/server/node_modules/prisma/build'), { recursive: true });
  await writeFile(join(repoDir, 'apps/server/node_modules/prisma/build/index.js'), 'module.exports = {};');
  await gitIn('add', '.gitignore', 'apps/server/scripts', 'apps/server/prisma');
  await gitIn('commit', '--quiet', '-m', 'schema');
  // Another lane's uncommitted schema edit, generated into the shared checkout.
  await writeServerSchemas(repoDir, FIXTURE_MACHINE_SCHEMA.replace('  id String\n', '  id String\n  metadataBytes Bytes\n'));
  await generateServerClients(repoDir);
  const treesRoot = fixture.path('trees');
  let reloads = 0;
  const reload = async () => {
    const stack = `s${reloads += 1}`;
    const revision = await resolveSourceTreeRevision({ repoDir, treesRoot, rev: 'HEAD', overlay: [],
      outputDir: fixture.path(`descriptors-${stack}`) });
    return await prepareStackSourceRevisionTree({ repoDir, treesRoot, treeDir: fixture.path(`stacks/${stack}/tree`),
      descriptorPath: revision.descriptorPath });
  };
  // An installed dependency: the base must mount the pinned snapshot, even after
  // the client generator borrowed the checkout's installed tools (2026-11-16
  // base 81d8bc8: node_modules/diff linked into the checkout, so every reload
  // refused "outside the caller-approved root").
  await mkdir(join(repoDir, 'node_modules/fixture-dep'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules/fixture-dep/package.json'), JSON.stringify({ name: 'fixture-dep' }));
  // pnpm task-state files are transient runner state, not installed packages.
  await mkdir(join(repoDir, 'node_modules/.pnpm-task-run-state-v1'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules/.pnpm-task-run-state-v1/task.jsonl'), '{}');
  const first = await reload();
  assert.equal(await lstat(join(treesRoot, 'installs', first.installIdentity, 'node_modules/.pnpm-task-run-state-v1')).catch(error => error.code), 'ENOENT');
  assert.deepEqual(await readGeneratedClientFields(first.treeDir), { default: ['id'], sqlite: ['id'], mysql: ['id'] });
  const mounted = await realpath(join(first.treeDir, 'node_modules/fixture-dep'));
  assert.ok(!mounted.startsWith(`${await realpath(repoDir)}/`), `the base mounts the installation snapshot, not the checkout (${mounted})`);
  assert.deepEqual((await readGeneratedClientFields(repoDir)).default, ['id', 'metadataBytes'], 'the checkout keeps its own clients');
  const committed = FIXTURE_MACHINE_SCHEMA.replace('  id String\n', '  id String\n  name String\n');
  await writeServerSchemas(repoDir, committed);
  await gitIn('commit', '--quiet', '-m', 'name', '--', 'apps/server/prisma');
  await generateServerClients(repoDir);
  const second = await reload();
  assert.equal(second.baseBuilt, true);
  assert.deepEqual(await readGeneratedClientFields(second.treeDir), { default: ['id', 'name'], sqlite: ['id', 'name'], mysql: ['id', 'name'] });
});

// 2026-11-16: untracked authored files (other lanes' vault plugin, new migrations)
// rode into reloads through a package's shipped `files` directories. A base keeps
// only ignored generated outputs there, the same rule a revision capture applies.
test('a base never takes untracked authored files under a shipped package directory', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await gitIn('checkout', '--quiet', '--', '.');
  await gitIn('clean', '-fdq');
  const manifestPath = join(repoDir, 'packages/shared/package.json');
  await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await readFile(manifestPath, 'utf8')), files: ['src', 'dist'] }));
  await writeFile(join(repoDir, '.gitignore'), 'node_modules\ndist\n');
  await gitIn('commit', '--quiet', '-am', 'ship src and dist');
  await writeFile(join(repoDir, 'packages/shared/src/leak.ts'), 'export const leaked = "other-lane";');
  const revision = await resolveSourceTreeRevision({ repoDir, treesRoot: fixture.path('trees'), rev: 'HEAD', overlay: [],
    outputDir: fixture.path('descriptors') });
  const tree = await prepareStackSourceRevisionTree({ repoDir, treesRoot: fixture.path('trees'), treeDir: fixture.path('stack/tree'),
    descriptorPath: revision.descriptorPath });
  assert.equal(await lstat(join(tree.baseDir, 'packages/shared/src/leak.ts')).catch(error => error.code), 'ENOENT');
});

// 2026-11-15 16:47Z (Usage): a tree daemon's real Agent start failed with
// plugin_packaged_runtime_binary_unavailable: trees carried source but none of the
// native runtime support. Each tree takes it from the support owner, built once per
// support identity, inside the tree's real path (resolvers refuse links out of it).
test('a Stack tree carries the native runtime support inside its own path; one build per support identity', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await gitIn('checkout', '--quiet', '--', '.');
  await gitIn('clean', '-fdq');
  const treesRoot = fixture.path('trees');
  const prepare = async stack => {
    const revision = await resolveSourceTreeRevision({ repoDir, treesRoot, rev: 'HEAD', overlay: [], outputDir: fixture.path(`descriptors-${stack}`) });
    return await prepareStackSourceRevisionTree({ repoDir, treesRoot, treeDir: fixture.path(`stacks/${stack}/tree`), descriptorPath: revision.descriptorPath });
  };
  const builds = async () => (await readFile(join(treesRoot, 'daemon-support-store/builds.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const a = await prepare('a');
  const b = await prepare('b');
  for (const tree of [a.treeDir, b.treeDir]) {
    const binary = join(tree, 'apps/cli/tools/unpacked/happier-cliproxyapi-managed');
    const info = await lstat(binary);
    assert.equal(info.isFile(), true, 'a regular file, not a link out of the runtime root');
    assert.equal((await realpath(binary)).startsWith(await realpath(tree)), true);
    assert.equal(await lstat(join(tree, 'packages/iroh-native/native/happier-session-holder')).then(entry => entry.isFile()), true);
  }
  assert.equal((await builds()).length, 1, 'one support build for one identity');
  // A commit that changes the native inputs gives the next tree its own support.
  await writeFile(join(repoDir, 'apps/cli/native/version.txt'), 'native-2');
  await gitIn('commit', '--quiet', '-am', 'native change');
  const c = await prepare('c');
  assert.equal((await builds()).length, 2);
  assert.notEqual(await readFile(join(c.treeDir, 'packages/iroh-native/native/happier-session-holder'), 'utf8'),
    await readFile(join(a.treeDir, 'packages/iroh-native/native/happier-session-holder'), 'utf8'));
});

// 2026-11-16: QA Stacks reload onto trees by default; the producer keeps bundles;
// HAPPIER_STACK_SOURCE_TREES=0 is the one-day rollback, =1 forces trees.
test('QA Stacks select source trees by default; the producer keeps bundles; the Stack flag rolls back or forces', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-tree-default-' });
  const storage = fixture.path('stacks');
  const env = extra => ({ HAPPIER_STACK_STORAGE_DIR: storage, HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'repo-producer', ...extra });
  const select = (stack, extra = {}) => selectsSourceTreeReload({ stackBaseDir: join(storage, stack), repoDir: fixture.root, env: env(extra) });
  assert.equal(select('agent-qa-sample'), true);
  assert.equal(select('agent-qa-sample', { HAPPIER_STACK_SOURCE_TREES: '0' }), false);
  assert.equal(select('repo-producer'), false);
  assert.equal(select('repo-producer', { HAPPIER_STACK_SOURCE_TREES: '1' }), true);
});

// r1116b: the source daemon's canonical Voice loader found no packaged runtime
// entry even though its authored private import was present in the revision.
test('daemon source trees expose declared private CLI runtime entries from their own revision', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const cli = join(repoDir, 'apps/cli');
  const source = 'src/daemon/voiceInference/runtime/packagedVoiceInferenceRuntime.ts';
  await mkdir(dirname(join(cli, source)), { recursive: true });
  await writeFile(join(cli, source), 'export const voiceInferenceRuntimeEngine = { revision: "committed" };');
  await writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', imports: {
    '#voice-inference-runtime': { 'happier-source': './' + source, default: './dist/daemon/voiceInference/runtime/packagedVoiceInferenceRuntime.mjs' },
    '#process-census': { 'happier-source': './src/processCensus.ts', default: './dist/processCensus.mjs' },
  } }));
  await writeFile(join(cli, 'src/processCensus.ts'), 'export const census = "committed sibling";');
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await gitIn('add', 'apps/cli');
  await gitIn('commit', '--quiet', '-m', 'private runtime entries');
  await publishFixtureInstall(repoDir);
  // A competing checkout edit must never leak through the generated entry.
  await writeFile(join(cli, source), 'export const voiceInferenceRuntimeEngine = { revision: "foreign dirty" };');
  const revision = await resolveSourceTreeRevision({ repoDir, treesRoot: fixture.path('trees'), rev: 'HEAD', overlay: [], outputDir: fixture.path('descriptors') });
  const { daemon } = await prepareSourceTreeRuntimeComponents({ repoDir, env: { ...process.env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: join(repoDir, 'manual-payload') }, stackBaseDir: fixture.path('stacks/qa'),
    descriptorPath: revision.descriptorPath, components: [{ component: 'daemon' }], logger: { error() {} } });
  const entry = join(daemon.cliDir, 'package-dist/daemon/voiceInference/runtime/packagedVoiceInferenceRuntime.mjs');
  const sibling = join(daemon.cliDir, 'package-dist/processCensus.mjs');
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `const { pathToFileURL } = await import("node:url"); const voice = await import(pathToFileURL(process.argv[1])); const census = await import(pathToFileURL(process.argv[2])); console.log(JSON.stringify([voice.voiceInferenceRuntimeEngine.revision, census.census]));`, entry, sibling]);
  assert.deepEqual(JSON.parse(stdout), ['committed', 'committed sibling']);
});

// P03-RECONNECT-RECOVERY / Coordination 11-15 18:49Z: a running QA stack keeps
// serving its loaded revision. HEAD moves ~36 times an hour and the shared checkout
// reinstalls dependencies; neither may change a running tree's packages or refuse
// its Agent launches (SOURCE_RUNTIME_RELOAD_REQUIRED) until someone reloads it.
test('HEAD moves and the checkout reinstalls: a running tree keeps its packages and still admits launches', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await mkdir(join(repoDir, 'node_modules/fixture-dep'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules/fixture-dep/package.json'), JSON.stringify({ name: 'fixture-dep', main: 'index.js' }));
  await writeFile(join(repoDir, 'node_modules/fixture-dep/index.js'), 'module.exports = "install-1";');
  await mkdir(join(repoDir, 'apps/cli/src'), { recursive: true });
  await writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module' }));
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export {};');
  await gitIn('add', 'apps/cli');
  await gitIn('commit', '--quiet', '-m', 'cli');
  await publishFixtureInstall(repoDir);
  const revision = await resolveSourceTreeRevision({ repoDir, treesRoot: fixture.path('trees'), rev: 'HEAD', overlay: [], outputDir: fixture.path('descriptors') });
  const { daemon } = await prepareSourceTreeRuntimeComponents({ repoDir, env: { ...process.env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: join(repoDir, 'manual-payload') }, stackBaseDir: fixture.path('stacks/qa'),
    descriptorPath: revision.descriptorPath, components: [{ component: 'daemon' }], logger: { error() {} } });
  const treeDir = dirname(dirname(daemon.cliDir));
  // HEAD moves, then the dependency owner republishes the installation (files replaced, new identity).
  await writeFile(join(repoDir, 'docs/notes.md'), 'moved on');
  await gitIn('commit', '--quiet', '-am', 'HEAD moves');
  await rm(join(repoDir, 'node_modules/fixture-dep/index.js'));
  await writeFile(join(repoDir, 'node_modules/fixture-dep/index.js'), 'module.exports = "install-2";');
  await writeFile(join(repoDir, 'node_modules/.happier-stack-dependencies-ready'), JSON.stringify({ version: 7, identity: 'install-2' }));
  assert.equal(await readFile(join(treeDir, 'node_modules/fixture-dep/index.js'), 'utf8'), 'module.exports = "install-1";');
  const { assertSourceRuntimeDependenciesCurrent } = await import('../../../../packages/cli-common/sourceRuntimeDependencies.mjs');
  assert.equal(await assertSourceRuntimeDependenciesCurrent({ entrypoint: daemon.entrypoint, env: {} }), null,
    'a launch on the running tree is admitted after HEAD moved and the checkout reinstalled');
});

// P03-TREE-GENERATED (P03-PLACEMENT-FINISH nl1 11-16 23:52Z): serialized package
// manifests are ignored generated files, so a revision archive has none, and the
// daemon's Plugin UI compiler refused 25 plugins with ENOENT. The revision's own
// daemon generator (a revision-owned executable; this stand-in keeps its output
// contract) emits them, and the tree places them before anything reads them.
const FIXTURE_DAEMON_GENERATOR = `import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[process.argv.indexOf('--daemon-output-root') + 1];
const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
write(join(out, 'apps/cli/.project/tmp/bundled-plugin-publication/failures.json'), '[]');
for (const id of readdirSync('packages/plugins')) {
  const authored = JSON.parse(readFileSync(join('packages/plugins', id, 'src/manifest.json'), 'utf8'));
  write(join(out, 'packages/plugins', id, '.happier-plugin/plugin.json'), JSON.stringify({ ...authored, serialized: true }) + '\\n');
  if (authored.version === '3') continue;
  write(join(out, 'apps/cli/assets/bundled-plugin-manifests', id + '.json'), JSON.stringify(authored));
  write(join(out, 'apps/cli/assets/bundled-plugin-manifests/declarations', id + '.summary.json'), JSON.stringify(authored));
  write(join(out, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'),
    'export const capturedVersion = ' + JSON.stringify(authored.version) + '; export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES = [];');
  if (authored.version === '1') write(join(out, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledRemovedPlugin.ts'), 'export {};');
}
`;

// P03-QUEUE-2 2026-11-17 (TREE-GENERATED live 1-3): describing marked a revision reusable before any host
// built it, so a broken HEAD stayed every later reload's base until a dependency-shape change.
test('only a base a preparation built is offered to later revisions', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  const treesRoot = fixture.path('trees');
  const first = await resolveSourceTreeRevision({ repoDir, treesRoot, outputDir: fixture.path('first') });
  await writeFile(join(repoDir, 'apps/server/sources/later.ts'), 'export const later = true;\n');
  await gitIn('add', 'apps/server/sources/later.ts');
  await gitIn('commit', '--quiet', '-m', 'later');
  const unbuilt = await resolveSourceTreeRevision({ repoDir, treesRoot, outputDir: fixture.path('unbuilt') });
  assert.equal(unbuilt.base, unbuilt.revision, 'a described but never built revision is not a base');
  await recordSourceTreeBases({ treesRoot, bases: [first.revision] });
  const reused = await resolveSourceTreeRevision({ repoDir, treesRoot, outputDir: fixture.path('reused') });
  assert.equal(reused.base, first.revision, 'a built base serves its descendants');
  assert.equal(reused.commitPaths, 1);
});

test('an incoherent described base cannot refuse a coherent requested revision', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await mkdir(join(repoDir, 'apps/cli/scripts/build-owned'), { recursive: true });
  await mkdir(join(repoDir, 'packages/plugins'), { recursive: true });
  await writeFile(join(repoDir, 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts'),
    "import '../../../../packages/shared/src/preparation.mjs';\n" + FIXTURE_DAEMON_GENERATOR.split('for (const id')[0]);
  const dependency = join(repoDir, 'packages/shared/src/preparation.mjs');
  await writeFile(dependency, 'export const broken = ;');
  await gitIn('add', 'apps/cli/scripts', 'packages/shared/src/preparation.mjs');
  await gitIn('commit', '--quiet', '-m', 'incoherent intermediate revision');
  const treesRoot = fixture.path('trees');
  const bad = await resolveSourceTreeRevision({ repoDir, treesRoot, outputDir: fixture.path('bad') });
  // Built once elsewhere (another host's environment), so it is a cache candidate here.
  await recordSourceTreeBases({ treesRoot, bases: [bad.revision] });
  await writeFile(dependency, 'export const repaired = true;');
  await gitIn('add', 'packages/shared/src/preparation.mjs');
  await gitIn('commit', '--quiet', '-m', 'repair preparation dependency');
  const requested = await resolveSourceTreeRevision({ repoDir, treesRoot, outputDir: fixture.path('requested') });
  assert.equal(requested.base, bad.revision, 'the cold cache base is the incoherent ancestor');
  const prepare = (descriptorPath, name, extra = {}) => prepareStackSourceRevisionTree({ repoDir, treesRoot,
    treeDir: fixture.path(name), descriptorPath, ...extra });
  // Control: the requested commit itself prepares successfully through the real subprocess.
  const direct = await resolveSourceRevision({ repoDir, rev: requested.revision, overlay: [],
    outputDir: fixture.path('direct'), fullTree: true });
  await prepare(direct.descriptorPath, 'control', { treesRoot: fixture.path('control-trees') });
  const tree = await prepare(requested.descriptorPath, 'recovered');
  assert.equal(tree.revision, requested.revision);
  assert.equal(tree.base, requested.revision, 'the fallback cache contains the requested commit');
  assert.equal(await readFile(join(tree.treeDir, 'packages/shared/src/preparation.mjs'), 'utf8'),
    'export const repaired = true;');
  assert.equal(await readFile(join(tree.treeDir, 'apps/server/sources/main.light.ts'), 'utf8'), COMMITTED_MAIN,
    'fallback never captures the checkout\'s unrelated dirty source');
  await assert.rejects(prepare(bad.descriptorPath, 'still-invalid'), /SyntaxError|Unexpected token/,
    'an actually invalid requested revision still fails');
});

test('a revision tree publishes its derived plugin manifests to the running CLI and package paths', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await writeFile(join(repoDir, '.gitignore'), 'node_modules\n/packages/plugins/*/.happier-plugin/plugin.json\n');
  await mkdir(join(repoDir, 'apps/cli/scripts/build-owned'), { recursive: true });
  await writeFile(join(repoDir, 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts'), FIXTURE_DAEMON_GENERATOR);
  await writeFile(join(repoDir, 'apps/cli/scripts/prepareSourcePluginUiArtifacts.mjs'), 'export async function prepareSourceCliPluginUiArtifacts() {}');
  await mkdir(join(repoDir, 'apps/cli/src'), { recursive: true });
  await writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module' }));
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export {};');
  const plugin = join(repoDir, 'packages/plugins/devcontainer');
  await mkdir(join(plugin, 'src'), { recursive: true });
  await mkdir(join(plugin, '.happier-plugin'), { recursive: true });
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-devcontainer', version: '0.0.0', type: 'module' }));
  await writeFile(join(plugin, 'src/manifest.json'), JSON.stringify({ id: 'happier.devcontainer', version: '1' }));
  // The checkout's own generated copy is stale; a base never takes it.
  await writeFile(join(plugin, '.happier-plugin/plugin.json'), JSON.stringify({ id: 'happier.devcontainer', version: 'stale-checkout' }));
  const cliManifestPath = 'apps/cli/assets/bundled-plugin-manifests/devcontainer.json';
  const summaryPath = 'apps/cli/assets/bundled-plugin-manifests/declarations/devcontainer.summary.json';
  const locatorsPath = 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts';
  const fullCliPath = join(dirname(locatorsPath), 'generatedBundledPlugins.ts');
  const removedModulePath = join(dirname(locatorsPath), 'generatedBundledRemovedPlugin.ts');
  const stale = JSON.stringify({ id: 'happier.devcontainer', version: 'stale-tracked' });
  for (const path of [cliManifestPath, summaryPath, locatorsPath]) {
    await mkdir(dirname(join(repoDir, path)), { recursive: true });
    await writeFile(join(repoDir, path), path === locatorsPath
      ? 'export const capturedVersion = "stale-tracked"; export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES = [];' : stale);
  }
  await writeFile(join(repoDir, fullCliPath), 'export const fullCliProjection = true;');
  await gitIn('add', '-A');
  await gitIn('commit', '--quiet', '-m', 'plugin with an ignored generated manifest');
  const env = { ...process.env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: join(repoDir, 'manual-payload') };
  const prepare = async overlay => {
    const revision = await resolveSourceTreeRevision({ repoDir, treesRoot: fixture.path('trees'), rev: 'HEAD', overlay,
      outputDir: fixture.path(`descriptors-${overlay.length}`) });
    const { daemon } = await prepareSourceTreeRuntimeComponents({ repoDir, env, stackBaseDir: fixture.path(`stacks/qa-${overlay.length}`),
      descriptorPath: revision.descriptorPath, components: [{ component: 'daemon' }], logger: { error() {} } });
    return dirname(dirname(daemon.cliDir));
  };
  const manifestIn = tree => join(tree, 'packages/plugins/devcontainer/.happier-plugin/plugin.json');
  const tree = await prepare([]);
  assert.deepEqual(JSON.parse(await readFile(manifestIn(tree), 'utf8')), { id: 'happier.devcontainer', version: '1', serialized: true },
    'the tree carries the manifest derived from the revision\'s source, not a missing or checkout copy');
  const readCliDeclarations = async treeDir => [
    JSON.parse(await readFile(join(treeDir, cliManifestPath), 'utf8')).version,
    JSON.parse(await readFile(join(treeDir, summaryPath), 'utf8')).version,
    (await readFile(join(treeDir, locatorsPath), 'utf8')).match(/capturedVersion = "([^"]+)"/)?.[1],
  ];
  assert.deepEqual(await readCliDeclarations(tree), ['1', '1', '1']);
  const baseManifest = await lstat(manifestIn(tree));
  await writeFile(join(plugin, 'src/manifest.json'), JSON.stringify({ id: 'happier.devcontainer', version: '2' }));
  const changed = await prepare(['packages/plugins/devcontainer/src/manifest.json']);
  assert.equal(JSON.parse(await readFile(manifestIn(changed), 'utf8')).version, '2', 'a changed plugin source re-derives its manifest');
  assert.equal(JSON.parse(await readFile(manifestIn(tree), 'utf8')).version, '1', 'the earlier tree keeps its own manifest');
  assert.equal((await lstat(manifestIn(tree))).ino, baseManifest.ino, 'the clone never writes through its base inode');
  assert.deepEqual(await readCliDeclarations(changed), ['2', '2', '2']);
  assert.deepEqual(await readCliDeclarations(tree), ['1', '1', '1']);
  await assert.rejects(readFile(join(changed, removedModulePath), 'utf8'), { code: 'ENOENT' });
  assert.equal(await readFile(join(tree, removedModulePath), 'utf8'), 'export {};');
  assert.equal(await readFile(join(changed, fullCliPath), 'utf8'), 'export const fullCliProjection = true;');

  await writeFile(join(plugin, 'src/manifest.json'), JSON.stringify({ id: 'happier.devcontainer', version: '3' }));
  const historical = await prepare(['packages/plugins/devcontainer/src/manifest.json']);
  assert.equal(JSON.parse(await readFile(manifestIn(historical), 'utf8')).version, '3');
  assert.deepEqual(await readCliDeclarations(historical), ['1', '1', '1'],
    'a generator without CLI outputs preserves the inherited CLI projections');
  assert.equal(await readFile(join(historical, removedModulePath), 'utf8'), 'export {};');
});

// 2026-11-17 00:41Z (Fork C RELOAD167, RU2 #111): base f6b7be69 held a committed schema
// change without its regenerated enums; the regeneration commit changed only
// enums.generated.ts, so every reload reused that base and its schema check refused.
// A regenerated schema output reshapes the base like the schema itself.
test('a commit that regenerates the schema-checked enums builds a new base instead of overlaying a stale one', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  const enums = join(repoDir, 'apps/server/sources/storage/enums.generated.ts');
  await mkdir(dirname(enums), { recursive: true });
  await writeFile(enums, 'export const Kind = ["a"] as const;\n');
  await gitIn('add', 'apps/server/sources/storage/enums.generated.ts');
  await gitIn('commit', '--quiet', '-m', 'stale enums');
  const treesRoot = fixture.path('trees');
  const first = await resolveSourceTreeRevision({ repoDir, treesRoot, rev: 'HEAD', overlay: [], outputDir: fixture.path('d1') });
  await writeFile(enums, 'export const Kind = ["a", "action"] as const;\n');
  await gitIn('commit', '--quiet', '-am', 'regenerate enums');
  const second = await resolveSourceTreeRevision({ repoDir, treesRoot, rev: 'HEAD', overlay: [], outputDir: fixture.path('d2') });
  assert.notEqual(second.revision, first.revision);
  assert.equal(second.base, second.revision, 'the regenerated revision is its own base');
});

// P03-ATOMIC-SWITCH-2: a generation-managed checkout's root node_modules is a real
// directory whose installation entries are relative links into its generation.
// A base snapshots the installed packages, never those links (they would dangle).
test('a base of a generation-managed checkout carries its installed root packages', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const { moveInPlaceInstallationIntoGeneration } = await import('../utils/proc/dependency_generations.mjs');
  await mkdir(join(repoDir, 'node_modules/fixture-dep'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules/fixture-dep/package.json'), JSON.stringify({ name: 'fixture-dep', main: 'index.js' }));
  await writeFile(join(repoDir, 'node_modules/fixture-dep/index.js'), 'module.exports = "generation";');
  await mkdir(join(repoDir, 'apps/cli/src'), { recursive: true });
  await writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module' }));
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export {};');
  await promisify(execFile)('git', ['-C', repoDir, 'add', 'apps/cli']);
  await promisify(execFile)('git', ['-C', repoDir, 'commit', '--quiet', '-m', 'cli']);
  await publishFixtureInstall(repoDir);
  await moveInPlaceInstallationIntoGeneration(repoDir);
  assert.equal((await lstat(join(repoDir, 'node_modules/fixture-dep'))).isSymbolicLink(), true);
  const revision = await resolveSourceTreeRevision({ repoDir, treesRoot: fixture.path('trees'), rev: 'HEAD', overlay: [], outputDir: fixture.path('descriptors') });
  const { daemon } = await prepareSourceTreeRuntimeComponents({ repoDir, env: { ...process.env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: join(repoDir, 'manual-payload') }, stackBaseDir: fixture.path('stacks/qa'),
    descriptorPath: revision.descriptorPath, components: [{ component: 'daemon' }], logger: { error() {} } });
  const treeDir = dirname(dirname(daemon.cliDir));
  assert.equal(await readFile(join(treeDir, 'node_modules/fixture-dep/index.js'), 'utf8'), 'module.exports = "generation";');
});
