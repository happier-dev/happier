import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('packed Composer dogfood excludes its author-only test harness', async () => {
  const packageJson = JSON.parse(await readFile(join(fixtureRoot, 'package.json'), 'utf8'));

  assert.deepEqual(packageJson.files, ['.happier-plugin/plugin.json', 'dist', 'src']);
  assert.equal(packageJson.files.includes('test'), false);
  assert.equal(packageJson.files.includes('scripts'), false);
  assert.equal(
    packageJson.scripts?.prepack,
    'npm run manifest && npm run build:ui',
    'the canonical pack sandbox must materialize the manifest and referenced UI artifacts before npm selects package files',
  );
  assert.equal(packageJson.scripts?.['build:ui'], 'happier-plugin-build-ui --project-root .');
  assert.equal(
    packageJson.scripts?.['pack:fixture'],
    'node scripts/pack-fixture.mjs',
    'the fixture package must expose its direct packed-pair proof',
  );
});

test('packed Composer dogfood declares the canonical React Native authoring toolchain for prepack', async () => {
  const packageJson = JSON.parse(await readFile(join(fixtureRoot, 'package.json'), 'utf8'));

  assert.deepEqual(packageJson.dependencies, {
    ...PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies,
  });
  assert.deepEqual(packageJson.devDependencies, {
    ...PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies,
  });
  assert.equal(packageJson.peerDependencies, undefined);
});

test('Composer dogfood build config emits the manifest-selected native renderer on every live platform', async () => {
  const { pluginUiBuildConfig } = await import('../happier-plugin-ui.config.mjs');

  assert.deepEqual(pluginUiBuildConfig.targets, [{
    rendererId: 'issue-surface-native',
    entry: 'src/issueSurface.mjs',
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: {
      containerName: 'acme_composer_issue_dogfood_issue_surface_native',
      modulePath: './renderComposerIssueSurface',
      exportName: 'renderComposerIssueSurface',
    },
  }]);
});
