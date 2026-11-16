import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('lightweight price resolution and revision do not load the bundled Usage price snapshot', async (t) => {
  const result = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('../../packages/protocol/src/usage/', import.meta.url)),
      contents: "export { resolveUsageModelPrice, BUNDLED_USAGE_MODEL_PRICE_REVISION } from './usageModelPriceSchemas.ts';",
    },
    bundle: true, platform: 'node', format: 'esm', conditions: ['happier-source'],
    write: false, metafile: true, treeShaking: false, logLevel: 'silent',
  });
  const snapshots = Object.keys(result.metafile.inputs).filter(path => /usageModelPriceSnapshot\.(?:ts|json)$/.test(path));
  t.diagnostic(JSON.stringify({ snapshots, bundleBytes: result.outputFiles[0].contents.byteLength }));
  assert.deepEqual(snapshots, [], 'explicit tariff resolution and revision must retain no price snapshot');
});
