// @happier-test-preparation source
import '../../../packages/cli-common/registerSourceRuntime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectBundledPluginUiArtifactSources, generateBundledPluginUiArtifacts } from './generateBundledPluginUiArtifacts.mjs';

// All packaged inputs below are constructed in the fixture; no workspace dist
// or publication output is consumed by this source-only contract.
test('bundled UI membership excludes nonpackages and reservations while preserving shippable declarations', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-ui-membership-'));
  try {
    const pluginsRoot = join(repoRoot, 'packages/plugins');
    const validRoot = join(pluginsRoot, 'fixture');
    const reservedRoot = join(pluginsRoot, 'devcontainer');
    await mkdir(join(repoRoot, 'apps/ui'), { recursive: true });
    await mkdir(join(pluginsRoot, 'access-netbird/src'), { recursive: true });
    await mkdir(join(reservedRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(validRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(validRoot, 'dist/happier-plugin-ui'), { recursive: true });
    await writeFile(join(repoRoot, 'apps/ui/package.json'), JSON.stringify({ dependencies: {} }));
    await writeFile(join(reservedRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugins-devcontainer', version: '0.0.0',
      happier: { pluginScaffold: { shipping: 'reservation_only' } },
    }));
    // A reservation's incomplete brand must not enter packaged brand admission.
    await writeFile(join(reservedRoot, '.happier-plugin/plugin.json'), JSON.stringify({
      id: 'happier.devcontainer', brand: { iconResourceId: 'not-published' },
    }));
    await writeFile(join(validRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugins-fixture', version: '0.0.0',
    }));
    await writeFile(join(validRoot, '.happier-plugin/plugin.json'), JSON.stringify({
      schemaVersion: 2, id: 'happier.fixture', version: '0.0.0',
      displayName: 'Fixture', runtime: { apiVersion: 1 }, contributes: {},
    }));
    await writeFile(join(validRoot, 'dist/happier-plugin-ui/ui-artifacts.json'), JSON.stringify({ version: 2, entries: [] }));
    const result = await collectBundledPluginUiArtifactSources(repoRoot);
    assert.deepEqual(result.pluginFailures, []);
    assert.deepEqual(result.declarations.map(declaration => declaration.pluginId), ['happier.fixture']);
    const published = await generateBundledPluginUiArtifacts({ repoRoot, publicationMode: 'artifact' });
    assert.deepEqual(published.pluginFailures, []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
