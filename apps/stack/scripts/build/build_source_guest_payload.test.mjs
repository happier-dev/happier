// @happier-test-preparation source
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareSourceTreeRuntimeComponents, resolveSourceTreeRevision } from './source_revision_tree.mjs';
import { resolveCliRuntimeLaunchSpec } from '../runtime/launch/resolveCliRuntimeLaunchSpec.mjs';
import { resolveServerRuntimeLaunchSpec } from '../runtime/launch/resolveServerRuntimeLaunchSpec.mjs';
import { readSourceRuntimeBundleRecord, projectRemoteGuestCliPayloadEnvironment } from '../runtime/shared/source_bundle_record.mjs';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { installSourceAdmissionFixture, installSourcePreparationInputs } from '../testkit/core/source_runtime_fixture.mjs';
import { captureBuildInputFiles, mountInstalledNodeModules } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readWorkspaceBuildInputs } from '../utils/fs/workspaceBuildInputs.mjs';
import { readWorkspacePackages, workspaceSourcePackageClosure } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { resolveInstalledRuntimePackage } from '../../../../packages/cli-common/workspaceRuntimeDependencies.mjs';
import { buildSourceRuntimeBundle, setBundleReadOnly } from './build_source_runtime.mjs';
import { runCapture } from '../utils/proc/proc.mjs';
import { adoptDependencyInstallation, resolveDependencyRefreshMarkerPath } from '../utils/proc/dependency_refresh.mjs';
import cliDistBuildManifest from '../../../../packages/cli-common/cliDistBuildManifest.cjs';
import { createCliSourceLoader } from '../../../../packages/cli-common/cliSourceLoader.mjs';
import { CLI_BINARY_TARGETS, resolveCliToolsPlatformDir, resolveCurrentBinaryTarget } from '../../../../packages/cli-common/src/componentArtifacts/targets.ts';
import { readSourceGuestPayloadTargets, sourceGuestPayloadEnvironment } from './source_guest_payload.mjs';

test('retained producer archives never enable a Home whose operator left export off', () => {
  const env = sourceGuestPayloadEnvironment({ root: '/retained/guest', identity: 'captured',
    archives: [{ target: { os: 'linux', arch: 'x64' }, sha256: 'a'.repeat(64), archivePath: '/retained/guest.tar.gz' }] });
  const launch = resolveServerRuntimeLaunchSpec({ sourceRuntimeLaunch: { entrypoint: '/retained/server.mjs', env } });
  for (const operatorEnv of [{}, { HAPPIER_DEV_GUEST_CLI_EXPORT: '0' }]) {
    assert.notEqual({ ...operatorEnv, ...launch.env }.HAPPIER_DEV_GUEST_CLI_EXPORT, '1');
  }
  assert.deepEqual(projectRemoteGuestCliPayloadEnvironment({ HAPPIER_DEV_GUEST_CLI_EXPORT: '1' }),
    { HAPPIER_DEV_GUEST_CLI_EXPORT: '1' }, 'an opted-in remote producer receives the setting before it has payload metadata');
});

test('source guest payload defaults to the current native target without a configured root', () => {
  const target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS });
  for (const env of [{}, { HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: '' },
    { HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: '   ' }]) {
    assert.deepEqual(readSourceGuestPayloadTargets(env), [{ target, relativeDir: '' }]);
  }
});

const compilerFixtureOptions = { skip: process.platform === 'win32' ? 'compiler-process fixture uses POSIX executable scripts' : false };

async function createGuestPayloadFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-guest-payload-', registerCleanup: false });
  t.after(async () => { await setBundleReadOnly(fixture.root, false); await fixture.cleanup(); });
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  const sourceCommon = fileURLToPath(new URL('../../../../packages/cli-common/', import.meta.url));
  const common = join(repoDir, 'packages/cli-common');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(join(cliDir, 'node_modules'));
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'] }));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {}, bundledDependencies: [],
    dependencies: { 'guest-support-fixture': '1.0.0', '@happier-dev/plugins-cliproxyapi': 'workspace:*' } }));
  await mkdir(join(cliDir, 'node_modules/guest-support-fixture'));
  await writeFile(join(cliDir, 'node_modules/guest-support-fixture/package.json'), JSON.stringify({ name: 'guest-support-fixture', version: '1.0.0', main: 'index.cjs' }));
  await writeFile(join(cliDir, 'node_modules/guest-support-fixture/index.cjs'), 'exports.ready = true;');
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'tsconfig.runtime.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const snapshot = "captured";');
  await writeFile(join(cliDir, 'src/guest-only.ts'), 'export const guest = "one";');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await captureBuildInputFiles({ sourceDir: sourceCommon, captureDir: common,
    readPaths: () => readWorkspaceBuildInputs(sourceCommon) });
  // SEA compilation is an OS/compiler boundary, just like the executable
  // compiler fixtures below. Keep the real CLI graph, staging and identity owner.
  await writeFile(join(common, 'src/componentArtifacts/nodeSingleExecutable.ts'), `
    import { writeFile } from 'node:fs/promises';
    export async function compileNodeSingleExecutable({ outfile }) {
      await writeFile(outfile, 'fixture native executable');
    }
  `);
  await symlink(join(sourceCommon, 'node_modules'), join(common, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await mountInstalledNodeModules({ sourceModules: join(sourceCommon, '../../node_modules'), targetModules: join(repoDir, 'node_modules') });
  const sourceRepoDir = join(sourceCommon, '../..');
  const sourcePackages = await readWorkspacePackages(sourceRepoDir);
  for (const name of workspaceSourcePackageClosure(sourcePackages, ['@happier-dev/cli-common'])) {
    const owner = sourcePackages.get(name);
    if (name === '@happier-dev/cli-common') continue;
    const targetRoot = join(repoDir, relative(sourceRepoDir, owner.root));
    await captureBuildInputFiles({ sourceDir: sourceRepoDir, captureDir: repoDir,
      readPaths: () => readWorkspaceBuildInputs(owner.root)
        .map(path => relative(sourceRepoDir, join(owner.root, path))) });
    await mountInstalledNodeModules({ sourceModules: join(owner.root, 'node_modules'), targetModules: join(targetRoot, 'node_modules') });
  }
  await installSourcePreparationInputs(repoDir, 'daemon');
  const bunPin = (await readFile(new URL('../provision/.bun-version', import.meta.url), 'utf8')).trim();
  await mkdir(join(repoDir, 'apps/stack/scripts/provision'), { recursive: true });
  await writeFile(join(repoDir, 'apps/stack/package.json'), JSON.stringify({ name: '@happier-dev/stack' }));
  await writeFile(join(repoDir, 'apps/stack/scripts/provision/.bun-version'), bunPin);
  const licenses = join(repoDir, 'packages/plugins/cliproxyapi/managed-runtime/licenses');
  await mkdir(licenses, { recursive: true });
  await writeFile(join(licenses, '../../package.json'), JSON.stringify({ name: '@happier-dev/plugins-cliproxyapi', files: ['managed-runtime'] }));
  await writeFile(join(licenses, 'CLIProxyAPI-LICENSE'), 'fixture license');
  await writeFile(join(licenses, 'THIRD-PARTY-NOTICES'), 'fixture notices');
  await mkdir(join(cliDir, 'native/processcustody'), { recursive: true });
  await writeFile(join(cliDir, 'native/processcustody/README.md'), 'native compiler fixture');
  await mkdir(join(cliDir, 'tools/archives'), { recursive: true });
  await writeFile(join(cliDir, 'tools/archives/.gitkeep'), 'fixture tool archive boundary');
  // Tool acquisition is an OS boundary. Keep capture, graph emission, support
  // staging, finalization and canonical manifest construction real.
  await writeFile(join(cliDir, 'scripts/unpack-tools.cjs'), `
    exports.unpackTools = async ({toolsDir, platformDir}) => {
      const fs = require('node:fs'); const path = require('node:path');
      fs.mkdirSync(path.join(toolsDir, 'unpacked'), {recursive:true});
      fs.writeFileSync(path.join(toolsDir, 'unpacked/rg'), 'fixture tool');
      fs.writeFileSync(path.join(toolsDir, 'unpacked/.happier-tools-manifest.json'), JSON.stringify({platformDir,tools:{}}));
    };
  `);
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const bin = fixture.path('compiler-bin');
  await mkdir(bin);
  // Fake only external compilers and cross-toolchain availability probes. The
  // fixture has no target-specific third-party packages to acquire or compile.
  // Cargo writes the artifact the Iroh builder copies: the addon library, or the named binary.
  await writeFile(join(bin, 'cargo'), `#!${process.execPath}
    const fs = require('node:fs'); const path = require('node:path');
    const args = process.argv.slice(2); const target = args[args.indexOf('--target') + 1];
    const name = args.includes('--bin') ? args[args.indexOf('--bin') + 1] + (target.includes('windows') ? '.exe' : '')
      : target.includes('apple') ? 'libhappier_iroh_node.dylib' : target.includes('windows') ? 'happier_iroh_node.dll' : 'libhappier_iroh_node.so';
    const output = path.join(process.env.CARGO_TARGET_DIR, target, 'release', name);
    fs.mkdirSync(path.dirname(output), {recursive:true}); fs.writeFileSync(output, 'cargo output: ' + target + ' ' + name);
  `);
  await chmod(join(bin, 'cargo'), 0o755);
  for (const name of ['bun', 'go', 'pnpm', 'npm', 'aarch64-linux-gnu-gcc', 'aarch64-linux-gnu-g++', 'make']) {
    await writeFile(join(bin, name), `#!${process.execPath}
      const fs = require('node:fs'); const path = require('node:path');
      const args = process.argv.slice(2);
      if (${JSON.stringify(name)} === 'go' && args[0] === 'version') { console.log('go version go1.24.0 linux/amd64'); process.exit(0); }
      if (args.includes('--version')) { console.log(${JSON.stringify(bunPin)}); process.exit(0); }
      const liveEdit = ${JSON.stringify(fixture.path('edit-live-source'))};
      if (fs.existsSync(liveEdit)) {
        fs.writeFileSync(${JSON.stringify(join(cliDir, 'src/index.ts'))}, 'export const snapshot = "live";');
        fs.unlinkSync(liveEdit);
      }
      const flag = args.includes('--outfile') ? '--outfile' : args.includes('-o') ? '-o' : '--output';
      const output = args[args.indexOf(flag) + 1];
      fs.mkdirSync(path.dirname(output), {recursive:true}); fs.writeFileSync(output, 'fixture native executable');
    `);
    await chmod(join(bin, name), 0o755);
  }
  const env = { ...process.env, ...native?.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${native?.env.PATH ?? process.env.PATH}`,
    HAPPIER_BUN_PATH: join(bin, 'bun'), HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: '' };
  const target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS });
  return { fixture, repoDir, cliDir, sourceCommon, native, env, target };
}

test('guest payload retains host and target holders and includes native support in its identity', compilerFixtureOptions, async t => {
  const { fixture, repoDir, cliDir, env, target } = await createGuestPayloadFixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 4) });
  const loader = await createCliSourceLoader('source-guest-payload-identity');
  t.after(() => loader.unregister());
  const { buildCliBinaryArtifactPayload } = await loader.import(
    '../../../../packages/cli-common/src/componentArtifacts/buildCliBinaryArtifactPayload.ts', import.meta.url);
  const custody = fixture.path('prebuilt-custody');
  const proxy = fixture.path('prebuilt-proxy');
  await writeFile(custody, 'native support one');
  await writeFile(proxy, 'native proxy fixture');
  const payloadDir = fixture.path('identity-payload');
  const producerOptions = { repoRoot: repoDir, payloadDir, target,
    processCustodyRuntimeExecutablePath: custody, cliProxyApiManagedRuntimeExecutablePath: proxy,
    commandProbe: () => true,
    runCommand: (command, args, options) => runCapture(command, args, { ...options, env: { ...env, ...options?.env, PATH: env.PATH } }),
    compileBinary: async ({ outfile }) => { await writeFile(outfile, 'fixed compiler executable'); } };
  // Cargo and rustup are OS boundaries; the real addon builder, payload staging
  // and target finalization must build and keep every required holder.
  const iroh = join(repoDir, 'packages/iroh-native');
  const irohManifest = JSON.parse(await readFile(new URL('../../../../packages/iroh-native/package.json', import.meta.url), 'utf8'));
  await mkdir(join(iroh, 'native/targets'), { recursive: true });
  await mkdir(join(iroh, 'scripts'), { recursive: true });
  await mkdir(join(iroh, 'rust/happier-session-holder/src'), { recursive: true });
  await writeFile(join(iroh, 'package.json'), JSON.stringify({ ...irohManifest, dependencies: {} }));
  await writeFile(join(iroh, 'scripts/build-node-addon.mjs'),
    await readFile(new URL('../../../../packages/iroh-native/scripts/build-node-addon.mjs', import.meta.url)));
  await writeFile(join(iroh, 'scripts/ensure-rust-toolchain.mjs'), ['export function prepareRustToolchain() {}',
    'export function readPinnedRustChannel() { return "fixture"; }', 'export function resolveRustCargoBinDir() { return "/nonexistent"; }'].join('\n'));
  await writeFile(join(iroh, 'rust-toolchain.toml'), '[toolchain]\nchannel = "fixture"\n');
  await writeFile(join(iroh, 'rust/Cargo.toml'), '[workspace]\n');
  await writeFile(join(iroh, 'rust/Cargo.lock'), '');
  await writeFile(join(iroh, 'rust/happier-session-holder/src/main.rs'), 'fn main() {}\n');
  const hostManifest = JSON.parse(await readFile(join(cliDir, 'package.json'), 'utf8'));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ ...hostManifest,
    bundledDependencies: [...hostManifest.bundledDependencies, irohManifest.name],
    dependencies: { ...hostManifest.dependencies, [irohManifest.name]: 'workspace:*' } }));
  const platform = target.os === 'windows' ? 'win32' : target.os;
  const holder = `happier-session-holder.${platform}-${target.arch}${target.exeExt}`;
  const nativeFiles = [holder, `happier-iroh-native-lifecycle.${platform}-${target.arch}.node`,
    ...['x64', 'arm64'].map(arch => `targets/happier-session-holder.linux-${arch}-musl`)];
  // Checkout outputs from older sources are never shipped.
  for (const name of nativeFiles) await writeFile(join(iroh, 'native', name), `stale checkout output: ${name}`);
  const first = await buildCliBinaryArtifactPayload(producerOptions);
  for (const name of nativeFiles) assert.match(await readFile(join(payloadDir,
    'node_modules/@happier-dev/iroh-native/native', name), 'utf8'), /^cargo output: /);
  assert.match(first.identity ?? '', /^[a-f0-9]{64}$/, 'the complete payload exposes its canonical byte identity');
  const codeIdentity = cliDistBuildManifest.readCliDistBuildManifest(join(payloadDir, 'package-dist/index.mjs')).manifest.fingerprint;
  const repeated = await buildCliBinaryArtifactPayload(producerOptions);
  assert.equal(repeated.identity, first.identity, 'fixed compiler bytes and metadata produce the same payload identity');
  await writeFile(custody, 'native support two');
  const changed = await buildCliBinaryArtifactPayload(producerOptions);
  assert.equal(cliDistBuildManifest.readCliDistBuildManifest(join(payloadDir, 'package-dist/index.mjs')).manifest.fingerprint,
    codeIdentity, 'support-only changes leave the authored CLI graph unchanged');
  assert.notEqual(changed.identity, first.identity, 'payload identity must include changed native support bytes');
  await writeFile(join(cliDir, 'package.json'), JSON.stringify(hostManifest));
});

test('source Home registers a Mac-native archive alongside its own payload without cross-building', compilerFixtureOptions, async t => {
  const { fixture, repoDir, native, env, target } = await createGuestPayloadFixture(t);
  if (target.os !== 'linux') return t.skip('Linux Home registration of a Mac-native archive');
  const build = native?.build ?? buildSourceRuntimeBundle;
  const options = { repoDir, stackBaseDir: fixture.path('stacks/guest'), component: 'daemon',
    waitForSourceChanges: false, env: { ...env, HAPPIER_DEV_GUEST_CLI_EXPORT: '1' } };
  const ordinary = await build(options);
  assert.deepEqual(ordinary.guestPayload.archives.map(archive => archive.target), [{ os: target.os, arch: target.arch }]);
  // Bytes received from the native Mac compiler/archive process are an external
  // build boundary. Linux capture, payload production, registration and retention stay real.
  const archivePath = fixture.path('mac-host/darwin-arm64.tar.gz');
  await mkdir(dirname(archivePath), { recursive: true });
  const bytes = Buffer.from('archive emitted by the native Mac compiler boundary');
  await writeFile(archivePath, bytes);
  const mac = { target: { os: 'darwin', arch: 'arm64' },
    sha256: createHash('sha256').update(bytes).digest('hex'), archivePath };
  const registeredEnv = { ...options.env,
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: JSON.stringify({ archives: [mac] }) };
  assert.deepEqual(projectRemoteGuestCliPayloadEnvironment(registeredEnv), {
    HAPPIER_DEV_GUEST_CLI_EXPORT: '1', HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: registeredEnv.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA,
  }, 'remote reload forwards the archive registration even without an unpacked-root override');
  const registered = await build({ ...options, stackBaseDir: fixture.path('stacks/export-consumer'),
    env: { ...registeredEnv, HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'guest' } });
  const retained = registered.guestPayload.archives.find(archive => archive.target.os === 'darwin' && archive.target.arch === 'arm64');
  assert.ok(retained, 'Linux preparation must retain the registered native Mac archive');
  assert.notEqual(retained.archivePath, archivePath);
  assert.equal(retained.sha256, mac.sha256);
  assert.deepEqual(await readFile(retained.archivePath), bytes);
  assert.deepEqual(JSON.parse(registered.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA).archives, registered.guestPayload.archives);
  assert.equal(registered.guestPayload.archives.some(archive => archive.target.os === 'darwin' && archive.target.arch === 'x64'), false);
  await writeFile(archivePath, 'changed transfer bytes');
  assert.deepEqual(await readFile(retained.archivePath), bytes, 'retention owns a copy independent of the imported file');
  const removed = await build({ ...options, stackBaseDir: fixture.path('stacks/export-consumer'),
    env: { ...options.env, HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'guest' } });
  assert.equal(removed.guestPayload.archives.some(archive => archive.target.os === 'darwin'), false,
    'completed-producer adoption must also honour a removed registration');
  await assert.rejects(build({ ...options, stackBaseDir: fixture.path('stacks/bad-import'), env: { ...registeredEnv,
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: JSON.stringify({ archives: [{ ...mac, sha256: '0'.repeat(64) }] }) } }),
    { code: 'source_runtime_producer_failed', phase: 'source-producer' }, 'changed transfer bytes cannot be published with the old pin');
  const disabled = await build({ ...options, env: { ...registeredEnv, HAPPIER_DEV_GUEST_CLI_EXPORT: '0' } });
  assert.equal(disabled.guestPayload.archives, undefined);
});

test('guest payload and daemon retain the same captured source after live edits and guest-only changes invalidate reuse', compilerFixtureOptions, async t => {
  const { fixture, repoDir, cliDir, sourceCommon, native, env, target } = await createGuestPayloadFixture(t);
  const pluginRoot = join(repoDir, 'packages/plugins/fixture-ui');
  await mkdir(join(pluginRoot, 'src'), { recursive: true });
  const cliManifest = JSON.parse(await readFile(join(cliDir, 'package.json'), 'utf8'));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ ...cliManifest,
    dependencies: { ...cliManifest.dependencies, '@happier-dev/plugins-fixture-ui': 'workspace:*' } }));
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-fixture-ui', type: 'module',
    exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.mjs' } } }));
  await writeFile(join(pluginRoot, 'src/index.ts'), 'export const plugin = "ui-fixture";');
  const locators = join(cliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
  await mkdir(dirname(locators), { recursive: true });
  await writeFile(locators, `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = ${JSON.stringify([
    { sourceSpec: { locator: '@happier-dev/plugins-fixture-ui' },
      manifest: { schemaVersion: 2, id: 'fixture.ui', version: '0.0.0', displayName: 'Fixture', runtime: { apiVersion: 1 },
        hostAccess: { required: [], optional: [] }, contributes: {} } },
  ])};`);
  // The UI compiler is a genuine process boundary. Require its actual stdin
  // request and leave capture, source entry selection and payload staging real.
  await writeFile(join(repoDir, 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs'), `
    import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
    import {join,dirname} from 'node:path';
    const request = JSON.parse(readFileSync(0, 'utf8'));
    if (request.plugins[0]?.manifest.id !== 'fixture.ui') throw new Error('UI compiler request is missing plugin input');
    const inventory = request.outputPath ?? join(request.outputDir, 'inventory.js');
    mkdirSync(dirname(inventory), {recursive:true}); writeFileSync(inventory, 'export const fixture = true;');
    for (const output of Object.values(request.artifactOutputDirs)) {
      mkdirSync(output, {recursive:true}); writeFileSync(join(output, 'fixture.js'), 'export const capturedUi = true;');
    }
  `);
  const build = native?.build ?? buildSourceRuntimeBundle;
  const options = { repoDir, stackBaseDir: fixture.path('stacks/guest'), component: 'daemon', env: { ...env, HAPPIER_DEV_GUEST_CLI_EXPORT: '1' },
    waitForSourceChanges: false };
  const unexported = await build({ ...options, env });
  assert.equal(unexported.guestPayload.archives, undefined);
  const ordinary = await build({ ...options, stackBaseDir: fixture.path('stacks/export-consumer'),
    env: { ...options.env, HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'guest' } });
  assert.ok(ordinary.guestPayload, 'an unconfigured source runtime produces its native guest payload');
  assert.equal(ordinary.guestPayload.archives?.length, 1, 'opted-in producer retains one archive per actual target');
  const archive = ordinary.guestPayload.archives[0];
  assert.deepEqual(archive.target, { os: target.os, arch: target.arch });
  assert.equal(archive.sha256, createHash('sha256').update(await readFile(archive.archivePath)).digest('hex'));
  assert.equal((await import(pathToFileURL(join(ordinary.guestPayload.root, 'package-dist/index.mjs')))).snapshot, 'captured');
  assert.equal(ordinary.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT, ordinary.guestPayload.root);
  assert.deepEqual(JSON.parse(ordinary.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA), {
    root: ordinary.guestPayload.root, identity: ordinary.guestPayload.identity, archives: ordinary.guestPayload.archives,
  });
  const configuredPayload = fixture.path('configured-payload');
  await mkdir(join(configuredPayload, 'tools/unpacked'), { recursive: true });
  await writeFile(join(configuredPayload, 'tools/unpacked/.happier-tools-manifest.json'), JSON.stringify({platformDir:resolveCliToolsPlatformDir(target),tools:{}}));
  const optedEnv = { ...env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: configuredPayload };
  // Force a fresh producer capture and edit live source at the compiler process
  // boundary, after capture. The public producer owns its capture inputs.
  await writeFile(join(cliDir, 'src/guest-only.ts'), 'export const guest = "during-build";');
  await writeFile(fixture.path('edit-live-source'), 'armed');
  const built = await build({ ...options, env: optedEnv });
  assert.equal(await readFile(join(cliDir, 'src/index.ts'), 'utf8'), 'export const snapshot = "live";');
  assert.ok(built.guestPayload, 'a configured native root retains a source-built payload');
  assert.equal(built.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT, built.guestPayload.root);
  assert.notEqual(built.guestPayload.root, optedEnv.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT);
  assert.deepEqual(built.guestPayload.sourceCapture, built.sourceCapture);
  assert.equal(existsSync(join(dirname(dirname(built.runtimeDir)), 'workspace')), false);
  const guestEntry = join(built.guestPayload.root, 'package-dist/index.mjs');
  assert.equal((await import(pathToFileURL(built.entrypoint))).snapshot, 'captured');
  assert.equal((await import(pathToFileURL(guestEntry))).snapshot, 'captured');
  assert.equal(await readFile(join(built.guestPayload.root,
    'node_modules/@happier-dev/plugins-fixture-ui/dist/happier-plugin-ui/fixture.js'), 'utf8'),
  'export const capturedUi = true;', 'the full guest compiler receives its plugin request over stdin');
  const manifest = cliDistBuildManifest.readCliDistBuildManifest(guestEntry);
  assert.equal(manifest.ok, true);
  assert.match(built.guestPayload.identity, /^[a-f0-9]{64}$/);
  await writeFile(join(cliDir, 'src/index.ts'), 'export const snapshot = "captured";');
  const warm = await build({ ...options, env: optedEnv });
  assert.equal(warm.guestPayload.root, built.guestPayload.root);
  await writeFile(join(cliDir, 'src/guest-only.ts'), 'export const guest = "two";');
  const changed = await build({ ...options, env: optedEnv });
  assert.notEqual(changed.guestPayload.root, built.guestPayload.root, 'guest capture inputs outside the daemon graph must invalidate payload reuse');
  const collection = fixture.path('configured-collection');
  const targetId = `${target.os}-${target.arch}`;
  await mkdir(join(collection, targetId), { recursive: true });
  const collectionEnv = { ...env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: collection };
  const collectionBuilt = await build({ ...options, env: collectionEnv });
  assert.match(collectionBuilt.guestPayload.targetIdentities[targetId], /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(collectionBuilt.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA), {
    root: collectionBuilt.guestPayload.root, identity: collectionBuilt.guestPayload.identity, targetIdentities: collectionBuilt.guestPayload.targetIdentities,
  });
  assert.equal((await import(pathToFileURL(join(collectionBuilt.guestPayload.root, targetId, 'package-dist/index.mjs')))).snapshot, 'captured');
  if (process.platform === 'linux' && process.arch === 'x64') {
    const crossTarget = CLI_BINARY_TARGETS.find(candidate => candidate.os === 'linux' && candidate.arch === 'arm64');
    const crossId = `${crossTarget.os}-${crossTarget.arch}`;
    const mixedRoot = fixture.path('configured-mixed-native');
    await mkdir(join(mixedRoot, 'tools/unpacked'), { recursive: true });
    await writeFile(join(mixedRoot, 'tools/unpacked/.happier-tools-manifest.json'),
      JSON.stringify({ platformDir: resolveCliToolsPlatformDir(target), tools: {} }));
    await mkdir(join(mixedRoot, crossId));
    const mixed = await build({ ...options, env: { ...env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: mixedRoot } });
    assert.deepEqual(Object.keys(mixed.guestPayload.targetIdentities).sort(), [targetId, crossId].sort());
    assert.equal((await import(pathToFileURL(join(mixed.guestPayload.root, 'package-dist/index.mjs')))).snapshot, 'captured');
    assert.equal((await import(pathToFileURL(join(mixed.guestPayload.root, crossId, 'package-dist/index.mjs')))).snapshot, 'captured',
      'the flat fallback must be built before exact target directories so both remain retained');
  }
  const foreign = CLI_BINARY_TARGETS.find(candidate => candidate.os !== target.os);
  await mkdir(join(collection, `${foreign.os}-${foreign.arch}`));
  await assert.rejects(build({ ...options, env: collectionEnv }), { code: 'source_runtime_producer_failed', phase: 'source-producer' },
    'a configured foreign target must use the canonical target producer instead of silently publishing host-only output');
  const escaped = fixture.path('outside-installed-owner');
  await writeFile(escaped, 'not an installed dependency input');
  const escapeLink = join(cliDir, 'node_modules/guest-support-fixture/escape');
  await symlink(escaped, escapeLink);
  await writeFile(join(cliDir, 'src/guest-only.ts'), 'export const guest = "escape-check";');
  await assert.rejects(build({ ...options, env: optedEnv }), { code: 'source_runtime_producer_failed', phase: 'source-producer' },
    'captured dependency mounts must retain the installed owner containment boundary');
  await rm(escapeLink);
  const manualRoot = fixture.path('manual-payload');
  await mkdir(manualRoot);
  await writeFile(join(manualRoot, 'happier'), '#!/bin/sh\nexit 0\n');
  await chmod(join(manualRoot, 'happier'), 0o755);
  const manualEnv = { ...env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: manualRoot };
  const manual = await build({ ...options, env: manualEnv });
  assert.equal(manual.guestPayload, undefined);
  assert.equal({ ...manualEnv, ...manual.env }.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT, manualRoot,
    'manual interpreter payloads retain their override without source attestation');
  const defaulted = await build(options);
  assert.ok(defaulted.guestPayload, 'source reloads without an override still produce their native payload');
  assert.equal(defaulted.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT, defaulted.guestPayload.root);
  assert.notEqual(defaulted.guestPayload.root, manualRoot, 'a previous manual override is not inherited');
});


test('tree reload publishes a native guest payload from the selected revision in its completed record', compilerFixtureOptions, async t => {
  const { fixture, repoDir, cliDir, env } = await createGuestPayloadFixture(t);
  const supportLoader = await createCliSourceLoader('source-tree-guest-support-fixture');
  try {
    const { CLI_RUNTIME_EXTERNAL_PACKAGES } = await supportLoader.import(
      new URL('../../../../packages/cli-common/src/componentArtifacts/buildCliBinaryArtifactPayload.ts', import.meta.url).href,
      import.meta.url);
    const manifest = JSON.parse(await readFile(join(cliDir, 'package.json'), 'utf8'));
    // Installed third-party packages are a system boundary; keep the real
    // support identity, dependency staging and native compiler orchestration.
    for (const name of CLI_RUNTIME_EXTERNAL_PACKAGES) {
      manifest.dependencies[name] = '1.0.0';
      const packageDir = join(cliDir, 'node_modules', name);
      const installed = resolveInstalledRuntimePackage({ packageName: name,
        resolveFromPackageJsonPath: fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url)) });
      const optionalNames = Object.keys(installed.packageJson.optionalDependencies ?? {});
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.cjs',
        optionalDependencies: Object.fromEntries(optionalNames.map(name => [name, '1.0.0'])) }));
      await writeFile(join(packageDir, 'index.cjs'), 'module.exports = {};');
      for (const optionalName of optionalNames) {
        const optionalDir = join(cliDir, 'node_modules', optionalName);
        await mkdir(optionalDir, { recursive: true });
        await writeFile(join(optionalDir, 'package.json'), JSON.stringify({ name: optionalName, version: '1.0.0', main: 'index.cjs' }));
        await writeFile(join(optionalDir, 'index.cjs'), 'module.exports = {};');
      }
    }
    await writeFile(join(cliDir, 'package.json'), JSON.stringify(manifest));
  } finally { await supportLoader.unregister(); }
  await mkdir(join(repoDir, 'apps/server/sources'), { recursive: true });
  await mkdir(join(repoDir, 'apps/server/scripts'), { recursive: true });
  await writeFile(join(repoDir, 'apps/server/package.json'), JSON.stringify({ name: '@happier-dev/server',
    dependencies: { '@happier-dev/cli-common': 'workspace:*' } }));
  await writeFile(join(repoDir, 'apps/server/sources/main.light.ts'), 'export const server = true;');
  await writeFile(join(repoDir, 'apps/server/scripts/migrate.sqlite.deploy.ts'), 'export const migration = true;');
  // Resolve the real support owner; only the compiler processes above are fixtures.
  await writeFile(join(repoDir, 'apps/stack/scripts/build/build_daemon_artifact.mjs'), `
    export { ensureDaemonSupportArtifact } from ${JSON.stringify(new URL('./build_daemon_artifact.mjs', import.meta.url).href)};
  `);
  // Use physical module directories, as a real checkout does, before snapshotting.
  const commonModules = join(repoDir, 'packages/cli-common/node_modules');
  await rm(commonModules);
  await mountInstalledNodeModules({ sourceModules: new URL('../../../../packages/cli-common/node_modules', import.meta.url).pathname, targetModules: commonModules });
  const git = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await writeFile(join(repoDir, '.gitignore'), 'node_modules\n');
  await git('init', '--quiet');
  await git('config', 'user.name', 'test');
  await git('config', 'user.email', 'test@example.invalid');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'guest source fixture');
  // Borrowed packages do not carry the donor checkout's installation admission.
  await rm(resolveDependencyRefreshMarkerPath(repoDir), { force: true });
  await adoptDependencyInstallation({ installDir: repoDir, componentDir: cliDir, env });
  const revision = await resolveSourceTreeRevision({ repoDir, treesRoot: fixture.path('trees'),
    outputDir: fixture.path('descriptors') });
  await writeFile(join(cliDir, 'src/index.ts'), 'export const snapshot = "foreign dirty edit";');
  const { daemon } = await prepareSourceTreeRuntimeComponents({ repoDir, stackBaseDir: fixture.path('stacks/tree-guest'),
    descriptorPath: revision.descriptorPath, components: [{ component: 'daemon' }], env, logger: { error() {} } });
  assert.ok(daemon.guestPayload, 'tree reload must produce a payload without an operator root');
  const record = await readSourceRuntimeBundleRecord(daemon.entrypoint);
  assert.deepEqual(record.guestPayload, daemon.guestPayload);
  const launch = await resolveCliRuntimeLaunchSpec({ sourceRuntimeLaunch: record });
  assert.equal(launch.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT, record.guestPayload.root);
  assert.deepEqual(record.guestPayload.sourceCapture, record.sourceCapture);
  assert.equal(record.sourceCapture.revision, revision.revision);
  assert.deepEqual(projectRemoteGuestCliPayloadEnvironment(record.env), {
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: record.guestPayload.root,
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: JSON.stringify({ root: record.guestPayload.root, identity: record.guestPayload.identity }),
  });
  assert.equal((await import(pathToFileURL(join(record.guestPayload.root, 'package-dist/index.mjs')))).snapshot, 'captured',
    'guest payload uses the selected tree, never the moving checkout');
  assert.equal(daemon.guestPayload.archives, undefined, 'default-off source preparation does not export archives');
  const { server } = await prepareSourceTreeRuntimeComponents({ repoDir, stackBaseDir: fixture.path('stacks/tree-home'),
    descriptorPath: revision.descriptorPath, components: [{ component: 'server' }],
    env: { ...env, HAPPIER_DEV_GUEST_CLI_EXPORT: '1' }, logger: { error() {} } });
  const serverRecord = JSON.parse(await readFile(join(server.runtimeDir, '../../source-bundle.json'), 'utf8'));
  assert.deepEqual(serverRecord.guestPayload, server.guestPayload);
  assert.equal(serverRecord.env.HAPPIER_DEV_GUEST_CLI_EXPORT, undefined, 'producer metadata never enables the runtime operator setting');
  const archive = serverRecord.guestPayload.archives[0];
  assert.equal(archive.sha256, createHash('sha256').update(await readFile(archive.archivePath)).digest('hex'));
  assert.equal((await import(pathToFileURL(join(serverRecord.guestPayload.root, 'package-dist/index.mjs')))).snapshot,
    'captured', 'Home exports its selected source revision');
});
