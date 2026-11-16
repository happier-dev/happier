// @happier-test-preparation source
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { prepareRemoteValidationWorkspace } from './remote_validation_preparation.mjs';
import { resolveRemoteCommandPolicy } from './remote_commands.mjs';
import { DEV_TARGET_MUTAGEN_IGNORE_PATHS } from './mutagen_ignore_paths.mjs';
import { SOURCE_UI_ASSET_OUTPUT_PATHS } from '../../../../ui/scripts/sourceUiAssetPaths.mjs';

test('UI suite preparation publishes usable source assets on cold, warm and missing-bundle entries', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-ui-source-assets-' });
  const ui = fixture.path('apps/ui');
  const write = (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  write(join(ui, 'package.json'), '{"name":"@fixture/ui","type":"module"}');
  write(fixture.path('package.json'), '{"private":true,"type":"module"}');
  write(join(ui, 'sources/text/_all.ts'), "export const SUPPORTED_LANGUAGE_CODES = ['en', 'fr'];");
  write(join(ui, 'sources/text/translations/fr.ts'), "export const fr = { greeting: 'bonjour' };");
  write(join(ui, 'sources/text/bundledPluginTranslations/fr.generated.ts'), 'export const BUNDLED_PLUGIN_TRANSLATIONS = {};');
  // Worker entries: the prepared public workers come from these sources.
  const workerEntries = { 'public/happier-crypto-worker.js': 'sources/sync/encryption/nativeCryptoWorker/webCryptoWorker.ts',
    'public/happier-password-kdf-worker.js': 'sources/auth/password/passwordKdf.worker.ts',
    'public/happier-atmosphere-worker.js': 'sources/components/atmosphere/atmosphere.worker.ts' };
  const writeWorkers = marker => {
    for (const [output, entry] of Object.entries(workerEntries)) write(join(ui, entry), `globalThis.workerMarker = ${JSON.stringify(`${output}:${marker}`)};`);
  };
  writeWorkers('first');
  // Forward to the real compiler owner; installed Shiki and esbuild remain real.
  write(join(ui, 'scripts/prepareSourceUiAssets.mjs'),
    `export * from ${JSON.stringify(new URL('../../../../ui/scripts/prepareSourceUiAssets.mjs', import.meta.url).href)};`);
  symlinkSync(fileURLToPath(new URL('../../../../../node_modules', import.meta.url)), join(ui, 'node_modules'), 'dir');
  // Classification reads the selected config's real source-resolver declaration.
  for (const config of ['vitest.config.ts', 'vitest.gesture-web.config.ts']) {
    cpSync(fileURLToPath(new URL(`../../../../ui/${config}`, import.meta.url)), join(ui, config));
  }
  const policy = resolveRemoteCommandPolicy(['pnpm', 'exec', 'vitest', 'run',
    '--config', 'vitest.gesture-web.config.ts', 'sources/components/sessions/shell/SessionListRow.gestureWeb.real.integration.test.tsx'],
    { cwd: ui, repoRoot: fixture.root });
  assert.equal(policy.kind, 'source-test');
  const prepare = () => prepareRemoteValidationWorkspace({ repoDir: fixture.root,
    componentRelativeDir: policy.component, validationKind: policy.kind });
  const output = join(ui, SOURCE_UI_ASSET_OUTPUT_PATHS.locales);
  await prepareRemoteValidationWorkspace({ repoDir: fixture.root, componentRelativeDir: 'apps/cli', validationKind: 'source-test' });
  assert.equal(existsSync(output), false, 'non-UI tests do not publish UI assets');
  await prepare();
  const contents = readFileSync(output, 'utf8');
  const bundle = join(dirname(output), /require\("([^"\n]+)"\)/u.exec(contents)[1]);
  assert.match(readFileSync(bundle, 'utf8'), /bonjour/);
  const shiki = join(ui, SOURCE_UI_ASSET_OUTPUT_PATHS.shiki);
  assert.match(readFileSync(shiki, 'utf8'), /SHIKI_LANGUAGE_ASSETS/);
  for (const output of Object.keys(workerEntries)) assert.match(readFileSync(join(ui, output), 'utf8'), new RegExp(`${output}:first`));
  assert.match(readFileSync(join(ui, 'sources/components/atmosphere/backdropWorkletCore.generated.js'), 'utf8'), /createAtmosphereWorkletCore/);
  const before = statSync(output).mtimeMs;
  const workersBefore = Object.keys(workerEntries).map(path => statSync(join(ui, path)).mtimeMs);
  await prepare();
  assert.equal(statSync(output).mtimeMs, before, 'warm preparation preserves unchanged publication');
  assert.deepEqual(Object.keys(workerEntries).map(path => statSync(join(ui, path)).mtimeMs), workersBefore, 'warm preparation preserves unchanged workers');
  writeWorkers('second');
  await prepare();
  for (const output of Object.keys(workerEntries)) assert.match(readFileSync(join(ui, output), 'utf8'), new RegExp(`${output}:second`));
  unlinkSync(bundle);
  await prepare();
  assert.match(readFileSync(bundle, 'utf8'), /bonjour/, 'missing worker-local bundle is regenerated');
  write(join(ui, 'sources/text/translations/fr.ts'), "export const fr = { greeting: 'salut' };");
  await prepare();
  const updatedBundle = join(dirname(output), /require\("([^"\n]+)"\)/u.exec(readFileSync(output, 'utf8'))[1]);
  assert.match(readFileSync(updatedBundle, 'utf8'), /salut/);
});

test('source sync preserves usable worker-local UI assets while updating their authored inputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-ui-asset-sync-' });
  const source = fixture.path('source');
  const mirror = fixture.path('mirror');
  const write = (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  mkdirSync(source, { recursive: true });
  execFileSync('git', ['init', '--quiet', source]);
  write(join(source, '.gitignore'), `${DEV_TARGET_MUTAGEN_IGNORE_PATHS.join('\n')}\n`);
  write(fixture.path('empty-excludes'), '');
  const sourceFiles = [];
  const outputs = [];
  for (const [kind, output] of Object.entries(SOURCE_UI_ASSET_OUTPUT_PATHS)) {
    const outputPath = `apps/ui/${output}`;
    const assetPath = host => `apps/ui/.expo/hstack/${kind}/${host}.bundle`;
    for (const [root, host] of [[source, 'controller'], [mirror, 'worker']]) {
      const specifier = relative(dirname(outputPath), assetPath(host)).replaceAll('\\', '/');
      write(join(root, outputPath), `export const asset = require(${JSON.stringify(specifier)});\n`);
      write(join(root, assetPath(host)), `${kind} ${host} bundle`);
    }
    sourceFiles.push(outputPath, assetPath('controller'));
    outputs.push(outputPath);
    const declaration = outputPath.replace(/\.js$/u, '.d.ts');
    write(join(source, declaration), 'export declare const asset: number;\n');
    sourceFiles.push(declaration);
  }
  const translation = 'apps/ui/sources/text/translations/fr.ts';
  write(join(source, translation), "export const fr = { greeting: 'salut' };\n");
  sourceFiles.push(translation);
  // Mutagen uses Git-style ignores; let Git select the actual copy set, as in
  // mutagen_project.test.mjs, rather than duplicating its matcher in this test.
  const ignored = new Set(execFileSync('git', ['-C', source, '-c', `core.excludesFile=${fixture.path('empty-excludes')}`,
    'check-ignore', '--no-index', '--stdin', '-z'], {
    input: `${sourceFiles.join('\0')}\0`, encoding: 'utf8',
  }).split('\0').filter(Boolean));
  const copied = sourceFiles.filter(path => !ignored.has(path));
  for (const path of copied) {
    mkdirSync(dirname(join(mirror, path)), { recursive: true });
    cpSync(join(source, path), join(mirror, path));
  }
  for (const output of outputs) {
    const reference = /require\("([^"\n]+)"\)/u.exec(readFileSync(join(mirror, output), 'utf8'))[1];
    const bundle = join(dirname(join(mirror, output)), reference);
    assert.ok(existsSync(bundle), 'source sync must not replace worker references with absent controller bundles');
    assert.match(readFileSync(bundle, 'utf8'), /worker bundle/);
  }
  assert.equal(copied.length, outputs.length + 1, 'only authored declarations and the changed translation synchronize');
  assert.match(readFileSync(join(mirror, translation), 'utf8'), /salut/);
  for (const output of outputs) assert.ok(existsSync(join(mirror, output.replace(/\.js$/u, '.d.ts'))));
  assert.equal(existsSync(join(mirror, 'apps/ui/.expo/hstack/locales/controller.bundle')), false,
    'controller Expo output remains excluded');
});

// P03 ORCH 2026-11-16: each prepared asset is keyed by its own inputs (the
// bundler's dependency list), so an edit outside its import closure (another
// lane's temp tsconfig, Metro config) never forces a rebuild.
test('a focused rerun with unchanged asset inputs compiles nothing, even after unrelated package edits', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-ui-asset-closure-' });
  const ui = fixture.path('apps/ui');
  const write = (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  write(join(ui, 'package.json'), '{"name":"@fixture/ui","type":"module"}');
  write(fixture.path('package.json'), '{"private":true,"type":"module"}');
  write(join(ui, 'sources/text/_all.ts'), "export const SUPPORTED_LANGUAGE_CODES = ['en', 'fr'];");
  write(join(ui, 'sources/text/translations/fr.ts'), "export const fr = { greeting: 'bonjour' };");
  write(join(ui, 'sources/text/bundledPluginTranslations/fr.generated.ts'), 'export const BUNDLED_PLUGIN_TRANSLATIONS = {};');
  for (const entry of ['sources/sync/encryption/nativeCryptoWorker/webCryptoWorker.ts', 'sources/auth/password/passwordKdf.worker.ts',
    'sources/components/atmosphere/atmosphere.worker.ts']) write(join(ui, entry), 'globalThis.workerMarker = 1;');
  write(join(ui, 'scripts/prepareSourceUiAssets.mjs'),
    `export * from ${JSON.stringify(new URL('../../../../ui/scripts/prepareSourceUiAssets.mjs', import.meta.url).href)};`);
  symlinkSync(fileURLToPath(new URL('../../../../../node_modules', import.meta.url)), join(ui, 'node_modules'), 'dir');
  // Files another lane edits all the time; none is read by an asset compiler.
  write(join(ui, 'tsconfig.lane.tmp.json'), '{"include":["a"]}');
  write(join(ui, 'metro.config.js'), 'export default {};');
  const counts = [];
  t.mock.method(console, 'log', (...values) => {
    const match = /phase=source-asset-input-reuse compiled=(\d+)/u.exec(values.join(' '));
    if (match) counts.push(Number(match[1]));
  });
  const prepare = () => prepareRemoteValidationWorkspace({ repoDir: fixture.root, componentRelativeDir: 'apps/ui',
    validationKind: 'source-test', focusedTest: true });
  await prepare();
  assert.ok(counts[0] > 0, 'the cold run compiles its assets');
  await prepare();
  assert.equal(counts[1], 0, 'a rerun with unchanged inputs does no preparation');
  write(join(ui, 'tsconfig.lane.tmp.json'), '{"include":["b"]}');
  write(join(ui, 'metro.config.js'), 'export default { changed: true };');
  await prepare();
  assert.equal(counts[2], 0, 'edits outside every asset import closure keep the prepared assets');
  write(join(ui, 'sources/text/translations/fr.ts'), "export const fr = { greeting: 'salut' };");
  await prepare();
  assert.ok(counts[3] > 0, 'an edit inside an asset import closure rebuilds it');
});
