import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRollingReleaseEditArgs } from '../pipeline/github/lib/gh-release-commands.mjs';

test('rolling release edit args include --target sha', () => {
  const args = buildRollingReleaseEditArgs({
    tag: 'cli-preview',
    title: 'Happier CLI Preview',
    notes: 'Rolling preview',
    targetSha: 'deadbeef',
  });
  assert.deepEqual(args.slice(0, 3), ['release', 'edit', 'cli-preview']);
  assert.ok(args.includes('--target'));
  assert.ok(args.includes('deadbeef'));
});

