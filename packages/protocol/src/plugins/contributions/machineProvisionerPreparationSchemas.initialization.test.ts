import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Cold Node ESM imports use the manifest publisher's actual source loader.
// Importing the publisher exercises its complete static graph without calling main.
const imports = ['./apps/cli/scripts/build-owned/generateBundledPluginEntries.ts',
  '@happier-dev/protocol/machines/managed/providerFactsV1'].map(entry => ({
  entry,
  result: spawnSync(process.execPath, [
    '--conditions=happier-source', '--import', './packages/cli-common/registerSourceRuntime.mjs', '--input-type=module', '-e',
    `import assert from 'node:assert/strict';
      await import('${entry}');
      const { MachineProvisionerPreparationBuildResultV1Schema: schema } =
        await import('@happier-dev/protocol/plugins/contributions/machineProvisionerPreparationSchemas');
      const artifact = { contributionRef: { pluginId: 'test.compute', localId: 'guest' },
        schemaVersion: 1, value: { image: 'prepared' } };
      assert.deepEqual(JSON.parse(JSON.stringify(schema.parse({ kind: 'ready', artifact }))), { kind: 'ready', artifact });
      assert.equal(schema.safeParse({ kind: 'ready', artifact: { ...artifact, schemaVersion: 0 } }).success, false);
      assert.equal(schema.safeParse({ kind: 'ready', artifact: { ...artifact, extra: true } }).success, false);
      JSON.stringify(schema.jsonSchema);`,
  ], {
    cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
    encoding: 'utf8',
    env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../../apps/cli/tsconfig.runtime.json', import.meta.url)) },
  }),
}));

it.each(imports)('loads and validates preparation contracts through the cold $entry entry', ({ result }) => {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
