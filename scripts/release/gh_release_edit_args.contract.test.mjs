import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRollingReleaseEditArgs } from '../pipeline/github/lib/gh-release-commands.mjs';

test('rolling release edit args do not set target commitish', () => {
  const args = buildRollingReleaseEditArgs({
    tag: 'cli-preview',
    title: 'Happier CLI Preview',
    notes: 'Rolling preview',
  });
  assert.deepEqual(args.slice(0, 3), ['release', 'edit', 'cli-preview']);
  assert.doesNotMatch(args.join(' '), /\s--target\s/);
});
