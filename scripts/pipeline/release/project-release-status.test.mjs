import test from 'node:test';
import assert from 'node:assert/strict';

import { projectReleaseStatus } from './project-release-status.mjs';

test('nightly status preserves an independently verified sibling after grouped failure', () => {
  const status = projectReleaseStatus('nightly', {
    RELEASE_RUN: '42',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/42',
    RELEASE_RUN_NAME: 'NIGHTLY — Dev Releases',
    SOURCE_SHA: 'a'.repeat(40),
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'failure',
    CLI_CANDIDATE_RESULT: 'success',
    CLI_CANDIDATE_VERSION: '1.2.3-dev.4',
    CLI_RESUME_VERIFIED: 'true',
  });

  const cli = status.surfaces.find((surface) => surface.id === 'cli-immutable-candidate');
  assert.equal(cli?.state, 'complete');
  assert.equal(cli?.identity?.verified, true);
  assert.equal(status.terminal, 'failed');
});

test('standard status keeps unrequested surfaces out of failure admission', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '43',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/43',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)',
    HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'preview',
    SOURCE_SHA: 'b'.repeat(40),
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'success',
    RELEASE_VERIFY_RESULT: 'success',
  });
  assert.equal(status.surfaces.find((surface) => surface.id === 'docker')?.state, 'not_requested');
  assert.equal(status.terminal, 'complete');
});
