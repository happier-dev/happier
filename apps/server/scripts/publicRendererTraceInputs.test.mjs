import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { preparePublicRendererAssets } from './preparePublicRendererAssets.mjs';

// The source-runtime producer digests every traced input by reading it, so a
// traced path must be a real file, never an esbuild virtual entry such as
// "(disabled):crypto" for a module the browser build stubs out.
test('public renderer trace returns only readable source files', async () => {
  const inputs = await preparePublicRendererAssets({ traceInputs: true });
  assert.ok(inputs.length > 0);
  const missing = inputs.filter((path) => !existsSync(path));
  assert.deepEqual(missing, []);
});
