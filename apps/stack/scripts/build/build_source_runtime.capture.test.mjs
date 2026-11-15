import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { installSourceAdmissionFixture } from '../testkit/core/source_runtime_fixture.mjs';
import { sourceBuildNodeArgs } from '../utils/proc/runSourceBuildCommand.mjs';
import { buildSourceRuntimeBundle, captureSourceRuntimeSharedInputs, captureSourceWebBuildInputs, setBundleReadOnly } from './build_source_runtime.mjs';
import { resolveSourceRevision } from './source_revision.mjs';

test('source capture includes new undeclared workspace imports and excludes unrelated and ignored sources', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-untracked-import-', registerCleanup: false });
  t.after(async () => { await setBundleReadOnly(fixture.root, false); await fixture.cleanup(); });
  const repoDir = fixture.path('repo');
  await mkdir(repoDir);
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  await promisify(execFile)('git', ['init', '--quiet', repoDir]);
  for (const [directory, name] of [
    ['apps/server', '@happier-dev/server'],
    ['packages/added', '@happier-dev/added'],
    ['packages/transitive', '@happier-dev/transitive'],
    ['packages/unrelated', '@happier-dev/unrelated'],
  ]) {
    await mkdir(join(repoDir, directory, 'src'), { recursive: true });
    await writeFile(join(repoDir, directory, 'package.json'), JSON.stringify({ name, type: 'module',
      exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  }
  const server = join(repoDir, 'apps/server');
  await mkdir(join(server, 'sources'));
  await mkdir(join(server, 'scripts'));
  await mkdir(join(server, 'node_modules'));
  await writeFile(join(server, 'tsconfig.json'), '{}');
  await writeFile(join(server, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(server, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(server, 'sources/main.light.ts'), 'export { marker } from "@happier-dev/added";');
  const added = 'packages/added/src/index.ts';
  await writeFile(join(repoDir, added), 'export { marker } from "@happier-dev/transitive";', { mode: 0o600 });
  await writeFile(join(repoDir, 'packages/transitive/src/index.ts'), 'export const marker = "new-source";');
  await writeFile(join(repoDir, 'packages/unrelated/src/index.ts'), 'export const unrelated = true;');
  await writeFile(join(repoDir, 'packages/added/src/ignored.test.ts'), 'import "@happier-dev/unrelated";');
  const status = await promisify(execFile)('git', ['-C', repoDir, 'status', '--porcelain', '--untracked-files=all', '--', added]);
  assert.match(status.stdout, /^\?\? packages\/added\/src\/index\.ts/m);
  const sharedSourceInputs = await captureSourceRuntimeSharedInputs({ repoDir, outputDir: fixture.path('shared') });
  for (const shared of [undefined, sharedSourceInputs]) {
    const captured = await captureSourceWebBuildInputs({ repoDir, component: 'server',
      outputDir: fixture.path(shared ? 'shared-consumer' : 'standalone'), sharedSourceInputs: shared });
    assert.ok(captured.files.includes(added), 'new untracked imports must be admitted before the consumed-inputs loader runs');
    assert.equal(captured.files.filter(path => path === added).length, 1);
    assert.equal(captured.files.includes('packages/unrelated/src/index.ts'), false);
    assert.equal(captured.files.includes('packages/added/src/ignored.test.ts'), false);
    assert.equal(await readFile(join(captured.repoDir, added), 'utf8'), 'export { marker } from "@happier-dev/transitive";');
  }
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const built = await (native?.build ?? buildSourceRuntimeBundle)({ repoDir, outputDir: fixture.path('runtime'),
    component: 'server', serverComponent: 'happier-server-light', dbProvider: 'sqlite', sharedSourceInputs,
    env: native?.env ?? process.env });
  assert.equal((await import(pathToFileURL(built.entrypoint))).marker, 'new-source');
});

test('server source capture retains matching default and generated provider clients after live regeneration', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-provider-capture-', registerCleanup: false });
  t.after(async () => { await setBundleReadOnly(fixture.root, false); await fixture.cleanup(); });
  const repoDir = fixture.path('repo');
  const server = join(repoDir, 'apps/server');
  for (const directory of ['sources', 'scripts', 'node_modules', 'generated/sqlite-client']) {
    await mkdir(join(server, directory), { recursive: true });
  }
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
  await writeFile(join(server, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(server, 'tsconfig.json'), '{}');
  await writeFile(join(server, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(server, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  // Generated third-party artifacts are the boundary: keep their real CommonJS
  // package lookup and runtime file lifetimes, without recreating Prisma logic.
  const wrapper = join(repoDir, 'node_modules/@prisma/client');
  const generated = join(repoDir, 'node_modules/.prisma/client');
  await mkdir(wrapper, { recursive: true });
  await mkdir(generated, { recursive: true });
  await writeFile(join(wrapper, 'package.json'), JSON.stringify({ name: '@prisma/client', main: './index.cjs' }));
  await writeFile(join(wrapper, 'index.cjs'), 'module.exports = require(".prisma/client/index.cjs");');
  const sqlite = join(server, 'generated/sqlite-client/index.js');
  await writeFile(join(server, 'generated/sqlite-client/package.json'), JSON.stringify({ type: 'commonjs' }));
  const engineBytes = new Uint8Array([0, 255, 128, 0, 10]);
  await writeFile(join(server, 'generated/sqlite-client/engine.bin'), engineBytes, { mode: 0o755 });
  const engineExecuteBits = (await stat(join(server, 'generated/sqlite-client/engine.bin'))).mode & 0o111;
  const source = join(server, 'sources/main.light.ts');
  await writeFile(join(generated, 'index.cjs'), 'exports.schemaMarker = "captured";');
  await writeFile(sqlite, 'exports.schemaMarker = "captured";');
  await writeFile(source, `import { createRequire } from 'node:module';
    export const sourceMarker = 'captured';
    export const defaultMarker = createRequire(import.meta.url)('@prisma/client').schemaMarker;
    export async function sqliteMarker() { return (await import('../generated/sqlite-client/index.js')).schemaMarker; }
  `);
  const sharedSourceInputs = await captureSourceRuntimeSharedInputs({ repoDir, outputDir: fixture.path('shared') });
  await writeFile(join(generated, 'index.cjs'), 'exports.schemaMarker = "regenerated";');
  await writeFile(sqlite, 'exports.schemaMarker = "regenerated";');
  await writeFile(source, 'export const sourceMarker = "regenerated";');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const built = await (native?.build ?? buildSourceRuntimeBundle)({ repoDir, outputDir: fixture.path('output'),
    component: 'server', sharedSourceInputs, env: native?.env ?? process.env });
  const loaded = await import(pathToFileURL(built.entrypoint));
  assert.equal(loaded.sourceMarker, 'captured');
  assert.equal(loaded.defaultMarker, loaded.sourceMarker);
  assert.equal(await loaded.sqliteMarker(), loaded.sourceMarker);
  assert.deepEqual([...await readFile(join(built.runtimeDir, 'generated/sqlite-client/engine.bin'))], [...engineBytes]);
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(built.runtimeDir, 'generated/sqlite-client/engine.bin'))).mode & 0o111, engineExecuteBits);
  }
  await writeFile(join(generated, 'index.cjs'), 'exports.schemaMarker = "next-regeneration";');
  await writeFile(sqlite, 'exports.schemaMarker = "next-regeneration";');
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const loaded = await import(${JSON.stringify(pathToFileURL(built.entrypoint).href)});
    assert.equal(loaded.defaultMarker, loaded.sourceMarker);
    assert.equal(await loaded.sqliteMarker(), loaded.sourceMarker);
  `]);
});

test('shared source capture bundles component imports from the same capture before a new Protocol file', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-shared-membership-' });
  const repoDir = fixture.path('repo');
  await mkdir(repoDir);
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  for (const [directory, name, dependencies] of [
    ['apps/cli', '@happier-dev/cli', { '@happier-dev/plugin-sdk': 'workspace:*' }],
    ['apps/server', '@happier-dev/server', { '@happier-dev/plugin-sdk': 'workspace:*' }],
    ['packages/plugin-sdk', '@happier-dev/plugin-sdk', { '@happier-dev/protocol': 'workspace:*' }],
    ['packages/protocol', '@happier-dev/protocol', {}],
  ]) {
    await mkdir(join(repoDir, directory, 'src'), { recursive: true });
    await writeFile(join(repoDir, directory, 'package.json'), JSON.stringify({ name, type: 'module', dependencies }));
  }
  await mkdir(join(repoDir, 'apps/server/sources'));
  for (const entry of ['apps/cli/src/index.ts', 'apps/server/sources/main.light.ts']) {
    await writeFile(join(repoDir, entry), 'export { version } from "../../../packages/plugin-sdk/src/bridge";');
  }
  await writeFile(join(repoDir, 'packages/protocol/src/shared.ts'), 'export const version = "shared-capture";');
  const bridge = join(repoDir, 'packages/plugin-sdk/src/bridge.ts');
  await writeFile(bridge, 'export { version } from "../../protocol/src/shared";');
  const sharedSourceInputs = await captureSourceRuntimeSharedInputs({ repoDir, outputDir: fixture.path('shared') });
  // The later consumer capture models a producer that waited for admission.
  await writeFile(join(repoDir, 'packages/protocol/src/added.ts'), 'export const version = "later-capture";');
  await writeFile(bridge, 'export { version } from "../../protocol/src/added";');
  const esbuild = createRequire(import.meta.url)('esbuild');
  t.after(() => esbuild.stop());
  for (const component of ['server', 'daemon']) {
    const captured = await captureSourceWebBuildInputs({ repoDir, component,
      outputDir: fixture.path(component), sharedSourceInputs });
    const entry = component === 'daemon' ? 'apps/cli/src/index.ts' : 'apps/server/sources/main.light.ts';
    const output = fixture.path(`${component}.mjs`);
    await esbuild.build({ entryPoints: [join(captured.repoDir, entry)], outfile: output,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    assert.equal((await import(pathToFileURL(output))).version, 'shared-capture');
    assert.equal(captured.files.includes('packages/protocol/src/added.ts'), false);
  }
  const fresh = await captureSourceRuntimeSharedInputs({ repoDir, outputDir: fixture.path('next-shared') });
  const next = await captureSourceWebBuildInputs({ repoDir, component: 'daemon', outputDir: fixture.path('next'),
    sharedSourceInputs: fresh });
  assert.equal(await readFile(join(next.repoDir, 'packages/protocol/src/added.ts'), 'utf8'),
    'export const version = "later-capture";');
});

test('daemon source capture derives complete manifests through an alias while the published set is absent', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-capture-alias-' });
  const parent = fixture.path('physical');
  await mkdir(parent);
  const alias = fixture.path('alias');
  await symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  // macOS /var/folders aliases /private/var/folders. Exercise the real capture
  // and generator through that filesystem relationship on every platform.
  const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const publishedSet = resolve(repoDir, 'apps/cli/assets/bundled-plugin-manifests');
  const readdirSync = fs.readdirSync;
  // A remote mirror can expose no published files during a rename transition.
  // Model that OS listing boundary; keep inventory, capture and derivation real.
  t.mock.method(fs, 'readdirSync', (path, ...args) => resolve(String(path)) === publishedSet
    ? [] : readdirSync(path, ...args));
  syncBuiltinESMExports();
  let captured;
  try {
    captured = await captureSourceWebBuildInputs({ repoDir,
      outputDir: join(alias, 'workspace'), component: 'daemon' });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(captured.files.some(path => path.startsWith('apps/cli/assets/bundled-plugin-manifests/')), false);
  const output = fixture.path('projections');
  await promisify(execFile)(process.execPath, sourceBuildNodeArgs({
    repoDir: captured.repoDir,
    scriptPath: join(captured.repoDir, 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts'),
    args: ['--daemon-projections', '--daemon-output-root', output],
  }), { cwd: captured.repoDir });
  const locatorPath = join(output, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
  await access(locatorPath);
  const { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: locators } = await import(pathToFileURL(locatorPath));
  assert.ok(locators.length > 0);
  for (const locator of locators) {
    const manifest = JSON.parse(await readFile(join(output, 'apps/cli', locator.manifestRelativePath), 'utf8'));
    assert.equal(manifest.id, locator.pluginId);
  }
});

test('revision capture takes committed bytes plus only the declared overlay, never other checkout edits', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-revision-capture-' });
  const repoDir = fixture.path('repo');
  await mkdir(repoDir);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  await gitIn('init', '--quiet');
  await writeFile(join(repoDir, '.gitignore'), 'generated/\n');
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  for (const [directory, name, dependencies] of [
    ['apps/cli', '@happier-dev/cli', { '@happier-dev/protocol': 'workspace:*' }],
    ['apps/server', '@happier-dev/server', { '@happier-dev/protocol': 'workspace:*' }],
    ['packages/protocol', '@happier-dev/protocol', {}],
  ]) {
    await mkdir(join(repoDir, directory, 'src'), { recursive: true });
    await writeFile(join(repoDir, directory, 'package.json'), JSON.stringify({ name, type: 'module', dependencies }));
  }
  await mkdir(join(repoDir, 'apps/server/sources'));
  const committed = {
    'apps/cli/src/index.ts': 'export { version } from "../../../packages/protocol/src/shared";',
    'apps/server/sources/main.light.ts': 'export { version } from "../../../packages/protocol/src/shared";',
    'packages/protocol/src/shared.ts': 'export const version = "committed";',
    'packages/protocol/src/kept.ts': 'export const kept = "committed";',
    'packages/protocol/src/late-edit.ts': 'export const late = "committed";',
    'packages/protocol/src/late-delete.ts': 'export const deleted = "committed";',
    'apps/cli/assets/bundled-plugin-manifests/example.json': '{"version":"committed"}',
  };
  for (const [path, text] of Object.entries(committed)) {
    await mkdir(dirname(join(repoDir, path)), { recursive: true });
    await writeFile(join(repoDir, path), text);
  }
  await gitIn('add', '-A');
  await gitIn('commit', '--quiet', '-m', 'rev');
  // Another lane's half edits in the shared checkout: a modified, an untracked and a deleted source.
  await writeFile(join(repoDir, 'packages/protocol/src/shared.ts'), 'export const version = "other-lane";');
  await writeFile(join(repoDir, 'packages/protocol/src/other-lane.ts'), 'export const other = "other-lane";');
  await rm(join(repoDir, 'packages/protocol/src/kept.ts'));
  // This Stack's own declared edit, and an ignored generated output.
  const overlayPath = 'apps/server/sources/main.light.ts';
  const overlayText = 'export const version = "my-overlay";';
  await writeFile(join(repoDir, overlayPath), overlayText);
  await mkdir(join(repoDir, 'packages/protocol/src/generated'));
  await writeFile(join(repoDir, 'packages/protocol/src/generated/out.ts'), 'export const generated = true;');
  // Another lane's new, untracked workspace package, already wired into the checkout's CLI manifest.
  await mkdir(join(repoDir, 'packages/other-lane-pkg/src'), { recursive: true });
  await writeFile(join(repoDir, 'packages/other-lane-pkg/package.json'), JSON.stringify({ name: '@happier-dev/other-lane-pkg', type: 'module' }));
  await writeFile(join(repoDir, 'packages/other-lane-pkg/src/index.ts'), 'export const other = true;');
  await writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module',
    dependencies: { '@happier-dev/protocol': 'workspace:*', '@happier-dev/other-lane-pkg': 'workspace:*' } }));
  const revision = await resolveSourceRevision({ repoDir, overlay: [overlayPath], outputDir: fixture.path('revisions') });
  // These paths were clean when described, then changed before either host captured.
  await writeFile(join(repoDir, 'packages/protocol/src/late-edit.ts'), 'export const late = "other-lane";');
  await rm(join(repoDir, 'packages/protocol/src/late-delete.ts'));
  await writeFile(join(repoDir, 'apps/cli/assets/bundled-plugin-manifests/example.json'), '{"version":"other-lane"}');
  const shared = await captureSourceRuntimeSharedInputs({ repoDir, outputDir: fixture.path('shared'), revision });
  const expected = { ...committed, [overlayPath]: overlayText, 'packages/protocol/src/other-lane.ts': null,
    'packages/protocol/src/generated/out.ts': 'export const generated = true;' };
  for (const component of ['server', 'daemon']) {
    const captured = await captureSourceWebBuildInputs({ repoDir, component, outputDir: fixture.path(component), sharedSourceInputs: shared });
    const leaks = [];
    for (const [path, text] of Object.entries(expected)) {
      if (path === (component === 'daemon' ? overlayPath : 'apps/cli/src/index.ts')) continue;
      if (component === 'server' && path.startsWith('apps/cli/assets/')) continue;
      const actual = await readFile(join(captured.repoDir, path), 'utf8').catch(() => null);
      if (actual !== text || captured.files.includes(path) !== (text !== null)) leaks.push(path);
    }
    assert.deepEqual(leaks, [], `${component}: capture must equal the revision plus the declared overlay`);
    assert.equal(captured.revision?.revision, revision.revision);
    assert.equal(captured.revision?.overlayDigest, revision.overlayDigest);
  }
  // Direct captures (including mirror hosts without Git) use the same descriptor.
  const direct = await captureSourceWebBuildInputs({ repoDir, component: 'daemon',
    outputDir: fixture.path('direct'), revision });
  assert.equal(await readFile(join(direct.repoDir, 'packages/protocol/src/late-edit.ts'), 'utf8'),
    committed['packages/protocol/src/late-edit.ts']);
  assert.equal(await stat(join(direct.repoDir, 'packages/other-lane-pkg/package.json')).catch(() => null), null,
    'a workspace the revision does not contain is not part of its capture');
  // Declared overlays remain exact inputs, rather than silently falling back to Git.
  await writeFile(join(repoDir, overlayPath), 'export const version = "changed-overlay";');
  await assert.rejects(captureSourceRuntimeSharedInputs({ repoDir,
    outputDir: fixture.path('overlay-drift'), revision }), { code: 'BUILD_INPUTS_CHANGED' });
});
