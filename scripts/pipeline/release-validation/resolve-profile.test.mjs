import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveNormalReleaseProfile } from './resolve-profile.mjs';

test('resolves supported normal profiles and rejects manual deep certification', () => {
  assert.deepEqual(resolveNormalReleaseProfile('integrated'), { profile: 'integrated', checksProfile: 'fast' });
  assert.deepEqual(resolveNormalReleaseProfile('stable'), { profile: 'stable', checksProfile: 'full' });
  assert.throws(() => resolveNormalReleaseProfile('deep'), /Unsupported normal release validation profile/);
});
