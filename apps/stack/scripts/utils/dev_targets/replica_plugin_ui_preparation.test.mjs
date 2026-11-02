import '../../../../../packages/cli-common/registerSourceRuntime.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { prepareRemoteValidationWorkspace } from './remote_validation_preparation.mjs';
import { resolveBundledPluginUiArtifactsInputPaths } from '../../../../ui/scripts/generateBundledPluginUiArtifacts.mjs';

test('replica UI runtime preparation replaces a stale inventory even when no workspace package rebuilds', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-replica-plugin-ui-' });
  const ui = join(root, 'apps/ui');
  const cli = join(root, 'apps/cli');
  mkdirSync(join(ui, 'scripts'), { recursive: true });
  mkdirSync(cli, { recursive: true });
  mkdirSync(join(root, 'packages/plugins'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', bundledDependencies: [] }));
  writeFileSync(join(ui, 'package.json'), JSON.stringify({ name: '@happier-dev/ui', dependencies: {} }));
  // The fixture checkout consumes the real app-owned producer, not a second
  // implementation or a mocked package/domain preparation boundary.
  writeFileSync(join(ui, 'scripts/generateBundledPluginUiArtifacts.mjs'),
    `export { generateBundledPluginUiArtifacts } from ${JSON.stringify(new URL('../../../../ui/scripts/generateBundledPluginUiArtifacts.mjs', import.meta.url).href)};\n`);
  const inventory = join(ui, 'sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js');
  mkdirSync(dirname(inventory), { recursive: true });
  const stale = 'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = {};\nexport const stale = () => import("./declarations/removed/declaration.js");\n';
  writeFileSync(inventory, stale);
  assert.equal(resolveBundledPluginUiArtifactsInputPaths(inventory).every(path => existsSync(path)), false);

  await prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir: 'apps/ui', validationKind: 'runtime' });

  const paths = resolveBundledPluginUiArtifactsInputPaths(inventory);
  assert.ok(paths?.length, 'preparation publishes a valid inventory');
  assert.equal(paths.every(path => existsSync(path)), true, 'every reference exists on this replica');
  assert.notEqual(readFileSync(inventory, 'utf8'), stale);
});
