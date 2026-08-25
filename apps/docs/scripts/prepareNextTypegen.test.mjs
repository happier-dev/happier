import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareNextTypegen } from './prepareNextTypegen.mjs';

test('clears only the generated Next route type subtree', async () => {
  const calls = [];

  await prepareNextTypegen({
    packageRoot: '/repo/apps/docs',
    rmImpl: async (path, options) => calls.push({ path, options }),
  });

  assert.deepEqual(calls, [{
    path: '/repo/apps/docs/.next/types',
    options: { recursive: true, force: true },
  }]);
});
