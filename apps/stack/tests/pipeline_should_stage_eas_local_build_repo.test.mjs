import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldStageRepoForEasLocalBuild } from '../../../scripts/pipeline/expo/should-stage-eas-local-build-repo.mjs';

test('shouldStageRepoForEasLocalBuild returns false on dryRun', () => {
  assert.equal(shouldStageRepoForEasLocalBuild({ env: {}, dryRun: true }), false);
});

test('shouldStageRepoForEasLocalBuild returns false when pipeline runtime is dagger', () => {
  assert.equal(shouldStageRepoForEasLocalBuild({ env: { HAPPIER_PIPELINE_LOCAL_RUNTIME: 'dagger' }, dryRun: false }), false);
});

test('shouldStageRepoForEasLocalBuild returns false when DAGGER_SESSION_TOKEN is set', () => {
  assert.equal(shouldStageRepoForEasLocalBuild({ env: { DAGGER_SESSION_TOKEN: 't' }, dryRun: false }), false);
});

test('shouldStageRepoForEasLocalBuild returns false when DAGGER_SESSION_PORT is set', () => {
  assert.equal(shouldStageRepoForEasLocalBuild({ env: { DAGGER_SESSION_PORT: '1234' }, dryRun: false }), false);
});

test('shouldStageRepoForEasLocalBuild returns true on host runs', () => {
  assert.equal(shouldStageRepoForEasLocalBuild({ env: {}, dryRun: false }), true);
});
