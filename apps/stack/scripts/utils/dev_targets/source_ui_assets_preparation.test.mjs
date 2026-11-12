// @happier-test-preparation source
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  // Forward to the real compiler owner; installed Shiki and esbuild remain real.
  write(join(ui, 'scripts/prepareSourceUiAssets.mjs'),
    `export * from ${JSON.stringify(new URL('../../../../ui/scripts/prepareSourceUiAssets.mjs', import.meta.url).href)};`);
  symlinkSync(fileURLToPath(new URL('../../../../../node_modules', import.meta.url)), join(ui, 'node_modules'), 'dir');
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
  const before = statSync(output).mtimeMs;
  await prepare();
  assert.equal(statSync(output).mtimeMs, before, 'warm preparation preserves unchanged publication');
  unlinkSync(bundle);
  await prepare();
  assert.match(readFileSync(bundle, 'utf8'), /bonjour/, 'missing worker-local bundle is regenerated');
  write(join(ui, 'sources/text/translations/fr.ts'), "export const fr = { greeting: 'salut' };");
  await prepare();
  const updatedBundle = join(dirname(output), /require\("([^"\n]+)"\)/u.exec(readFileSync(output, 'utf8'))[1]);
  assert.match(readFileSync(updatedBundle, 'utf8'), /salut/);
});

test('UI source asset references stay with their worker-local bundles across source sync', () => {
  for (const path of Object.values(SOURCE_UI_ASSET_OUTPUT_PATHS)) {
    assert.ok(DEV_TARGET_MUTAGEN_IGNORE_PATHS.includes(`apps/ui/${path}`));
    assert.ok(!DEV_TARGET_MUTAGEN_IGNORE_PATHS.includes(`apps/ui/${path.replace(/\.js$/u, '.d.ts')}`),
      'authored declarations continue to synchronize');
  }
});
