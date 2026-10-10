import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
    run_number: 337,
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
    required: id === 'deploy_ui' ? requested : false,
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

test('combined release resume selects the channel-specific status artifact from the combined workflow run', () => {
  const combinedRun = originRun({ path: '.github/workflows/release-preview-and-production.yml' });
  const inspected = inspectReleaseResumeOrigin({
    originRun: combinedRun,
    artifacts: [
      statusArtifact(),
      statusArtifact({ id: 5678, name: 'happier-release-status-preview' }),
    ],
    expected: {
      repository: REPOSITORY,
      workflowPath: '.github/workflows/release-preview-and-production.yml',
      channel: 'preview',
      statusArtifactName: 'happier-release-status-preview',
    },
  });

  assert.equal(inspected.artifactId, 5678);
});

const expected = {
  repository: REPOSITORY,
  workflowPath: '.github/workflows/nightly-dev.yml',
  channel: 'dev',
};

test('combined release resume reuses only exact-source, channel-scoped successful mobile and OTA flows', () => {
  const workflowPath = '.github/workflows/release-preview-and-production.yml';
  const surfaces = [previewCliCandidate(), ...standardOptionalSurfaces(true)];
  surfaces.find((surface) => surface.id === 'deploy_ui').identity.expoAction = 'full';
  const prefix = 'Publish preview channel / deploy_ui / ';
  const flows = [
    ['promote', ['Publish Android OTA from validated bytes', 'Publish iOS OTA from validated bytes']],
    ['Mobile native (local runner) / Build (ios)', ['EAS build (pipeline)']],
    ['Mobile native (local runner) / Build (android)', ['EAS build (pipeline)']],
    ['Mobile APK release (local runner) / Sign and publish Android APK', ['Sign and publish APK with trusted control']],
  ];
  const jobs = flows.map(([name, steps], index) => ({
    id: 2000 + index, run_id: RUN_ID, head_sha: SOURCE_SHA,
    name: `${prefix}${name}`, status: 'completed', conclusion: 'success',
    steps: steps.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  }));
  const input = {
    originRun: originRun({ path: workflowPath }), artifacts: [statusArtifact()], downloadedDigest: DIGEST,
    status: status({ channel: 'preview', operationId: 'current-release', surfaces }),
    expected: { repository: REPOSITORY, workflowPath, channel: 'preview', sourceSha: SOURCE_SHA, operationId: 'current-release' },
    jobs: [{ jobs: jobs.slice(0, 2) }, { jobs: jobs.slice(2) }],
  };
  const complete = { ota: true, nativeIos: true, nativeAndroid: true, apk: true };
  const incomplete = { ota: false, nativeIos: false, nativeAndroid: false, apk: false };
  assert.deepEqual(resolveReleaseResume(input).uiCompleted, complete);
  assert.equal(resolveReleaseResume(input).resumeInputs.deployUi.expoAction, 'full', 'reuse does not reduce the approved release intent');
  assert.deepEqual(resolveReleaseResume({ ...input, jobs: undefined }).uiCompleted, incomplete);
  for (const patch of [
    { conclusion: 'failure' }, { conclusion: 'skipped' }, { status: 'in_progress' },
    { run_id: RUN_ID + 1 }, { head_sha: 'c'.repeat(40) },
    { name: 'Publish production channel / deploy_ui / promote' },
    { steps: jobs[0].steps.map((step) => ({ ...step, conclusion: 'skipped' })) },
    { steps: [...jobs[0].steps, jobs[0].steps[0]] },
  ]) {
    assert.deepEqual(resolveReleaseResume({ ...input, jobs: [{ ...jobs[0], ...patch }, ...jobs.slice(1)] }).uiCompleted,
      { ...complete, ota: false }, 'unproven OTA completion must not suppress publishing');
  }
  assert.deepEqual(resolveReleaseResume({ ...input, jobs: [...jobs, jobs[0]] }).uiCompleted, { ...complete, ota: false }, 'duplicate job evidence is ambiguous');
  assert.deepEqual(resolveReleaseResume({ ...input, jobs: jobs.filter((job) => !job.name.endsWith('Build (ios)')) }).uiCompleted,
    { ...complete, nativeIos: false }, 'a missing native platform remains scheduled');
  assert.deepEqual(resolveReleaseResume({ ...input, expected: { ...input.expected, sourceSha: '' } }).uiCompleted, incomplete);
  assert.deepEqual(resolveReleaseResume({ ...input, originRun: originRun({ path: workflowPath, head_sha: 'c'.repeat(40) }),
    artifacts: [statusArtifact({ workflow_run: { id: RUN_ID, head_sha: 'c'.repeat(40) } })] }).uiCompleted, incomplete,
  'control head alone cannot prove a different candidate checkout');
  for (const workflowPath of ['.github/workflows/release-preview-and-production.yml', '.github/workflows/release.yml']) {
    const workflowSha = 'c'.repeat(40);
    const prefix = workflowPath.endsWith('release-preview-and-production.yml') ? 'Publish preview channel / deploy_ui / ' : 'deploy_ui / ';
    const pinnedInput = {
      ...input,
      originRun: originRun({ path: workflowPath, head_sha: workflowSha }),
      artifacts: [statusArtifact({ workflow_run: { id: RUN_ID, head_sha: workflowSha } })],
      expected: { ...input.expected, workflowPath },
      jobs: jobs.map((job, index) => ({ ...job, head_sha: workflowSha, name: `${prefix}${flows[index][0]}` })),
    };
    assert.deepEqual(resolveReleaseResume(pinnedInput).uiCompleted, complete,
      'candidate-bound status and successful origin steps retain native completion under a different control SHA');
    assert.throws(() => resolveReleaseResume({ ...pinnedInput, expected: { ...pinnedInput.expected, sourceSha: workflowSha } }), /authorized source SHA/);
    for (const patch of [
      { run_id: RUN_ID + 1 }, { head_sha: SOURCE_SHA },
      { steps: [{ name: 'EAS build (pipeline)', status: 'completed', conclusion: 'skipped' }] },
    ]) {
      assert.deepEqual(resolveReleaseResume({ ...pinnedInput, jobs: pinnedInput.jobs.map((job, index) => index === 1 ? { ...job, ...patch } : job) }).uiCompleted,
        { ...complete, nativeIos: false }, 'different control must still require exact-origin successful native steps');
    }
  }
});

test('resume artifact download preserves binary bytes and fails on digest mismatch or failed GitHub download', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from([0x50, 0x4b, 0, 0xff, 0x80, 1]);
  const archivePath = path.join(root, 'artifact.zip');
  // GitHub's process boundary is faked; the downloader and digest policy remain real.
  fs.writeFileSync(path.join(root, 'gh'), `#!/usr/bin/env node\nprocess.stdout.write(Buffer.from(${JSON.stringify([...bytes])}));process.exitCode=Number(process.env.FAKE_GH_EXIT || 0);\n`, { mode: 0o755 });
  const download = (digest, exit = '0') => spawnSync(process.execPath, [
    new URL('./resolve-release-resume.mjs', import.meta.url).pathname, '--mode', 'download',
    '--expected-repository', REPOSITORY, '--artifact-id', '1234', '--artifact-digest', digest, '--archive-path', archivePath,
  ], { env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, FAKE_GH_EXIT: exit }, encoding: 'utf8' });
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const downloaded = download(digest);
  assert.equal(downloaded.status, 0, downloaded.stderr);
  assert.deepEqual(fs.readFileSync(archivePath), bytes);
  const corrupt = download(DIGEST);
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /digest.*match/);
  assert.notEqual(download(digest, '1').status, 0);
  fs.writeFileSync(path.join(root, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const marker = ${JSON.stringify(path.join(root, 'retried'))};
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, 'failed');
  process.stdout.write(Buffer.alloc(100, 0xff));
  process.stderr.write('gh: Service Unavailable (HTTP 503)');
  process.exitCode = 1;
} else {
  process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}));
}
`, { mode: 0o755 });
  const retried = download(digest);
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stderr, /retrying/);
  assert.deepEqual(fs.readFileSync(archivePath), bytes, 'retry replaces all partial archive bytes');
});

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
    uiCompleted: { ota: false, nativeIos: false, nativeAndroid: false, apk: false },
    desktop: { runNumber: 337, artifacts: {} },
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
    completed: {
      cliRolling: false,
      deployDocs: false,
      deployServer: false,
      deployUi: false,
      deployWebsite: false,
      docker: false,
      serverRolling: false,
      stackRolling: false,
      npm: false,
      uiWebRolling: false,
    },
  });
});

test('nightly desktop resume admits exact unsigned artifacts independently of missing or expired siblings', () => {
  const workflowSha = 'c'.repeat(40);
  const desktopArtifact = (platform, id, overrides = {}) => statusArtifact({
    id, name: `tauri-candidate-${platform}`, workflow_run: { id: RUN_ID, head_sha: workflowSha }, ...overrides,
  });
  const input = {
    originRun: originRun({ head_sha: workflowSha }),
    artifacts: [statusArtifact({ workflow_run: { id: RUN_ID, head_sha: workflowSha } }),
      desktopArtifact('darwin-aarch64', 101), desktopArtifact('darwin-x86_64', 102),
      desktopArtifact('linux-x86_64', 103), desktopArtifact('windows-x86_64', 104)],
    downloadedDigest: DIGEST, status: status(), expected,
  };
  assert.deepEqual(resolveReleaseResume(input).desktop, {
    runNumber: 337,
    artifacts: Object.fromEntries(['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64']
      .map((platform, index) => [platform, { id: index + 101, digest: DIGEST }])),
  });
  const desktopStatus = (candidateOriginRunId) => status({ surfaces: [...status().surfaces,
    { id: 'ui_desktop', state: 'failed', result: 'failed', identity: { sourceSha: SOURCE_SHA, verified: false, candidateOriginRunId } }] });
  assert.deepEqual(resolveReleaseResume({ ...input, status: desktopStatus(RUN_ID) }).desktop, resolveReleaseResume(input).desktop);
  assert.throws(() => resolveReleaseResume({ ...input, status: desktopStatus(RUN_ID - 1) }), new RegExp(`original desktop candidate run ${RUN_ID - 1}`));
  assert.throws(() => resolveReleaseResume({ ...input, status: desktopStatus('337\\nother=true') }), /origin run ID/);
  assert.deepEqual(resolveReleaseResume({ ...input, artifacts: [input.artifacts[0],
    desktopArtifact('darwin-aarch64', 101), desktopArtifact('linux-x86_64', 103, { expired: true })] }).desktop,
  { runNumber: 337, artifacts: { 'darwin-aarch64': { id: 101, digest: DIGEST } } });

  for (const artifacts of [
    [desktopArtifact('linux-x86_64', 103), desktopArtifact('linux-x86_64', 105)],
    [desktopArtifact('unknown', 103)],
    [desktopArtifact('linux-x86_64', 103, { workflow_run: { id: RUN_ID + 1, head_sha: workflowSha } })],
    [desktopArtifact('linux-x86_64', 103, { workflow_run: { id: RUN_ID, head_sha: SOURCE_SHA } })],
    [desktopArtifact('linux-x86_64', -1)],
    [desktopArtifact('linux-x86_64', 103, { digest: 'invalid' })],
    [desktopArtifact('linux-x86_64', 103, { expired: 'false' })],
  ]) {
    assert.throws(() => resolveReleaseResume({ ...input, artifacts: [input.artifacts[0], ...artifacts] }), /desktop|artifact/);
  }
  assert.throws(() => resolveReleaseResume({ ...input, originRun: { ...input.originRun, run_number: '337\nother=true' } }), /run number/);
});

test('nightly desktop resume selects channel-scoped artifacts and retains unambiguous legacy single-channel recovery', () => {
  const input = {
    originRun: originRun(), downloadedDigest: DIGEST, status: status(), expected,
    artifacts: [statusArtifact(),
      statusArtifact({ id: 101, name: 'tauri-candidate-dev-linux-x86_64' }),
      statusArtifact({ id: 102, name: 'tauri-candidate-preview-linux-x86_64' }),
      statusArtifact({ id: 103, name: 'tauri-candidate-production-linux-x86_64' })],
  };
  assert.deepEqual(resolveReleaseResume(input).desktop.artifacts, { 'linux-x86_64': { id: 101, digest: DIGEST } });
  assert.deepEqual(resolveReleaseResume({ ...input, artifacts: [input.artifacts[0], ...input.artifacts.slice(2)] }).desktop.artifacts, {});
  const legacy = statusArtifact({ id: 104, name: 'tauri-candidate-linux-x86_64' });
  assert.deepEqual(resolveReleaseResume({ ...input, artifacts: [input.artifacts[0], legacy] }).desktop.artifacts,
    { 'linux-x86_64': { id: 104, digest: DIGEST } });
  assert.throws(() => resolveReleaseResume({ ...input, artifacts: [...input.artifacts, legacy] }), /duplicate desktop/);
  assert.throws(() => resolveReleaseResume({ ...input, artifacts: [input.artifacts[0], input.artifacts[1], input.artifacts[1]] }), /duplicate desktop/);
});

test('standard and combined release recovery admit only exact channel finalized desktop artifacts for the requested desktop intent', () => {
  for (const workflowPath of ['.github/workflows/release.yml', '.github/workflows/release-preview-and-production.yml']) {
    const optional = standardOptionalSurfaces(true);
    optional.find((surface) => surface.id === 'deploy_ui').identity.desktopMode = 'build_and_publish';
    const input = {
      originRun: originRun({ path: workflowPath }), downloadedDigest: DIGEST,
      expected: { repository: REPOSITORY, workflowPath, channel: 'preview', sourceSha: SOURCE_SHA, operationId: 'operation-37' },
      status: status({ channel: 'preview', operationId: 'operation-37', surfaces: [previewCliCandidate(), ...optional] }),
      artifacts: [statusArtifact(),
        statusArtifact({ id: 101, name: 'tauri-updates-preview-linux-x86_64' }),
        statusArtifact({ id: 102, name: 'tauri-updates-production-linux-x86_64' }),
        statusArtifact({ id: 103, name: 'tauri-updates-preview-darwin-aarch64', expired: true }),
        statusArtifact({ id: 104, name: 'tauri-candidate-preview-windows-x86_64' })],
    };
    const desktop = resolveReleaseResume(input).desktop;
    assert.deepEqual(desktop, { runNumber: 337,
      artifacts: { 'windows-x86_64': { id: 104, digest: DIGEST } },
      finalizedArtifacts: { 'linux-x86_64': { id: 101, digest: DIGEST } } });
    for (const extra of [
      statusArtifact({ id: 105, name: 'tauri-updates-preview-linux-x86_64' }),
      statusArtifact({ id: 105, name: 'tauri-updates-preview-unknown' }),
      statusArtifact({ id: 105, name: 'tauri-updates-preview-darwin-x86_64', workflow_run: { id: RUN_ID + 1, head_sha: SOURCE_SHA } }),
      statusArtifact({ id: 105, name: 'tauri-updates-preview-darwin-x86_64', digest: 'invalid' }),
      statusArtifact({ id: 105, name: 'tauri-updates-linux-x86_64' }),
    ]) assert.throws(() => resolveReleaseResume({ ...input, artifacts: [...input.artifacts, extra] }), /desktop|artifact/);
    assert.throws(() => resolveReleaseResume({ ...input, expected: { ...input.expected, operationId: 'other' } }), /operation/);
    assert.throws(() => resolveReleaseResume({ ...input, expected: { ...input.expected, sourceSha: 'c'.repeat(40) } }), /source SHA/);
    const noDesktopStatus = { ...input.status, surfaces: input.status.surfaces.map((surface) => surface.id === 'deploy_ui'
      ? { ...surface, identity: { ...surface.identity, desktopMode: 'none' } } : surface) };
    assert.equal(resolveReleaseResume({ ...input, status: noDesktopStatus }).desktop, undefined);
  }
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

test('release resume preserves exact completed downstream publications without rerunning siblings', () => {
  const optionalSurfaces = standardOptionalSurfaces(true).map((surface) => ({
    ...surface,
    state: 'published',
    result: 'accepted',
    identity: {
      sourceSha: SOURCE_SHA,
      verified: false,
      ...(surface.identity ?? {}),
    },
  }));
  const resolved = resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status({
      channel: 'preview',
      surfaces: [previewCliCandidate(), ...optionalSurfaces],
    }),
    expected: {
      repository: REPOSITORY,
      workflowPath: '.github/workflows/release.yml',
      channel: 'preview',
    },
  });

  assert.deepEqual(resolved.completed, {
    cliRolling: false,
    deployDocs: true,
    deployServer: true,
    deployUi: true,
    deployWebsite: true,
    docker: true,
    serverRolling: false,
    stackRolling: false,
    npm: true,
    uiWebRolling: false,
  });
});

test('release resume preserves exact verified rolling projections without mutating them again', () => {
  const rollingSurfaces = [
    ['cli_rolling_release', 'cliRolling'],
    ['hstack_rolling_release', 'stackRolling'],
    ['server_rolling_release', 'serverRolling'],
    ['ui_web_rolling_release', 'uiWebRolling'],
  ].map(([id]) => ({
    id,
    requested: true,
    required: true,
    evidence: 'verified',
    state: 'complete',
    result: 'success',
    identity: { sourceSha: SOURCE_SHA, verified: true },
  }));
  const resolved = resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status({
      channel: 'preview',
      surfaces: [previewCliCandidate(), ...rollingSurfaces, ...standardOptionalSurfaces(false)],
    }),
    expected: {
      repository: REPOSITORY,
      workflowPath: '.github/workflows/release.yml',
      channel: 'preview',
    },
  });

  assert.equal(resolved.completed.cliRolling, true);
  assert.equal(resolved.completed.stackRolling, true);
  assert.equal(resolved.completed.serverRolling, true);
  assert.equal(resolved.completed.uiWebRolling, true);
});

test('release resume rejects rolling completion evidence without exact verified source identity', () => {
  const invalidRolling = {
    id: 'cli_rolling_release',
    requested: true,
    required: true,
    evidence: 'verified',
    state: 'complete',
    result: 'success',
    identity: { sourceSha: 'f'.repeat(40), verified: true },
  };
  assert.throws(() => resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status({
      channel: 'preview',
      surfaces: [previewCliCandidate(), invalidRolling, ...standardOptionalSurfaces(false)],
    }),
    expected: {
      repository: REPOSITORY,
      workflowPath: '.github/workflows/release.yml',
      channel: 'preview',
    },
  }), /cli_rolling_release source SHA/);
});

test('release resume rejects completed downstream evidence bound to another source', () => {
  const optionalSurfaces = standardOptionalSurfaces(false);
  optionalSurfaces[0] = {
    id: 'deploy_ui',
    requested: true,
    required: false,
    evidence: 'accepted',
    state: 'published',
    result: 'accepted',
    identity: {
      sourceSha: 'f'.repeat(40),
      verified: false,
      deployWeb: true,
      expoAction: 'none',
      desktopMode: 'none',
    },
  };

  assert.throws(() => resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status({ channel: 'preview', surfaces: [previewCliCandidate(), ...optionalSurfaces] }),
    expected: {
      repository: REPOSITORY,
      workflowPath: '.github/workflows/release.yml',
      channel: 'preview',
    },
  }), /deploy_ui source SHA/);
});

test('release resume preserves an explicitly requested UI no-op publication intent', () => {
  const releaseExpected = {
    repository: REPOSITORY,
    workflowPath: '.github/workflows/release.yml',
    channel: 'preview',
  };
  const optionalSurfaces = standardOptionalSurfaces(false);
  const deployUiIndex = optionalSurfaces.findIndex((surface) => surface.id === 'deploy_ui');
  optionalSurfaces[deployUiIndex] = {
    id: 'deploy_ui',
    requested: true,
    required: false,
    evidence: 'accepted',
    state: 'partial',
    result: 'skipped',
    identity: {
      sourceSha: SOURCE_SHA,
      verified: false,
      deployWeb: false,
      expoAction: 'none',
      desktopMode: 'none',
    },
  };

  const resolved = resolveReleaseResume({
    originRun: originRun({ path: '.github/workflows/release.yml' }),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status({
      channel: 'preview',
      surfaces: [previewCliCandidate(), ...optionalSurfaces],
    }),
    expected: releaseExpected,
  });

  assert.equal(resolved.requested.deployUi, true);
  assert.deepEqual(resolved.resumeInputs.deployUi, {
    deployWeb: false,
    expoAction: 'none',
    desktopMode: 'none',
  });
});

for (const workflowPath of ['.github/workflows/release.yml', '.github/workflows/release-preview-and-production.yml']) {
test(`${workflowPath} resume preserves full UI publication intent for exact recovery`, () => {
  const optionalSurfaces = standardOptionalSurfaces(false);
  const deployUiIndex = optionalSurfaces.findIndex((surface) => surface.id === 'deploy_ui');
  optionalSurfaces[deployUiIndex] = {
    id: 'deploy_ui',
    requested: true,
    required: true,
    evidence: 'accepted',
    state: 'failed',
    result: 'failed',
    identity: {
      sourceSha: SOURCE_SHA,
      verified: false,
      deployWeb: true,
      expoAction: 'full',
      desktopMode: 'build_and_publish',
    },
  };

  const resolved = resolveReleaseResume({
    originRun: originRun({ path: workflowPath }),
    artifacts: [statusArtifact()],
    downloadedDigest: DIGEST,
    status: status({
      channel: 'production',
      surfaces: [{
        ...previewCliCandidate(),
        identity: { ...previewCliCandidate().identity, version: '0.2.11' },
      }, ...optionalSurfaces],
    }),
    expected: {
      repository: REPOSITORY,
      workflowPath,
      channel: 'production',
    },
  });

  assert.deepEqual(resolved.resumeInputs.deployUi, {
    deployWeb: true,
    expoAction: 'full',
    desktopMode: 'build_and_publish',
  });
});
}

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
