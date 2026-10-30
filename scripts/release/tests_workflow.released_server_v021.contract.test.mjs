import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveReleaseValidationProfile } from '../pipeline/release-validation/registry.mjs';

test('normal release orchestration leaves the exact published-server regressions to diff-selected validation', () => {
  const stable = resolveReleaseValidationProfile('stable');
  assert.equal(stable?.checksProfile, 'full');

  const integrated = resolveReleaseValidationProfile('integrated');
  assert.equal(integrated?.checksProfile, 'fast');
});
