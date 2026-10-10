import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  inspectReleaseResumeOrigin,
  main,
  resolveReleaseResume,
} from './resolve-release-resume.mjs';
import { projectReleaseStatus } from './project-release-status.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const REPOSITORY = 'happier-dev/happier';
const RUN_ID = 31495263783;

function originRun(overrides = {}) {
  return {
    id: RUN_ID,
    run_number: 337,
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

function standardInput(surfaces = [], extra = {}) {
  const operationId = 'rel_resumeports37';
  return {
    originRun: originRun({ path: '.github/workflows/release.yml' }),
    artifacts: [statusArtifact()], downloadedDigest: DIGEST,
    status: status({ channel: 'preview', operationId,
      run: { ...status().run, name: `RELEASE ${operationId}` },
      surfaces: [{ ...status().surfaces[0], identity: { ...status().surfaces[0].identity, version: '0.3.0-preview.73' } }, ...surfaces] }),
    expected: { repository: REPOSITORY, workflowPath: '.github/workflows/release.yml', channel: 'preview', sourceSha: SOURCE_SHA, operationId },
    ...extra,
  };
}

test('resume retains exact downstream completion, UI intent, Runner rolling state, and SDK integrity obligations', () => {
  const accepted = ['deploy_ui', 'deploy_server', 'deploy_website', 'deploy_docs', 'docker', 'npm'].map((id) => ({
    id, requested: true, state: 'published', result: 'accepted',
    identity: { sourceSha: SOURCE_SHA, verified: false,
      ...(id === 'deploy_ui' ? { deployWeb: true, expoAction: 'full', desktopMode: 'build_and_publish' } : {}) },
  }));
  const rolling = ['cli_rolling_release', 'hstack_rolling_release', 'server_rolling_release', 'runner_rolling_release', 'ui_web_rolling_release'].map((id) => ({
    id, requested: true, state: 'complete', result: 'success', identity: { sourceSha: SOURCE_SHA, verified: true },
  }));
  const input = standardInput([...accepted, ...rolling]);
  const resolved = resolveReleaseResume(input);
  assert.deepEqual(resolved.completed, {
    cliRolling: true, stackRolling: true, serverRolling: true, runnerRolling: true, uiWebRolling: true,
    deployUi: true, deployServer: true, deployWebsite: true, deployDocs: true, docker: true, npm: true,
  });
  assert.equal(resolved.requestedDeployUi, true);
  assert.equal(resolved.uiIntentRecorded, true);
  assert.deepEqual(resolved.resumeInputs.deployUi, { deployWeb: true, expoAction: 'full', desktopMode: 'build_and_publish' });
  for (const id of ['npm_plugin_sdk', 'npm_plugin_ui', 'npm_sdk']) {
    assert.equal(resolveReleaseResume(standardInput([...accepted, { id, requested: true }])).completed.npm, false);
  }
  for (const bad of [
    [...accepted, accepted[4]], [...rolling, rolling[3]],
    [{ ...accepted[4], identity: { sourceSha: 'c'.repeat(40), verified: false } }],
    [{ ...accepted[4], identity: { sourceSha: SOURCE_SHA, verified: true } }],
    [{ ...rolling[3], identity: { sourceSha: SOURCE_SHA, verified: false } }],
    [{ ...accepted[0], identity: { ...accepted[0].identity, desktopMode: 'invalid' } }],
  ]) assert.throws(() => resolveReleaseResume(standardInput(bad)), /duplicate|source SHA|verified|desktopMode/);
  const oldUi = { ...accepted[0], state: 'failed', result: 'failed', identity: { sourceSha: SOURCE_SHA, verified: false, expoAction: 'native_submit' } };
  const old = resolveReleaseResume(standardInput([oldUi]));
  assert.equal(old.uiIntentRecorded, false);
  assert.equal(old.uiExpoAction, 'native_submit');
});

test('resume CLI emits admitted channel completion and full saved UI intent to workflow outputs', async (t) => {
  const input = standardInput([{ id: 'deploy_ui', requested: true, state: 'published', result: 'accepted',
    identity: { sourceSha: SOURCE_SHA, verified: false, deployWeb: true, expoAction: 'native_submit', desktopMode: 'build_and_publish' } },
    { id: 'runner_rolling_release', requested: true, state: 'complete', result: 'success', identity: { sourceSha: SOURCE_SHA, verified: true } }]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-outputs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, value] of [['run', input.originRun], ['artifacts', input.artifacts], ['status', input.status]]) {
    fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(value));
  }
  const output = path.join(root, 'outputs');
  await main(['--mode', 'resolve', '--origin-run-json', path.join(root, 'run.json'), '--artifacts-json', path.join(root, 'artifacts.json'),
    '--status-json', path.join(root, 'status.json'), '--downloaded-digest', DIGEST, '--expected-repository', REPOSITORY,
    '--expected-workflow', '.github/workflows/release.yml', '--expected-channel', 'preview', '--expected-source-sha', SOURCE_SHA,
    '--expected-operation-id', input.expected.operationId, '--github-output', output]);
  const outputs = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  assert.equal(outputs.deploy_ui_complete, 'true');
  assert.equal(outputs.runner_rolling_complete, 'true');
  assert.equal(outputs.deploy_ui_requested, 'true');
  assert.equal(outputs.deploy_ui_intent_recorded, 'true');
  assert.equal(outputs.deploy_ui_web_requested, 'true');
  assert.equal(outputs.deploy_ui_expo_action, 'native_submit');
  assert.equal(outputs.deploy_ui_desktop_mode, 'build_and_publish');
  assert.equal(outputs.desktop_artifacts, '{}');
});

test('combined resume selects one channel artifact and exact matching UI job names from the sole release authority', () => {
  const ui = { id: 'deploy_ui', requested: true, state: 'failed', result: 'failed',
    identity: { sourceSha: SOURCE_SHA, verified: false, deployWeb: false, expoAction: 'native_submit', desktopMode: 'none' } };
  const input = standardInput([ui]);
  const job = (name) => ({ id: 77, run_id: RUN_ID, head_sha: SOURCE_SHA, name, status: 'completed', conclusion: 'success',
    steps: [{ name: 'EAS build (local runner) (pipeline)', status: 'completed', conclusion: 'success' }] });
  const suffix = 'deploy_ui / Mobile native (local runner) / Build (ios)';
  const scoped = { ...input, artifacts: [statusArtifact({ name: 'happier-release-status-preview' }),
    statusArtifact({ id: 5678, name: 'happier-release-status-production' })],
    expected: { ...input.expected, statusArtifactName: 'happier-release-status-preview' },
    jobs: [job(`Release preview channel / ${suffix}`), job(`Release production channel / ${suffix}`)] };
  assert.equal(resolveReleaseResume(scoped).uiCompleted.nativeIos, true);
  const apk = { ...job('Release preview channel / deploy_ui / Mobile APK release (local runner) / Sign and publish Android APK'),
    id: 78, steps: [{ name: 'Sign and publish APK with trusted control', status: 'completed', conclusion: 'success' }] };
  assert.equal(resolveReleaseResume({ ...scoped, jobs: [...scoped.jobs, apk] }).uiCompleted.apk, true);
  assert.equal(resolveReleaseResume({ ...scoped, jobs: [...scoped.jobs,
    job('Release preview channel / deploy_ui / Mobile APK release (local runner) / Build (android)')] }).uiCompleted.apk, false);
  assert.equal(resolveReleaseResume({ ...scoped, jobs: [scoped.jobs[1]] }).uiCompleted.nativeIos, false);
  assert.equal(resolveReleaseResume({ ...scoped, jobs: [...scoped.jobs, scoped.jobs[0]] }).uiCompleted.nativeIos, false);
  assert.throws(() => resolveReleaseResume({ ...scoped,
    expected: { ...scoped.expected, statusArtifactName: 'happier-release-status-production' } }), /artifact.*channel/);
  assert.throws(() => resolveReleaseResume({ ...scoped, originRun: { ...input.originRun, path: '.github/workflows/release-preview-and-production.yml' },
    expected: { ...scoped.expected, workflowPath: '.github/workflows/release-preview-and-production.yml' } }), /event|workflow/);
  assert.equal(resolveReleaseResume({ ...input, jobs: [job(`Release single channel / ${suffix}`)] }).uiCompleted.nativeIos, true);
  assert.equal(resolveReleaseResume({ ...input, jobs: [job(suffix), job(`Release single channel / ${suffix}`)] }).uiCompleted.nativeIos, false);
});

test('standard release resume retains successful mobile flows only under their saved exact Expo action', () => {
  const operationId = 'rel_mobilereuse37';
  const releaseStatus = (expoAction) => projectReleaseStatus('standard', {
    SOURCE_SHA, RELEASE_RUN: String(RUN_ID), RELEASE_RUN_URL: originRun().html_url,
    RELEASE_RUN_NAME: `RELEASE ${operationId}`, RELEASE_CHANNEL: 'preview', HMAINT_OPERATION_ID: operationId,
    REQUEST_CLI: 'true', CLI_CANDIDATE_RESULT: 'success', CLI_VERSION: '0.2.10-preview.73',
    IMMUTABLE_VERIFICATION_RESULT: 'success', REQUEST_DEPLOY_UI: 'true', DEPLOY_UI_RESULT: 'failure',
    DEPLOY_UI_EXPO_ACTION: expoAction,
  });
  const flows = [
    ['promote', ['Publish Android OTA from validated bytes', 'Publish iOS OTA from validated bytes']],
    ['Mobile native (local runner) / Build (ios)', ['EAS build (local runner) (pipeline)']],
    ['Mobile native (local runner) / Build (android)', ['EAS build (local runner) (pipeline)']],
    ['Mobile APK release (local runner) / Build (android)', ['EAS build (local runner) (pipeline)']],
  ];
  const jobs = flows.map(([name, steps], index) => ({
    id: 2000 + index, run_id: RUN_ID, head_sha: SOURCE_SHA,
    name: `deploy_ui / ${name}`, status: 'completed', conclusion: 'success',
    steps: steps.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  }));
  const input = {
    originRun: originRun({ path: '.github/workflows/release.yml' }), artifacts: [statusArtifact()], downloadedDigest: DIGEST,
    status: releaseStatus('native_submit'), jobs: [{ jobs }],
    expected: { repository: REPOSITORY, workflowPath: '.github/workflows/release.yml', channel: 'preview', sourceSha: SOURCE_SHA, operationId },
  };
  const nativeComplete = { ota: false, nativeIos: true, nativeAndroid: true, apk: true };
  const incomplete = { ota: false, nativeIos: false, nativeAndroid: false, apk: false };
  assert.equal(input.status.surfaces.find((surface) => surface.id === 'deploy_ui').identity.expoAction, 'native_submit');
  assert.equal(resolveReleaseResume(input).uiExpoAction, 'native_submit');
  assert.deepEqual(resolveReleaseResume(input).uiCompleted, nativeComplete);
  assert.equal(resolveReleaseResume({ ...input, status: releaseStatus('native') }).uiExpoAction, 'native', 'build-only evidence retains its original mode');
  assert.deepEqual(resolveReleaseResume({ ...input, status: releaseStatus('ota') }).uiCompleted, { ...incomplete, ota: true });
  assert.deepEqual(resolveReleaseResume({ ...input, status: releaseStatus('full'), jobs: jobs.slice(0, 2) }).uiCompleted,
    { ota: true, nativeIos: true, nativeAndroid: false, apk: false }, 'full resumes only its completed components');
  assert.deepEqual(resolveReleaseResume({ ...input, status: releaseStatus(undefined) }).uiCompleted, incomplete, 'old statuses cannot prove the requested submit mode');
  assert.deepEqual(resolveReleaseResume({ ...input, status: releaseStatus('unsupported') }).uiCompleted, incomplete);
  assert.deepEqual(resolveReleaseResume({ ...input, jobs: undefined }).uiCompleted, incomplete);
  for (const patch of [{ conclusion: 'failure' }, { conclusion: 'skipped' }, { run_id: RUN_ID + 1 }, { head_sha: 'c'.repeat(40) },
    { name: 'Publish preview channel / deploy_ui / Mobile native (local runner) / Build (ios)' },
    { steps: [{ ...jobs[1].steps[0], conclusion: 'skipped' }] }]) {
    assert.deepEqual(resolveReleaseResume({ ...input, jobs: [jobs[0], { ...jobs[1], ...patch }, ...jobs.slice(2)] }).uiCompleted,
      { ...nativeComplete, nativeIos: false });
  }
  assert.deepEqual(resolveReleaseResume({ ...input, jobs: [...jobs, jobs[1]] }).uiCompleted, { ...nativeComplete, nativeIos: false });
  assert.deepEqual(resolveReleaseResume({ ...input, expected: { ...input.expected, sourceSha: '' } }).uiCompleted, incomplete);
  for (const combined of [false, true]) {
    const workflowSha = 'c'.repeat(40);
    const pinnedJobs = jobs.map((job, index) => ({ ...job, head_sha: workflowSha,
      name: `${combined ? 'Release preview channel' : 'Release single channel'} / deploy_ui / ${index === 3
        ? 'Mobile APK release (local runner) / Sign and publish Android APK' : flows[index][0]}`,
      ...(index === 3 ? { steps: [{ name: 'Sign and publish APK with trusted control', status: 'completed', conclusion: 'success' }] } : {}),
    }));
    const pinned = { ...input,
      originRun: { ...input.originRun, head_sha: workflowSha },
      artifacts: [statusArtifact({ name: combined ? 'happier-release-status-preview' : 'happier-release-status',
        workflow_run: { id: RUN_ID, head_sha: workflowSha } })],
      expected: { ...input.expected, ...(combined ? { statusArtifactName: 'happier-release-status-preview' } : {}) },
      jobs: pinnedJobs,
    };
    assert.deepEqual(resolveReleaseResume(pinned).uiCompleted, nativeComplete,
      'candidate-bound status and successful origin steps retain native completion under a different control SHA');
    assert.throws(() => resolveReleaseResume({ ...pinned, expected: { ...pinned.expected, sourceSha: workflowSha } }), /authorized source SHA/);
    for (const patch of [{ run_id: RUN_ID + 1 }, { head_sha: SOURCE_SHA },
      { steps: [{ ...pinnedJobs[1].steps[0], conclusion: 'skipped' }] }]) {
      assert.deepEqual(resolveReleaseResume({ ...pinned, jobs: pinnedJobs.map((job, index) => index === 1 ? { ...job, ...patch } : job) }).uiCompleted,
        { ...nativeComplete, nativeIos: false }, 'different control still requires exact-origin successful native steps');
    }
  }
});

test('standard release desktop recovery admits finalized artifacts from only the requested channel and exact origin', () => {
  const operationId = 'rel_desktopreuse37';
  const releaseStatus = projectReleaseStatus('standard', {
    SOURCE_SHA, RELEASE_RUN: String(RUN_ID), RELEASE_RUN_URL: originRun().html_url,
    RELEASE_RUN_NAME: `RELEASE ${operationId}`, RELEASE_CHANNEL: 'preview', HMAINT_OPERATION_ID: operationId,
    REQUEST_CLI: 'true', CLI_CANDIDATE_RESULT: 'success', CLI_VERSION: '0.2.10-preview.73',
    IMMUTABLE_VERIFICATION_RESULT: 'success', REQUEST_DEPLOY_UI: 'true', DEPLOY_UI_RESULT: 'failure',
  });
  const input = { originRun: originRun({ path: '.github/workflows/release.yml' }),
    downloadedDigest: DIGEST, status: releaseStatus,
    expected: { repository: REPOSITORY, workflowPath: '.github/workflows/release.yml', channel: 'preview', sourceSha: SOURCE_SHA, operationId },
    artifacts: [statusArtifact(), statusArtifact({ id: 101, name: 'tauri-updates-preview-linux-x86_64' }),
      statusArtifact({ id: 102, name: 'tauri-updates-production-linux-x86_64' }),
      statusArtifact({ id: 103, name: 'tauri-updates-preview-darwin-aarch64', expired: true }),
      statusArtifact({ id: 104, name: 'tauri-candidate-preview-windows-x86_64' })],
  };
  assert.deepEqual(resolveReleaseResume(input).desktop, { runNumber: 337,
    artifacts: { 'windows-x86_64': { id: 104, digest: DIGEST } },
    finalizedArtifacts: { 'linux-x86_64': { id: 101, digest: DIGEST } } });
  for (const extra of [
    statusArtifact({ id: 105, name: 'tauri-updates-preview-linux-x86_64' }),
    statusArtifact({ id: 105, name: 'tauri-updates-preview-unknown' }),
    statusArtifact({ id: 105, name: 'tauri-updates-preview-darwin-x86_64', workflow_run: { id: RUN_ID + 1, head_sha: SOURCE_SHA } }),
    statusArtifact({ id: 105, name: 'tauri-updates-preview-darwin-x86_64', digest: 'invalid' }),
    statusArtifact({ id: 105, name: 'tauri-updates-linux-x86_64' }),
  ]) assert.throws(() => resolveReleaseResume({ ...input, artifacts: [...input.artifacts, extra] }), /desktop|artifact/);
  const absentUi = { ...releaseStatus, surfaces: releaseStatus.surfaces.map((surface) => surface.id === 'deploy_ui'
    ? { ...surface, requested: false } : surface) };
  assert.equal(resolveReleaseResume({ ...input, status: absentUi }).desktop, undefined);
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
    statusArtifactName: 'happier-release-status',
  });
});

test('combined releases select the channel-specific status artifact from the shared run', async (t) => {
  const combinedExpected = {
    repository: REPOSITORY,
    workflowPath: '.github/workflows/release.yml',
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
    statusArtifactName: 'happier-release-status-preview',
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-scoped-inspect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'run.json'), JSON.stringify(originRun({ path: combinedExpected.workflowPath })));
  fs.writeFileSync(path.join(root, 'artifacts.json'), JSON.stringify([
    statusArtifact({ id: 5678, name: 'happier-release-status-preview' }),
    statusArtifact({ id: 9012, name: 'happier-release-status-production' }),
  ]));
  const result = await main(['--mode', 'inspect', '--origin-run-json', path.join(root, 'run.json'),
    '--artifacts-json', path.join(root, 'artifacts.json'), '--expected-repository', REPOSITORY,
    '--expected-workflow', combinedExpected.workflowPath, '--expected-channel', 'preview',
    '--github-output', path.join(root, 'outputs')]);
  assert.equal(result.artifactId, 5678, 'the CLI default delegates selection to canonical channel admission');
  assert.match(fs.readFileSync(path.join(root, 'outputs'), 'utf8'), /^artifact_id=5678$/m);
});

test('automatic status selection fails closed on missing channel, ambiguous topology, or invalid scoped status', () => {
  const expected = { repository: REPOSITORY, workflowPath: '.github/workflows/release.yml', channel: 'preview' };
  const origin = originRun({ path: expected.workflowPath });
  const preview = statusArtifact({ name: 'happier-release-status-preview' });
  const production = statusArtifact({ id: 5678, name: 'happier-release-status-production' });
  const inspect = (artifacts, expectation = expected) => inspectReleaseResumeOrigin({ originRun: origin, artifacts, expected: expectation });
  for (const artifacts of [[production], [preview, preview], []]) {
    assert.throws(() => inspect(artifacts), /exactly one/);
  }
  for (const artifacts of [[preview, statusArtifact()], [production, statusArtifact()]]) {
    assert.throws(() => inspect(artifacts), /ambiguous/);
  }
  assert.throws(() => inspect([{ ...preview, expired: true }]), /expired/);
  assert.throws(() => inspect([{ ...preview, workflow_run: { id: RUN_ID + 1, head_sha: SOURCE_SHA } }]), /exact origin/);
  assert.throws(() => inspect([preview], { ...expected, statusArtifactName: production.name }), /workflow and channel/);
  assert.throws(() => inspectReleaseResumeOrigin({ originRun: originRun(), artifacts: [preview], expected: {
    repository: REPOSITORY, workflowPath: '.github/workflows/nightly-dev.yml', channel: 'dev',
  } }), /exactly one happier-release-status artifact/);
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
    uiExpoAction: '',
    uiCompleted: { ota: false, nativeIos: false, nativeAndroid: false, apk: false },
    desktop: { runNumber: 337, artifacts: {} },
    versions: {
      cli: '0.2.10-dev.73',
      stack: '',
      server: '',
      runner: '',
      'ui-web': '',
    },
    requested: {
      cli: true,
      stack: false,
      server: true,
      runner: false,
      'ui-web': false,
    },
    completed: {
      cliRolling: false, stackRolling: false, serverRolling: false, runnerRolling: false, uiWebRolling: false,
      deployUi: false, deployServer: false, deployWebsite: false, deployDocs: false, docker: false, npm: false,
    },
  });
});

test('nightly desktop resume admits exact unsigned artifacts independently of missing or expired siblings', () => {
  const workflowSha = 'c'.repeat(40);
  const desktopArtifact = (platform, id, overrides = {}) => statusArtifact({
    id, name: `tauri-candidate-dev-${platform}`, workflow_run: { id: RUN_ID, head_sha: workflowSha }, ...overrides,
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
  const legacy = desktopArtifact('linux-x86_64', 103, { name: 'tauri-candidate-linux-x86_64' });
  assert.deepEqual(resolveReleaseResume({ ...input, artifacts: [input.artifacts[0], legacy] }).desktop.artifacts,
    { 'linux-x86_64': { id: 103, digest: DIGEST } }, 'predecessor single-channel nightly artifacts remain recoverable');
  assert.throws(() => resolveReleaseResume({ ...input, artifacts: [...input.artifacts, legacy] }), /duplicate desktop/);
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
    [desktopArtifact('linux-x86_64', 103, { name: 'tauri-candidate-preview-linux-x86_64' })],
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
