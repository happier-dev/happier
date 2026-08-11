import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectReleaseResumeOrigin,
  resolveReleaseResume,
} from './resolve-release-resume.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const REPOSITORY = 'happier-dev/happier';
const RUN_ID = 31495263783;

function originRun(overrides = {}) {
  return {
    id: RUN_ID,
    path: '.github/workflows/nightly-dev.yml',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'failure',
    head_branch: 'dev',
    head_sha: SOURCE_SHA,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function statusArtifact(overrides = {}) {
  return {
    id: 1234,
    name: 'happier-release-status',
    expired: false,
    digest: DIGEST,
    workflow_run: { id: RUN_ID, head_sha: SOURCE_SHA },
    ...overrides,
  };
}

function status(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'happier.release-status.v1',
    run: String(RUN_ID),
    channel: 'dev',
    sourceSha: SOURCE_SHA,
    surfaces: [
      {
        id: 'cli',
        requested: true,
        required: true,
        state: 'complete',
        result: 'success',
        identity: {
          verified: true,
          product: 'cli',
          sourceSha: SOURCE_SHA,
          version: '0.2.10-dev.73',
        },
      },
      {
        id: 'server',
        requested: true,
        required: true,
        state: 'failed',
        result: 'failed',
      },
    ],
    terminal: 'failed',
    ...overrides,
  };
}

const expected = {
  repository: REPOSITORY,
  workflowPath: '.github/workflows/nightly-dev.yml',
  channel: 'dev',
};

test('resume inspection binds one unexpired status artifact to the exact trusted origin run', () => {
  assert.deepEqual(inspectReleaseResumeOrigin({
    originRun: originRun(),
    artifacts: [statusArtifact()],
    expected,
  }), {
    artifactDigest: DIGEST,
    artifactId: 1234,
    workflowSha: SOURCE_SHA,
  });
});

test('resume resolution reuses only successful verified immutable candidates', () => {
  assert.deepEqual(resolveReleaseResume({
    originRun: originRun(),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status(),
    expected,
  }), {
    sourceSha: SOURCE_SHA,
    versions: {
      cli: '0.2.10-dev.73',
      stack: '',
      server: '',
      'ui-web': '',
    },
  });
});

test('resume rejects a status that cannot skip any completed candidate work', () => {
  assert.throws(() => resolveReleaseResume({
    originRun: originRun(),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status({ surfaces: [] }),
    expected,
  }), /no verified immutable candidates/);
});

test('resume fails closed for origin, artifact, digest, channel, source, or product drift', () => {
  assert.throws(() => inspectReleaseResumeOrigin({
    originRun: originRun({ path: '.github/workflows/release.yml' }),
    artifacts: [statusArtifact()],
    expected,
  }), /workflow path/);
  assert.throws(() => inspectReleaseResumeOrigin({
    originRun: originRun({ head_branch: 'feature/untrusted-control' }),
    artifacts: [statusArtifact()],
    expected,
  }), /control branch/);
  assert.throws(() => inspectReleaseResumeOrigin({
    originRun: originRun({ event: 'pull_request' }),
    artifacts: [statusArtifact()],
    expected,
  }), /event/);
  assert.throws(() => inspectReleaseResumeOrigin({
    originRun: originRun(),
    artifacts: [statusArtifact({ expired: true })],
    expected,
  }), /expired/);
  assert.throws(() => resolveReleaseResume({
    originRun: originRun(),
    artifacts: [statusArtifact()],
    downloadedDigest: `sha256:${'c'.repeat(64)}`,
    status: status(),
    expected,
  }), /digest/);
  assert.throws(() => resolveReleaseResume({
    originRun: originRun(),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status({ channel: 'preview' }),
    expected,
  }), /channel/);
  assert.throws(() => resolveReleaseResume({
    originRun: originRun(),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status({ sourceSha: 'd'.repeat(40) }),
    expected: { ...expected, sourceSha: SOURCE_SHA },
  }), /source SHA/);
  assert.throws(() => resolveReleaseResume({
    originRun: originRun(),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status({
      surfaces: [status().surfaces[0], { ...status().surfaces[0], id: 'duplicate-cli' }],
    }),
    expected,
  }), /duplicate.*cli/);
});

test('full release distinguishes workflow-control SHA from candidate source SHA', () => {
  const workflowSha = 'c'.repeat(40);
  const releaseRun = originRun({ path: '.github/workflows/release.yml', head_sha: workflowSha });
  const releaseArtifact = statusArtifact({ workflow_run: { id: RUN_ID, head_sha: workflowSha } });
  const releaseStatus = status({
    channel: 'preview',
    surfaces: [{
      ...status().surfaces[0],
      identity: { ...status().surfaces[0].identity, version: '0.2.10-preview.73' },
    }],
  });
  const result = resolveReleaseResume({
    originRun: releaseRun,
    artifacts: [releaseArtifact],
    downloadedDigest: DIGEST,
    status: releaseStatus,
    expected: {
      repository: REPOSITORY,
      workflowPath: '.github/workflows/release.yml',
      channel: 'preview',
      sourceSha: SOURCE_SHA,
    },
  });
  assert.equal(result.sourceSha, SOURCE_SHA);
  assert.equal(result.versions.cli, '0.2.10-preview.73');
});
