import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseWorkflowRunPath,
  selectCandidateArtifact,
  validateCandidateRun,
} from './verify-github-candidate-run.mjs';

const RUN_ID = 123456;
const HEAD_SHA = 'a'.repeat(40);
const ARTIFACT_NAME = `cli-candidate-native-dev-1.2.3-dev.4-${HEAD_SHA}`;

function trustedRun(overrides = {}) {
  return {
    id: RUN_ID,
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    path: '.github/workflows/publish-cli-binaries.yml',
    head_branch: 'dev',
    head_sha: HEAD_SHA,
    repository: { full_name: 'happier-dev/happier' },
    head_repository: { full_name: 'happier-dev/happier' },
    ...overrides,
  };
}

function trustedArtifact(overrides = {}) {
  return {
    id: 789,
    name: ARTIFACT_NAME,
    expired: false,
    workflow_run: {
      id: RUN_ID,
      head_sha: HEAD_SHA,
    },
    ...overrides,
  };
}

test('candidate run admission accepts one successful canonical workflow run at the exact head SHA', () => {
  assert.doesNotThrow(() => validateCandidateRun(trustedRun(), {
    repository: 'happier-dev/happier',
    runId: RUN_ID,
    expectedWorkflowPath: '.github/workflows/publish-cli-binaries.yml',
    expectedHeadSha: HEAD_SHA,
    expectedChannel: 'dev',
  }));
});

for (const [expectedChannel, headBranch] of [
  ['dev', 'dev'],
  ['preview', 'preview'],
  ['stable', 'main'],
]) {
  test(`candidate run admission accepts ${expectedChannel} on its mapped workflow branch`, () => {
    assert.doesNotThrow(() => validateCandidateRun(trustedRun({
      head_branch: headBranch,
    }), {
      repository: 'happier-dev/happier',
      runId: RUN_ID,
      expectedWorkflowPath: '.github/workflows/publish-cli-binaries.yml',
      expectedHeadSha: HEAD_SHA,
      expectedChannel,
    }));
  });
}

for (const [label, overrides, expected, expectedChannel = 'dev'] of [
  ['wrong workflow', { path: '.github/workflows/untrusted.yml' }, /workflow path/],
  ['workflow context ref suffix instead of an exact REST path', { path: '.github/workflows/publish-cli-binaries.yml@dev' }, /workflow path/],
  ['cross-channel head branch', { head_branch: 'preview' }, /head branch.*channel/],
  ['qualified head branch ref instead of the exact REST branch', { head_branch: 'refs/heads/dev' }, /head branch.*channel/],
  ['missing head branch', { head_branch: '' }, /head branch.*channel/],
  ['stable candidate from dev', {}, /head branch.*channel/, 'stable'],
  ['wrong head SHA', { head_sha: 'b'.repeat(40) }, /head SHA/],
  ['non-success conclusion', { conclusion: 'failure' }, /successful completed run/],
  ['caller workflow event', { event: 'workflow_call' }, /workflow_dispatch/],
  ['fork repository', { head_repository: { full_name: 'attacker/happier' } }, /head repository/],
]) {
  test(`candidate run admission rejects ${label}`, () => {
    assert.throws(() => validateCandidateRun(trustedRun(overrides), {
      repository: 'happier-dev/happier',
      runId: RUN_ID,
      expectedWorkflowPath: '.github/workflows/publish-cli-binaries.yml',
      expectedHeadSha: HEAD_SHA,
      expectedChannel,
    }), expected);
  });
}

test('workflow-path parser remains available to the broader release identity verifier', () => {
  assert.deepEqual(
    parseWorkflowRunPath('.github/workflows/publish@cli-binaries.yml@dev'),
    {
      workflowPath: '.github/workflows/publish@cli-binaries.yml',
      workflowRef: 'dev',
    },
  );
});

test('candidate artifact admission returns the sole immutable artifact ID from the admitted run', () => {
  assert.equal(selectCandidateArtifact([trustedArtifact()], {
    artifactName: ARTIFACT_NAME,
    runId: RUN_ID,
    expectedHeadSha: HEAD_SHA,
  }), 789);
});

for (const [label, artifacts, expected] of [
  ['wrong artifact name', [trustedArtifact({ name: 'other' })], /exactly one candidate artifact/],
  ['expired artifact', [trustedArtifact({ expired: true })], /expired/],
  ['wrong artifact run', [trustedArtifact({ workflow_run: { id: 999, head_sha: HEAD_SHA } })], /workflow run/],
  ['wrong artifact head SHA', [trustedArtifact({ workflow_run: { id: RUN_ID, head_sha: 'b'.repeat(40) } })], /head SHA/],
  ['artifact substitution', [trustedArtifact(), trustedArtifact({ id: 790 })], /exactly one candidate artifact/],
]) {
  test(`candidate artifact admission rejects ${label}`, () => {
    assert.throws(() => selectCandidateArtifact(artifacts, {
      artifactName: ARTIFACT_NAME,
      runId: RUN_ID,
      expectedHeadSha: HEAD_SHA,
    }), expected);
  });
}
