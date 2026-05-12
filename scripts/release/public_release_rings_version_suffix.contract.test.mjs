import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRollingVersionSuffix } from '../pipeline/release/lib/public-release-rings.mjs';

test('rolling version suffix uses a single sequence number without GitHub attempt', () => {
  const previousRunNumber = process.env.GITHUB_RUN_NUMBER;
  const previousRunAttempt = process.env.GITHUB_RUN_ATTEMPT;
  try {
    process.env.GITHUB_RUN_NUMBER = '456';
    process.env.GITHUB_RUN_ATTEMPT = '7';

    assert.equal(resolveRollingVersionSuffix('publicdev'), 'dev.456');
  } finally {
    if (previousRunNumber == null) delete process.env.GITHUB_RUN_NUMBER;
    else process.env.GITHUB_RUN_NUMBER = previousRunNumber;
    if (previousRunAttempt == null) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = previousRunAttempt;
  }
});
