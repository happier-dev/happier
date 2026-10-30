import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { readBuildInputIdentity } from '../../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readSourceComponentBuildInputs, readSourcePluginUiBuildInputs } from './workspaceBuildInputs.mjs';

test('source web inputs retain dependency patches required by the captured UI preflight', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-web-patch-inputs-' });
  await writeFile(fixture.path('package.json'), '{}');
  await mkdir(fixture.path('patches'));
  const patch = 'patches/dependency.patch';
  await writeFile(fixture.path('pnpm-workspace.yaml'), `patchedDependencies:\n  dependency@1.0.0: ${patch}\n`);
  await writeFile(fixture.path(patch), 'authored patch');
  const inputs = await readSourceComponentBuildInputs({ repoDir: fixture.root, component: 'expo' });
  assert.ok(inputs.files.includes(patch), 'the captured patch declaration must have its authored patch bytes');
  assert.ok(inputs.watchPaths.includes(fixture.path('patches')), 'new patch membership must invalidate preparation');
  const identity = await readBuildInputIdentity({ sourceDir: fixture.root, files: inputs.files });
  await writeFile(fixture.path(patch), 'changed authored patch');
  assert.notEqual(await readBuildInputIdentity({ sourceDir: fixture.root, files: inputs.files }), identity);
});

test('source build inputs capture and watch pnpm dependency resolution and policy', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-pnpm-build-inputs-' });
  await writeFile(fixture.path('package.json'), '{}');
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await writeFile(fixture.path(name), '');
  }
  const inputs = await readSourceComponentBuildInputs({ repoDir: fixture.root, component: 'server' });
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    assert.ok(inputs.files.includes(name), `${name} must be captured`);
    assert.ok(inputs.watchPaths.includes(join(fixture.root, name)), `${name} must be watched`);
  }
});

test('source UI preparation captures its declaration projector and invalidates compiler reuse when it changes', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-declaration-inputs-' });
  await writeFile(fixture.path('package.json'), '{}');
  const owner = 'apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs';
  await mkdir(dirname(fixture.path(owner)), { recursive: true });
  await writeFile(fixture.path(owner), 'export const declaration = true;\n');
  const capture = await readSourceComponentBuildInputs({ repoDir: fixture.root, component: 'expo' });
  assert.ok(capture.files.includes(owner), 'finite source UI captures its imported projection owner');
  assert.ok(capture.watchPaths.includes(join(fixture.root, owner)), 'source UI observes projection owner changes');
  const compiler = await readSourcePluginUiBuildInputs({ repoDir: fixture.root, compiler: true });
  assert.ok(compiler.includes(owner), 'projection changes participate in the compiler input identity');
  const identity = await readBuildInputIdentity({ sourceDir: fixture.root, files: compiler });
  await writeFile(fixture.path(owner), 'export const declaration = false;\n');
  assert.notEqual(await readBuildInputIdentity({ sourceDir: fixture.root, files: compiler }), identity);
});

test('source plugin UI inputs admit shipped author Resources and exclude their generated publication outputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-resource-inputs-' });
  const root = fixture.path('packages/plugins/fixture');
  const manifest = { name: '@happier-dev/plugins-fixture', files: ['assets', 'dist', '.happier-plugin', 'package.json'] };
  const paths = ['src/index.ts', 'assets/i18n/en.json', 'dist/happier-plugin-ui/locale.json.bundle',
    '.happier-plugin/plugin.json', '.happier-plugin/ui/generated.json', '.happier-plugin/ui/hosted-web/source.html'];
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  for (const path of paths) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), '{}'); }
  const options = { repoDir: fixture.root, pluginDirectory: 'fixture', packages: new Map([[manifest.name, { root, manifest }]]) };
  const files = await readSourcePluginUiBuildInputs(options);
  const locale = 'packages/plugins/fixture/assets/i18n/en.json';
  assert.ok(files.includes(locale));
  const watchInputs = await readSourcePluginUiBuildInputs({ ...options, includeDirectories: true });
  assert.ok(watchInputs.includes('packages/plugins/fixture/assets/i18n'));
  assert.ok(files.includes('packages/plugins/fixture/.happier-plugin/ui/hosted-web/source.html'));
  assert.ok(watchInputs.every(path => path !== 'packages/plugins/fixture'
    && !path.startsWith('packages/plugins/fixture/dist')
    && (!path.startsWith('packages/plugins/fixture/.happier-plugin') || path.startsWith('packages/plugins/fixture/.happier-plugin/ui/hosted-web'))));
  const initial = await readBuildInputIdentity({ sourceDir: fixture.root, files });
  await writeFile(join(root, 'assets/i18n/en.json'), '{"label":"changed"}');
  const changed = await readBuildInputIdentity({ sourceDir: fixture.root, files });
  assert.notEqual(changed, initial);
  await writeFile(join(root, 'dist/happier-plugin-ui/locale.json.bundle'), 'generated-output-changed');
  await writeFile(join(root, '.happier-plugin/plugin.json'), 'generated-output-changed');
  assert.equal(await readBuildInputIdentity({ sourceDir: fixture.root, files }), changed);
});
