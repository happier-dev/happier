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
const STANDARD_OPTIONAL_SURFACE_IDS = ['deploy_ui', 'deploy_server', 'deploy_website', 'deploy_docs', 'docker', 'npm'];

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
    run: {
      id: RUN_ID,
      url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
      name: 'NIGHTLY — Dev Releases',
    },
    channel: 'dev',
    sourceSha: SOURCE_SHA,
    surfaces: [
      {
        id: 'cli-immutable-candidate',
        requested: true,
        required: true,
        evidence: 'verified',
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
        id: 'server-immutable-candidate',
        requested: true,
        required: true,
        evidence: 'verified',
        state: 'failed',
        result: 'failed',
      },
    ],
    terminal: 'failed',
    ...overrides,
  };
}

function previewCliCandidate() {
  return {
    ...status().surfaces[0],
    identity: { ...status().surfaces[0].identity, version: '0.2.10-preview.73' },
  };
}

function standardOptionalSurfaces(requested) {
  return STANDARD_OPTIONAL_SURFACE_IDS.map((id) => ({
    id,
    requested,
    required: false,
    evidence: 'accepted',
    state: requested ? 'failed' : 'not_requested',
    ...(requested ? { result: 'failed' } : {}),
    ...(requested && id === 'deploy_ui' ? {
      identity: {
        sourceSha: SOURCE_SHA,
        verified: false,
        deployWeb: true,
        expoAction: 'none',
        desktopMode: 'none',
      },
    } : {}),
    ...(requested && id === 'npm' ? {
      identity: {
        sourceSha: SOURCE_SHA,
        verified: false,
        publishCli: true,
        publishStack: false,
        publishServer: false,
      },
    } : {}),
  }));
}

const expected = {
  repository: REPOSITORY,
  workflowPath: '.github/workflows/nightly-dev.yml',
  channel: 'dev',
};

test('resume inspection binds one unexpired status artifact to the exact origin run and source', () => {
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
    requested: {
      deployDocs: false,
      deployServer: false,
      deployUi: false,
      deployWebsite: false,
      docker: false,
      npm: false,
    },
  });
});

test('release resume preserves originally requested optional publication surfaces', () => {
  const releaseExpected = {
    repository: REPOSITORY,
    workflowPath: '.github/workflows/release.yml',
    channel: 'preview',
  };
  const releaseRun = originRun({ path: '.github/workflows/release.yml' });
  const releaseStatus = status({
    channel: 'preview',
    surfaces: [
      previewCliCandidate(),
      ...standardOptionalSurfaces(true),
    ],
  });

  assert.deepEqual(resolveReleaseResume({
    originRun: releaseRun,
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: releaseStatus,
    expected: releaseExpected,
  }).requested, {
    deployDocs: true,
    deployServer: true,
    deployUi: true,
    deployWebsite: true,
    docker: true,
    npm: true,
  });
});

test('release resume fails closed when the origin status omits optional request intent', () => {
  assert.throws(() => resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status({
      channel: 'preview',
      surfaces: [previewCliCandidate()],
    }),
    expected: {
      repository: REPOSITORY,
      workflowPath: '.github/workflows/release.yml',
      channel: 'preview',
    },
  }), /missing requested surface/);
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

test('resume fails closed for workflow, source, artifact, channel, or duplicate-product drift', () => {
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
    status: status({
      surfaces: [status().surfaces[0], { ...status().surfaces[0], id: 'duplicate-cli' }],
    }),
    expected,
  }), /duplicate.*cli/);
});

test('release resume binds the conductor operation and authorized source when supplied', () => {
  const workflowSha = 'c'.repeat(40);
  const releaseExpected = {
    repository: REPOSITORY,
    workflowPath: '.github/workflows/release.yml',
    channel: 'preview',
    sourceSha: SOURCE_SHA,
    operationId: 'rel_release_20260810',
  };
  const releaseRun = originRun({ path: '.github/workflows/release.yml', head_sha: workflowSha });
  const releaseArtifact = statusArtifact({ workflow_run: { id: RUN_ID, head_sha: workflowSha } });
  const releaseStatus = status({
    operationId: 'rel_release_20260810',
    channel: 'preview',
    run: { ...status().run, name: 'RELEASE — Publish (rel_release_20260810)' },
    surfaces: [previewCliCandidate(), ...standardOptionalSurfaces(false)],
  });

  assert.equal(resolveReleaseResume({
    originRun: releaseRun,
    artifacts: [releaseArtifact],
    downloadedDigest: DIGEST,
    status: releaseStatus,
    expected: releaseExpected,
  }).sourceSha, SOURCE_SHA);

  assert.throws(() => resolveReleaseResume({
    originRun: releaseRun,
    artifacts: [releaseArtifact],
    downloadedDigest: DIGEST,
    status: { ...releaseStatus, operationId: 'rel_other_20260810' },
    expected: releaseExpected,
  }), /operation/);

  assert.throws(() => resolveReleaseResume({
    originRun: releaseRun,
    artifacts: [releaseArtifact],
    downloadedDigest: DIGEST,
    status: releaseStatus,
    expected: { ...releaseExpected, operationId: '' },
  }), /operation/, 'an emergency manual resume must not silently adopt a conductor-owned run');
});
