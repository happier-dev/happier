import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { summarizeReleaseStatus } from './summarize-release-status.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./summarize-release-status.mjs', import.meta.url));

const SOURCE_SHA = 'a'.repeat(40);
const OPERATION_ID = 'rel_candidate_20260809';
const RUN = {
  id: 42,
  url: 'https://github.com/happier-dev/happier/actions/runs/42',
  name: `RELEASE — Publish (${OPERATION_ID})`,
};

function input(overrides = {}) {
  return {
    operationId: OPERATION_ID,
    run: RUN,
    channel: 'stable',
    sourceSha: SOURCE_SHA,
    requestedSurfaces: [
      { id: 'npm', required: true, evidence: 'verified' },
      { id: 'deploy', required: true, evidence: 'verified' },
    ],
    surfaces: [
      {
        id: 'npm',
        result: 'success',
        identity: { verified: true, version: '1.2.3', digest: 'sha512:npm' },
      },
      {
        id: 'deploy',
        result: 'success',
        identity: { verified: true, revision: SOURCE_SHA },
      },
    ],
    ...overrides,
  };
}

test('all requested required surfaces with exact owner verification are complete', () => {
  assert.deepEqual(summarizeReleaseStatus(input()), {
    schemaVersion: 1,
    kind: 'happier.release-status.v1',
    operationId: OPERATION_ID,
    run: RUN,
    channel: 'stable',
    sourceSha: SOURCE_SHA,
    surfaces: [
      {
        id: 'npm',
        requested: true,
        required: true,
        evidence: 'verified',
        state: 'complete',
        result: 'success',
        identity: { digest: 'sha512:npm', verified: true, version: '1.2.3' },
      },
      {
        id: 'deploy',
        requested: true,
        required: true,
        evidence: 'verified',
        state: 'complete',
        result: 'success',
        identity: { revision: SOURCE_SHA, verified: true },
      },
    ],
    terminal: 'complete',
  });
});

test('surface output follows requested catalog order, not observation order', () => {
  const result = summarizeReleaseStatus(input({
    surfaces: [
      { id: 'deploy', result: 'success', identity: { verified: true } },
      { id: 'npm', result: 'success', identity: { verified: true } },
    ],
  }));
  assert.deepEqual(result.surfaces.map((surface) => surface.id), ['npm', 'deploy']);
});

test('summary JSON is deterministic for equivalent observation order and metadata key order', () => {
  const first = summarizeReleaseStatus(input({
    surfaces: [
      { id: 'deploy', result: 'success', identity: { verified: true, revision: SOURCE_SHA } },
      { id: 'npm', result: 'success', identity: { version: '1.2.3', verified: true } },
    ],
  }));
  const second = summarizeReleaseStatus(input({
    surfaces: [
      { id: 'npm', result: 'success', identity: { verified: true, version: '1.2.3' } },
      { id: 'deploy', result: 'success', identity: { revision: SOURCE_SHA, verified: true } },
    ],
  }));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('accepted owner outcomes remain published rather than being presented as shipped verification', () => {
  const result = summarizeReleaseStatus(input({
    requestedSurfaces: [{ id: 'mobile', required: true, evidence: 'accepted' }],
    surfaces: [{
      id: 'mobile',
      result: 'accepted',
      identity: { verified: false, buildId: 'eas-123' },
      recoveryHint: { workflow: 'publish-mobile', inputs: { retry: 'eas-123' } },
    }],
  }));
  assert.equal(result.surfaces[0].evidence, 'accepted');
  assert.equal(result.surfaces[0].state, 'published');
  assert.equal(result.terminal, 'published');
  assert.deepEqual(result.surfaces[0].recoveryHint, {
    inputs: { retry: 'eas-123' },
    workflow: 'publish-mobile',
  });
});

test('failed required surface is terminally failed', () => {
  const result = summarizeReleaseStatus(input({
    requestedSurfaces: [{ id: 'docker', required: true, evidence: 'verified' }],
    surfaces: [{
      id: 'docker',
      result: 'failed',
      recoveryHint: { workflow: 'publish-docker', inputs: { sha: SOURCE_SHA } },
    }],
  }));
  assert.deepEqual(result.surfaces[0], {
    id: 'docker',
    requested: true,
    required: true,
    evidence: 'verified',
    state: 'failed',
    result: 'failed',
    recoveryHint: { inputs: { sha: SOURCE_SHA }, workflow: 'publish-docker' },
  });
  assert.equal(result.terminal, 'failed');
});

test('a selected surface failure is terminal even when its release plan marks it optional', () => {
  const result = summarizeReleaseStatus(input({
    requestedSurfaces: [{ id: 'deploy_docs', required: false, evidence: 'accepted' }],
    surfaces: [{ id: 'deploy_docs', result: 'failed', recoveryHint: { job: 'deploy_docs' } }],
  }));
  assert.equal(result.surfaces[0].state, 'failed');
  assert.equal(result.terminal, 'failed');
});

test('missing or skipped optional surfaces are partial, while an explicitly unrequested surface is not_requested', () => {
  const result = summarizeReleaseStatus({
    run: { ...RUN, name: 'Nightly release' },
    channel: 'dev',
    sourceSha: SOURCE_SHA,
    requestedSurfaces: [
      { id: 'npm', required: true, evidence: 'verified' },
      { id: 'mobile', required: false, evidence: 'accepted' },
      { id: 'desktop', requested: false, required: true, evidence: 'verified' },
    ],
    surfaces: [
      { id: 'npm', result: 'success', identity: { verified: true } },
      { id: 'mobile', result: 'skipped' },
      { id: 'desktop', result: 'failed', identity: { verified: false } },
    ],
  });
  assert.deepEqual(result.surfaces.map((surface) => ({ id: surface.id, state: surface.state })), [
    { id: 'npm', state: 'complete' },
    { id: 'mobile', state: 'partial' },
    { id: 'desktop', state: 'not_requested' },
  ]);
  assert.equal(result.terminal, 'partial');
});

test('unknown or duplicate observed surfaces fail closed', () => {
  assert.throws(() => summarizeReleaseStatus(input({
    surfaces: [{ id: 'unknown', result: 'success', identity: { verified: true } }],
  })), /observed surface.*not declared/);
  assert.throws(() => summarizeReleaseStatus(input({
    surfaces: [
      { id: 'npm', result: 'success', identity: { verified: true } },
      { id: 'npm', result: 'success', identity: { verified: true } },
    ],
  })), /duplicate observed surface/);
});

test('input and observations use the explicit result enum', () => {
  assert.throws(() => summarizeReleaseStatus(input({
    surfaces: [{ id: 'npm', result: 'green', identity: { verified: true } }],
  })), /result/);
});

test('status requires a declared evidence level and does not treat acceptance as verification', () => {
  assert.throws(() => summarizeReleaseStatus(input({
    requestedSurfaces: [{ id: 'npm', required: true }],
  })), /evidence/);

  const result = summarizeReleaseStatus(input({
    requestedSurfaces: [{ id: 'deploy', required: true, evidence: 'verified' }],
    surfaces: [{ id: 'deploy', result: 'accepted', identity: { verified: false } }],
  }));
  assert.equal(result.surfaces[0].state, 'partial');
  assert.equal(result.terminal, 'partial');
});

test('status binds a conductor operation to the exact GitHub run identity', () => {
  assert.throws(() => summarizeReleaseStatus(input({
    operationId: 'release-42',
  })), /operationId/);
  assert.throws(() => summarizeReleaseStatus(input({
    run: { ...RUN, name: 'RELEASE — Publish' },
  })), /operationId/);
  assert.throws(() => summarizeReleaseStatus(input({
    run: { ...RUN, url: 'https://github.com/happier-dev/happier/actions/runs/43' },
  })), /run/);
});

test('CLI reads stdin and writes JSON-only stdout', () => {
  const child = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify(input()),
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), summarizeReleaseStatus(input()));
});
