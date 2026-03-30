import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldStageRepoForEasLocalBuild } from './should-stage-eas-local-build-repo.mjs';

test('shouldStageRepoForEasLocalBuild: defaults to false on host runs', () => {
  assert.equal(shouldStageRepoForEasLocalBuild({ env: {}, dryRun: false }), false);
});

test('shouldStageRepoForEasLocalBuild: can be enabled explicitly via env', () => {
  assert.equal(
    shouldStageRepoForEasLocalBuild({ env: { HAPPIER_PIPELINE_STAGE_EAS_LOCAL_BUILD: '1' }, dryRun: false }),
    true,
  );
});

test('shouldStageRepoForEasLocalBuild: can be disabled explicitly via env', () => {
  assert.equal(
    shouldStageRepoForEasLocalBuild({ env: { HAPPIER_PIPELINE_STAGE_EAS_LOCAL_BUILD: '0' }, dryRun: false }),
    false,
  );
});

test('shouldStageRepoForEasLocalBuild: never stages when running inside dagger context', () => {
  assert.equal(
    shouldStageRepoForEasLocalBuild({
      env: { HAPPIER_PIPELINE_STAGE_EAS_LOCAL_BUILD: '1', DAGGER_SESSION_TOKEN: '1' },
      dryRun: false,
    }),
    false,
  );
});

