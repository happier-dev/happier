import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRetainedVersionIds } from '../dist/firstPartyRuntime/index.js';

test('retention policy keeps current and previous by default', () => {
  const retained = resolveRetainedVersionIds({
    orderedVersionIdsNewestFirst: ['3.0.0', '2.0.0', '1.0.0'],
    currentVersionId: '3.0.0',
    previousVersionId: '2.0.0',
  });

  assert.deepEqual(retained.keep, ['3.0.0', '2.0.0']);
  assert.deepEqual(retained.prune, ['1.0.0']);
});

test('retention policy fills remaining slots with newest available version when previous is missing', () => {
  const retained = resolveRetainedVersionIds({
    orderedVersionIdsNewestFirst: ['4.0.0', '3.0.0', '2.0.0', '1.0.0'],
    currentVersionId: '4.0.0',
    previousVersionId: null,
  });

  assert.deepEqual(retained.keep, ['4.0.0', '3.0.0']);
  assert.deepEqual(retained.prune, ['2.0.0', '1.0.0']);
});
