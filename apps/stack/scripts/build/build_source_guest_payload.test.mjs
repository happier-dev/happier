// @happier-test-preparation source
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
import { buildSourceRuntimeBundle, captureSourceRuntimeSharedInputs, setBundleReadOnly } from './build_source_runtime.mjs';
import { runCapture } from '../utils/proc/proc.mjs';
import cliDistBuildManifest from '../../../../packages/cli-common/cliDistBuildManifest.cjs';
import { createCliSourceLoader } from '../../../../packages/cli-common/cliSourceLoader.mjs';
import { CLI_BINARY_TARGETS, resolveCliToolsPlatformDir, resolveCurrentBinaryTarget } from '../../../../packages/cli-common/src/componentArtifacts/targets.ts';

test('guest payload and daemon retain the same captured source after live edits and guest-only changes invalidate reuse',
  { skip: process.platform === 'win32' ? 'compiler-process fixture uses POSIX executable scripts' : false }, async t => {
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
  for (const name of ['bun', 'go', 'pnpm', 'npm', 'aarch64-linux-gnu-gcc', 'aarch64-linux-gnu-g++', 'make']) {
    await writeFile(join(bin, name), `#!${process.execPath}
      const fs = require('node:fs'); const path = require('node:path');
      const args = process.argv.slice(2);
      if (args.includes('--version')) { console.log(${JSON.stringify(bunPin)}); process.exit(0); }
      const flag = args.includes('--outfile') ? '--outfile' : args.includes('-o') ? '-o' : '--output';
      const output = args[args.indexOf(flag) + 1];
      fs.mkdirSync(path.dirname(output), {recursive:true}); fs.writeFileSync(output, 'fixture native executable');
    `);
    await chmod(join(bin, name), 0o755);
  }
  const env = { ...process.env, ...native?.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${native?.env.PATH ?? process.env.PATH}`,
    HAPPIER_BUN_PATH: join(bin, 'bun'), HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: '' };
  const target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS });
  let producerPassed = false;
  await t.test('canonical full payload identity includes native support bytes while code stays fixed', async identityTest => {
    identityTest.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 4) });
    const loader = await createCliSourceLoader('source-guest-payload-identity');
    identityTest.after(() => loader.unregister());
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
      runCommand: (command, args, options) => runCapture(command, args, { ...options, env: { ...env, ...options?.env } }),
      compileBinary: async ({ outfile }) => { await writeFile(outfile, 'fixed compiler executable'); } };
    const first = await buildCliBinaryArtifactPayload(producerOptions);
    assert.match(first.identity ?? '', /^[a-f0-9]{64}$/, 'the complete payload exposes its canonical byte identity');
    const codeIdentity = cliDistBuildManifest.readCliDistBuildManifest(join(payloadDir, 'package-dist/index.mjs')).manifest.fingerprint;
    const repeated = await buildCliBinaryArtifactPayload(producerOptions);
    assert.equal(repeated.identity, first.identity, 'fixed compiler bytes and metadata produce the same payload identity');
    await writeFile(custody, 'native support two');
    const changed = await buildCliBinaryArtifactPayload(producerOptions);
    assert.equal(cliDistBuildManifest.readCliDistBuildManifest(join(payloadDir, 'package-dist/index.mjs')).manifest.fingerprint,
      codeIdentity, 'support-only changes leave the authored CLI graph unchanged');
    assert.notEqual(changed.identity, first.identity, 'payload identity must include changed native support bytes');
    producerPassed = true;
  });
  // A producer failure must be repaired before exercising its Stack consumer.
  if (!producerPassed) return;
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
  const options = { repoDir, stackBaseDir: fixture.path('stacks/guest'), component: 'daemon', env,
    waitForSourceChanges: false };
  const ordinary = await build(options);
  assert.equal(ordinary.guestPayload, undefined);
  const configuredPayload = fixture.path('configured-payload');
  await mkdir(join(configuredPayload, 'tools/unpacked'), { recursive: true });
  await writeFile(join(configuredPayload, 'tools/unpacked/.happier-tools-manifest.json'), JSON.stringify({platformDir:resolveCliToolsPlatformDir(target),tools:{}}));
  const optedEnv = { ...env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: configuredPayload };
  const sharedSourceInputs = await captureSourceRuntimeSharedInputs({ repoDir, outputDir: fixture.path('shared'), env: optedEnv });
  await writeFile(join(cliDir, 'src/index.ts'), 'export const snapshot = "live";');
  const built = await build({ ...options, env: optedEnv, sharedSourceInputs });
  assert.ok(built.guestPayload, 'explicit guest opt-in must build a retained payload instead of reusing the source-only bundle');
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
  await assert.rejects(build({ ...options, env: collectionEnv }), error => error.code === 1,
    'a configured foreign target must use the canonical target producer instead of silently publishing host-only output');
  const escaped = fixture.path('outside-installed-owner');
  await writeFile(escaped, 'not an installed dependency input');
  const escapeLink = join(cliDir, 'node_modules/guest-support-fixture/escape');
  await symlink(escaped, escapeLink);
  await writeFile(join(cliDir, 'src/guest-only.ts'), 'export const guest = "escape-check";');
  await assert.rejects(build({ ...options, env: optedEnv }), error => error.code === 1,
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
  const disabled = await build(options);
  assert.equal(disabled.guestPayload, undefined, 'source-only reloads must not inherit an earlier guest override');
});
