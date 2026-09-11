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
    head_sha: SOURCE_SHA,
    head_branch: 'dev',
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

test('combined releases select the channel-specific status artifact from the shared run', () => {
  const combinedExpected = {
    repository: REPOSITORY,
    workflowPath: '.github/workflows/release-preview-and-production.yml',
    channel: 'preview',
    statusArtifactName: 'happier-release-status-preview',
  };
  assert.deepEqual(inspectReleaseResumeOrigin({
    originRun: originRun({
      path: combinedExpected.workflowPath,
      event: 'workflow_dispatch',
    }),
    artifacts: [
      statusArtifact(),
      statusArtifact({ id: 5678, name: combinedExpected.statusArtifactName }),
    ],
    expected: combinedExpected,
  }), {
    artifactDigest: DIGEST,
    artifactId: 5678,
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
      cli: true,
      stack: false,
      server: true,
      'ui-web': false,
    },
    completed: {
      cliRolling: false,
      deployDocs: false,
      deployServer: false,
      deployUi: false,
      deployWebsite: false,
      docker: false,
      npm: false,
      serverRolling: false,
      stackRolling: false,
      uiWebRolling: false,
    },
  });
});

test('release resume preserves requested UI publication intent for exact recovery', () => {
  const deployUi = {
    id: 'deploy_ui', requested: true, required: true, evidence: 'accepted', state: 'failed', result: 'failed',
    identity: {
      sourceSha: SOURCE_SHA, verified: false, deployWeb: true,
      expoAction: 'full', desktopMode: 'build_and_publish',
    },
  };
  const resolved = resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status({
      channel: 'production',
      surfaces: [{ ...status().surfaces[0], identity: { ...status().surfaces[0].identity, version: '0.3.0' } }, deployUi],
    }),
    expected: { repository: REPOSITORY, workflowPath: '.github/workflows/release.yml', channel: 'production' },
  });
  assert.equal(resolved.requestedDeployUi, true);
  assert.deepEqual(resolved.resumeInputs.deployUi, {
    deployWeb: true, expoAction: 'full', desktopMode: 'build_and_publish',
  });
});

test('combined release resume preserves channel-specific UI publication intent', () => {
  const resolved = resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release-preview-and-production.yml' }),
    artifacts: [statusArtifact({ name: 'happier-release-status-preview' })],
    downloadedDigest: DIGEST,
    status: status({
      channel: 'preview',
      surfaces: [
        { ...status().surfaces[0], identity: { ...status().surfaces[0].identity, version: '0.3.0-preview.73' } },
        {
          id: 'deploy_ui', requested: true, required: true, evidence: 'accepted', state: 'failed', result: 'failed',
          identity: { sourceSha: SOURCE_SHA, verified: false, deployWeb: false, expoAction: 'full', desktopMode: 'build_and_publish' },
        },
      ],
    }),
    expected: {
      repository: REPOSITORY,
      workflowPath: '.github/workflows/release-preview-and-production.yml',
      channel: 'preview',
      statusArtifactName: 'happier-release-status-preview',
    },
  });
  assert.equal(resolved.requestedDeployUi, true);
  assert.deepEqual(resolved.resumeInputs.deployUi, {
    deployWeb: false, expoAction: 'full', desktopMode: 'build_and_publish',
  });
});

test('release resume preserves exact completed downstream publications without rerunning siblings', () => {
  const optionalSurfaces = ['deploy_ui', 'deploy_server', 'deploy_website', 'deploy_docs', 'docker', 'npm'].map((id) => ({
    id, requested: true, required: false, evidence: 'accepted', state: 'published', result: 'accepted',
    identity: { sourceSha: SOURCE_SHA, verified: false, ...(id === 'deploy_ui' ? { deployWeb: true, expoAction: 'full', desktopMode: 'build_and_publish' } : {}) },
  }));
  const resolved = resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }), artifacts: [statusArtifact()], downloadedDigest: DIGEST,
    status: status({ channel: 'preview', surfaces: [{ ...status().surfaces[0], identity: { ...status().surfaces[0].identity, version: '0.3.0-preview.73' } }, ...optionalSurfaces] }),
    expected: { repository: REPOSITORY, workflowPath: '.github/workflows/release.yml', channel: 'preview' },
  });
  assert.deepEqual(resolved.completed, {
    cliRolling: false,
    deployDocs: true,
    deployServer: true,
    deployUi: true,
    deployWebsite: true,
    docker: true,
    npm: true,
    serverRolling: false,
    stackRolling: false,
    uiWebRolling: false,
  });
});

test('release resume preserves exact verified rolling projections without mutating them again', () => {
  const rollingSurfaces = ['cli_rolling_release', 'hstack_rolling_release', 'server_rolling_release', 'ui_web_rolling_release'].map((id) => ({
    id, requested: true, required: false, evidence: 'verified', state: 'complete', result: 'success',
    identity: { sourceSha: SOURCE_SHA, verified: true },
  }));
  const resolved = resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }), artifacts: [statusArtifact()], downloadedDigest: DIGEST,
    status: status({ channel: 'preview', surfaces: [{ ...status().surfaces[0], identity: { ...status().surfaces[0].identity, version: '0.3.0-preview.73' } }, ...rollingSurfaces] }),
    expected: { repository: REPOSITORY, workflowPath: '.github/workflows/release.yml', channel: 'preview' },
  });
  assert.equal(resolved.completed.cliRolling, true);
  assert.equal(resolved.completed.stackRolling, true);
  assert.equal(resolved.completed.serverRolling, true);
  assert.equal(resolved.completed.uiWebRolling, true);
});

test('release resume rejects completed downstream evidence that is duplicate, unverifiable, or bound to another source', () => {
  const baseCandidate = { ...status().surfaces[0], identity: { ...status().surfaces[0].identity, version: '0.3.0-preview.73' } };
  const completeDocker = {
    id: 'docker', requested: true, required: false, evidence: 'accepted', state: 'published', result: 'accepted',
    identity: { sourceSha: SOURCE_SHA, verified: false },
  };
  assert.throws(() => resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }), artifacts: [statusArtifact()], downloadedDigest: DIGEST,
    status: status({ channel: 'preview', surfaces: [baseCandidate, completeDocker, completeDocker] }),
    expected: { repository: REPOSITORY, workflowPath: '.github/workflows/release.yml', channel: 'preview' },
  }), /duplicate resumable completion surface: docker/);
  assert.throws(() => resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }), artifacts: [statusArtifact()], downloadedDigest: DIGEST,
    status: status({ channel: 'preview', surfaces: [baseCandidate, { ...completeDocker, identity: { sourceSha: 'f'.repeat(40), verified: false } }] }),
    expected: { repository: REPOSITORY, workflowPath: '.github/workflows/release.yml', channel: 'preview' },
  }), /docker source SHA/);
  assert.throws(() => resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }), artifacts: [statusArtifact()], downloadedDigest: DIGEST,
    status: status({ channel: 'preview', surfaces: [baseCandidate, {
      id: 'cli_rolling_release', requested: true, required: false, evidence: 'verified', state: 'complete', result: 'success',
      identity: { sourceSha: SOURCE_SHA, verified: false },
    }] }),
    expected: { repository: REPOSITORY, workflowPath: '.github/workflows/release.yml', channel: 'preview' },
  }), /must carry verified identity evidence/);
});

test('release resume reruns npm when expanded SDK surfaces need integrity evidence', () => {
  const resolved = resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }), artifacts: [statusArtifact()], downloadedDigest: DIGEST,
    status: status({ channel: 'preview', surfaces: [{ ...status().surfaces[0], identity: { ...status().surfaces[0].identity, version: '0.3.0-preview.73' } },
      { id: 'npm', requested: true, required: false, evidence: 'accepted', state: 'published', result: 'accepted', identity: { sourceSha: SOURCE_SHA, verified: false } },
      { id: 'npm_sdk', requested: true, required: false, evidence: 'verified', state: 'complete', result: 'success', identity: { sourceSha: SOURCE_SHA, verified: true, package: '@happier-dev/sdk', version: '0.1.0-preview.3', integrity: 'sha512-sdk' } },
    ] }),
    expected: { repository: REPOSITORY, workflowPath: '.github/workflows/release.yml', channel: 'preview' },
  });
  assert.equal(resolved.completed.npm, false);
});

test('resume fails closed for workflow, source, artifact, channel, or duplicate-product drift', () => {
  assert.throws(() => inspectReleaseResumeOrigin({
    originRun: originRun({ path: '.github/workflows/release.yml' }),
    artifacts: [statusArtifact()],
    expected,
  }), /workflow path/);

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
    surfaces: [{
      ...status().surfaces[0],
      identity: { ...status().surfaces[0].identity, version: '0.2.10-preview.73' },
    }],
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
});
