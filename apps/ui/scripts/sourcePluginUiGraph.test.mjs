// @happier-test-preparation source
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createTempFixture } from '../../stack/scripts/testkit/core/temp_fixture.mjs';
import { readSourcePluginUiBuildInputs, readSourcePluginUiBuildInputRecord } from '../../stack/scripts/utils/fs/workspaceBuildInputs.mjs';

for (const inventory of [false, true]) {
  test(`export-only repairs invalidate failed plugin UI graphs (inventory=${inventory})`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'happier-ui-export-repair-' });
    const write = async (path, value) => {
      await mkdir(dirname(fixture.path(path)), { recursive: true });
      await writeFile(fixture.path(path), typeof value === 'string' ? value : JSON.stringify(value));
    };
    await write('packages/plugins/fixture/package.json', {
      name: '@happier-dev/plugins-fixture',
      exports: { './happier-plugin-ui/panel': './src/panel.ts' },
    });
    await write('packages/plugins/fixture/src/panel.ts', 'export { value } from "@fixture/shared/ui";');
    await write('packages/shared/src/ui.ts', 'export const value = "repaired";');
    await write('packages/unrelated/package.json', { name: '@fixture/unrelated' });
    const manifestPath = 'packages/shared/package.json';
    const options = { repoDir: fixture.root, pluginDirectory: 'fixture', inventory };
    for (const exports of [{}, { './ui': './src/missing.ts' }]) {
      await write(manifestPath, { name: '@fixture/shared', exports });
      const files = await readSourcePluginUiBuildInputs(options);
      assert.ok(files.includes(manifestPath), 'failed resolution must observe the export map that can repair it');
      assert.equal(files.includes('packages/unrelated/package.json'), false, 'unconsumed packages are not inputs');
      const retainedInputs = await readSourcePluginUiBuildInputRecord({ repoDir: fixture.root, files });
      await write(manifestPath, { name: '@fixture/shared', exports: { './ui': './src/ui.ts' } });
      const repaired = await readSourcePluginUiBuildInputs({ ...options, retainedInputs });
      assert.ok(repaired.includes('packages/shared/src/ui.ts'), 'export repair must rediscover the real dependency despite retained inputs');
    }
  });
}
