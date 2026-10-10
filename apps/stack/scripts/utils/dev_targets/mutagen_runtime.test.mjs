import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { resolveMutagenSessionName } from './mutagen_project.mjs';

test('routed repositories and QA consumers share one daemon while repository sessions stay distinct', () => {
  const env = { HAPPIER_STACK_STORAGE_DIR: '/state/stacks' };
  const producer = resolveDevTargetMutagenRuntime({ stackBaseDir: '/state/stacks/repo-dev', sourceDir: '/workspace/0.3', env });
  const sibling = resolveDevTargetMutagenRuntime({ stackBaseDir: '/state/stacks/repo-dev/commands-0.2', sourceDir: '/workspace/0.2', env });
  const consumer = resolveDevTargetMutagenRuntime({ stackBaseDir: '/state/stacks/agent-qa-test', sourceDir: '/workspace/0.3', env });
  assert.equal(producer.dataDir, sibling.dataDir);
  assert.equal(producer.dataDir, consumer.dataDir);
  assert.equal(producer.projectFile, consumer.projectFile);
  assert.notEqual(producer.projectFile, sibling.projectFile);
  assert.notEqual(resolveMutagenSessionName('worker', '/workspace/0.3'), resolveMutagenSessionName('worker', '/workspace/0.2'));
  assert.notEqual(resolveMutagenSessionName('worker', '/workspace/0.3'), resolveMutagenSessionName('worker', '/other/0.3'));
});

import {
  assertDevTargetMutagenRuntimeIsolation,
  parseMutagenSyncList,
  resolveRecoverableReplicaArtifactConflictRoots,
  resolveDevTargetMutagenRuntime,
} from './mutagen_runtime.mjs';

test('dev target Mutagen runtime declares its owner and rejects managed workspace-sync overlap', () => {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir: '/tmp/happier/stacks/repo-test' });
  assert.equal(runtime.owner, 'stack-dev-targets');
  assert.doesNotThrow(() => assertDevTargetMutagenRuntimeIsolation({
    runtime,
    managedDataDir: '/home/tester/.happier/daemon/workspace-sync/mutagen/data',
  }));
  assert.throws(() => assertDevTargetMutagenRuntimeIsolation({
    runtime,
    managedDataDir: runtime.dataDir,
  }), /isolat|overlap|managed/i);
});

test('dev target Mutagen runtime uses the routing producer rather than a caller-owned directory', () => {
  const stackBaseDir = '/tmp/happier/stacks/repo-test';
  const runtime = resolveDevTargetMutagenRuntime({
    stackBaseDir,
    env: { PATH: '/test/bin', HAPPIER_STACK_STORAGE_DIR: '/tmp/happier/stacks', MUTAGEN_SSH_CONNECT_TIMEOUT: '17' },
    pathExists: () => true,
  });

  assert.notEqual(runtime.ownerBaseDir, stackBaseDir);
  assert.equal(runtime.projectFile, join(runtime.mutagenDir, 'mutagen.yml'));
  assert.equal(
    runtime.syncServiceStateFile,
    join(runtime.mutagenDir, 'sync-service-state.v1.json'),
  );
  assert.equal(runtime.env.MUTAGEN_DATA_DIRECTORY, join(runtime.mutagenDir, 'data'));
  assert.equal(runtime.env.MUTAGEN_SSH_PATH, join(runtime.mutagenDir, 'openssh'));
  assert.equal(runtime.env.MUTAGEN_SSH_CONNECT_TIMEOUT, '17');
});

test('Mutagen list parsing distinguishes ready, synchronizing, paused, unhealthy, and missing sessions', () => {
  const connectedEndpoints = {
    alpha: { connected: true, scanned: true },
    beta: { connected: true, scanned: true },
  };
  const ready = parseMutagenSyncList(JSON.stringify([{
    name: 'happier-linux', paused: false, status: 'watching', successfulCycles: 4,
    ...connectedEndpoints,
  }]), 'happier-linux');
  assert.equal(ready.state, 'ready');

  const synchronizing = parseMutagenSyncList(JSON.stringify([{
    name: 'happier-linux', paused: false, status: 'watching', successfulCycles: 0,
    ...connectedEndpoints,
  }]), 'happier-linux');
  assert.equal(synchronizing.state, 'synchronizing');

  const paused = parseMutagenSyncList(JSON.stringify([{
    name: 'happier-linux', paused: true, status: 'disconnected',
  }]), 'happier-linux');
  assert.equal(paused.state, 'paused');

  const unhealthy = parseMutagenSyncList(JSON.stringify([{
    name: 'happier-linux', paused: false, status: 'connecting-beta', lastError: 'transport failed',
  }]), 'happier-linux');
  assert.equal(unhealthy.state, 'unhealthy');
  assert.equal(unhealthy.lastError, 'transport failed');

  assert.equal(parseMutagenSyncList('[]', 'happier-linux').state, 'missing');
});

test('Mutagen list parsing keeps the initial synchronization closed until one cycle completes', () => {
  for (const status of [
    'scanning',
    'waiting-for-rescan',
    'reconciling',
    'staging-alpha',
    'staging-beta',
    'transitioning',
    'saving',
  ]) {
    const result = parseMutagenSyncList(JSON.stringify([{
      name: 'happier-mac',
      paused: false,
      status,
      alpha: { connected: true, scanned: false },
      beta: { connected: true, scanned: false },
    }]), 'happier-mac');
    assert.equal(result.state, 'synchronizing', status);
  }
});

test('connected idle no-watch sessions need a dispatch flush before their first cycle', () => {
  const session = {
    name: 'happier-linux', paused: false, status: 'watching',
    alpha: { connected: true, scanned: false, watch: { mode: 'no-watch' } },
    beta: { connected: true, scanned: false, watch: { mode: 'no-watch' } },
  };
  const inspect = (value) => parseMutagenSyncList(JSON.stringify([value]), session.name);
  // Mutagen 0.18.1 omits the zero successfulCycles field in its JSON model.
  assert.equal(inspect(session).state, 'needs-flush');
  assert.equal(inspect({ ...session, successfulCycles: 0 }).state, 'needs-flush');
  assert.equal(inspect({ ...session, status: 'scanning' }).state, 'synchronizing');
  assert.equal(inspect({ ...session, alpha: { ...session.alpha, watch: { mode: 'portable' } } }).state, 'synchronizing');
  for (const unsafe of [
    { ...session, paused: true },
    { ...session, lastError: 'transport failed' },
    { ...session, conflicts: [{ root: 'source' }] },
    { ...session, alpha: { ...session.alpha, connected: false } },
    { ...session, beta: { ...session.beta, scanProblems: [{ path: 'source', error: 'unreadable' }] } },
    { ...session, beta: { ...session.beta, transitionProblems: [{ path: 'source' }] } },
    { ...session, successfulCycles: '0' },
    { ...session, successfulCycles: null },
  ]) assert.notEqual(inspect(unsafe).state, 'needs-flush');
});

test('Mutagen list parsing allows commands against moving bytes after a completed cycle', () => {
  for (const status of [
    'watching',
    'scanning',
    'waiting-for-rescan',
    'reconciling',
    'staging-alpha',
    'staging-beta',
    'transitioning',
    'saving',
  ]) {
    const result = parseMutagenSyncList(JSON.stringify([{
      name: 'happier-mac',
      paused: false,
      status,
      successfulCycles: 7,
      alpha: { connected: true, scanned: true },
      beta: { connected: true, scanned: true },
    }]), 'happier-mac');
    assert.equal(result.state, 'ready', status);
  }
});

test('Mutagen list parsing keeps endpoint connection phases closed', () => {
  for (const status of ['connecting-alpha', 'connecting-beta']) {
    const result = parseMutagenSyncList(JSON.stringify([{
      name: 'happier-mac',
      paused: false,
      status,
      successfulCycles: 7,
    }]), 'happier-mac');
    assert.equal(result.state, 'synchronizing', status);
  }
});

test('Mutagen list parsing reports halted, disconnected, and unknown sessions as unhealthy', () => {
  for (const status of [
    'disconnected',
    'halted-on-root-emptied',
    'halted-on-root-deletion',
    'halted-on-root-type-change',
    'unknown',
  ]) {
    const result = parseMutagenSyncList(JSON.stringify([{
      name: 'happier-mac',
      paused: false,
      status,
      successfulCycles: 7,
    }]), 'happier-mac');
    assert.equal(result.state, 'unhealthy', status);
  }
});

test('Mutagen list parsing rejects a connected session with unresolved conflicts', () => {
  const result = parseMutagenSyncList(JSON.stringify([{
    name: 'happier-mac',
    paused: false,
    status: 'watching',
    successfulCycles: 12,
    conflicts: [{
      root: 'packages/channels-contract',
      alphaChanges: [{ path: 'packages/channels-contract' }],
      betaChanges: [
        { path: 'packages/channels-contract/dist' },
        { path: 'packages/channels-contract/node_modules' },
      ],
    }],
  }]), 'happier-mac');

  assert.equal(result.state, 'unhealthy');
  assert.equal(result.lastError, '1 unresolved synchronization conflict: packages/channels-contract');
});

test('Mutagen list parsing rejects nonterminal scan and transition problems including excluded counts', () => {
  const base = (overrides = {}) => JSON.stringify([{
    name: 'happier-mac',
    paused: false,
    status: 'watching',
    successfulCycles: 7,
    alpha: { connected: true, scanned: true, ...(overrides.alpha ?? {}) },
    beta: { connected: true, scanned: true, ...(overrides.beta ?? {}) },
    ...(overrides.session ?? {}),
  }]);

  const clean = parseMutagenSyncList(base(), 'happier-mac');
  assert.equal(clean.state, 'ready');

  for (const problem of [
    { alpha: { scanProblems: [{ path: 'a.txt', error: 'permission denied' }] } },
    { beta: { scanProblems: [{ path: 'b.txt', error: 'unreadable' }] } },
    { alpha: { transitionProblems: [{ path: 'c.txt', error: 'apply failed' }] } },
    { beta: { transitionProblems: [{ path: 'd.txt', error: 'apply failed' }] } },
    { alpha: { scanProblems: [{ path: 'a.txt' }], excludedScanProblems: 3 } },
    { beta: { transitionProblems: [{ path: 'd.txt' }], excludedTransitionProblems: 2 } },
    { session: { excludedConflicts: 1, conflicts: [{ root: 'x' }] } },
  ]) {
    const result = parseMutagenSyncList(base(problem), 'happier-mac');
    assert.equal(result.state, 'unhealthy', JSON.stringify(problem));
  }

  const excludedAlone = parseMutagenSyncList(base({
    alpha: { excludedScanProblems: 2, scanProblems: [{ path: 'a.txt' }] },
  }), 'happier-mac');
  assert.equal(excludedAlone.state, 'unhealthy');
});

test('Mutagen list parsing requires connected and scanned endpoints for readiness', () => {
  const build = (alpha, beta, extra = {}) => JSON.stringify([{
    name: 'happier-mac',
    paused: false,
    status: 'watching',
    successfulCycles: 7,
    alpha,
    beta,
    ...extra,
  }]);
  const connectedScanned = { connected: true, scanned: true };

  assert.equal(parseMutagenSyncList(build(connectedScanned, connectedScanned), 'happier-mac').state, 'ready');

  const disconnected = parseMutagenSyncList(
    build({ connected: false }, connectedScanned), 'happier-mac',
  );
  assert.equal(disconnected.state, 'unhealthy');

  const missingEndpoint = parseMutagenSyncList(JSON.stringify([{
    name: 'happier-mac', paused: false, status: 'watching', successfulCycles: 7,
  }]), 'happier-mac');
  assert.equal(missingEndpoint.state, 'unhealthy');

  const unscanned = parseMutagenSyncList(
    build({ connected: true, scanned: false }, connectedScanned), 'happier-mac',
  );
  assert.equal(unscanned.state, 'synchronizing');
});

test('Mutagen list parsing fails closed on malformed admission facts', () => {
  const base = (overrides = {}) => JSON.stringify([{
    name: 'happier-mac',
    paused: false,
    status: 'watching',
    successfulCycles: 7,
    conflicts: [],
    alpha: { connected: true, scanned: true },
    beta: { connected: true, scanned: true },
    ...overrides,
  }]);

  for (const malformed of [
    { paused: 'false' },
    { conflicts: {} },
    { excludedConflicts: -1 },
    { alpha: { connected: true, scanned: true, scanProblems: {} } },
    { beta: { connected: true, scanned: true, excludedTransitionProblems: 'none' } },
  ]) {
    const result = parseMutagenSyncList(base(malformed), 'happier-mac');
    assert.equal(result.state, 'unhealthy', JSON.stringify(malformed));
    assert.match(result.lastError ?? '', /malformed/i, JSON.stringify(malformed));
  }
});

test('Mutagen list parsing keeps benign post-flush scanning ready when endpoints are clean', () => {
  for (const status of ['scanning', 'reconciling', 'transitioning']) {
    const result = parseMutagenSyncList(JSON.stringify([{
      name: 'happier-mac',
      paused: false,
      status,
      successfulCycles: 7,
      alpha: { connected: true, scanned: true },
      beta: { connected: true, scanned: true },
    }]), 'happier-mac');
    assert.equal(result.state, 'ready', status);
  }
});

test('Mutagen conflict recovery recognizes deleted alpha roots blocked only by disposable replica artifacts', () => {
  const recoverable = {
    mode: 'one-way-replica',
    conflicts: [{
      root: 'packages/plugins/retired-plugin',
      alphaChanges: [{
        path: 'packages/plugins/retired-plugin',
        old: { kind: 'directory' },
        new: null,
      }],
      betaChanges: [
        {
          path: 'packages/plugins/retired-plugin/node_modules',
          old: null,
          new: { kind: 'untracked' },
        },
        {
          path: 'packages/plugins/retired-plugin/dist/runtime.js',
          old: null,
          new: { kind: 'untracked' },
        },
        {
          path: 'packages/plugins/retired-plugin/.happier',
          old: null,
          new: { kind: 'untracked' },
        },
        {
          path: 'packages/plugins/retired-plugin/.tsbuildinfo',
          old: null,
          new: { kind: 'untracked' },
        },
      ],
    }],
  };
  assert.deepEqual(
    resolveRecoverableReplicaArtifactConflictRoots(recoverable),
    ['packages/plugins/retired-plugin'],
  );

  assert.deepEqual(resolveRecoverableReplicaArtifactConflictRoots({
    ...recoverable,
    conflicts: [{
      ...recoverable.conflicts[0],
      alphaChanges: [{
        path: 'packages/plugins/retired-plugin',
        old: null,
        new: null,
      }],
    }],
  }), ['packages/plugins/retired-plugin']);

  assert.deepEqual(resolveRecoverableReplicaArtifactConflictRoots({
    ...recoverable,
    conflicts: [
      ...recoverable.conflicts,
      {
        root: 'packages/plugins/unsafe-plugin',
        alphaChanges: [{
          path: 'packages/plugins/unsafe-plugin',
          old: { kind: 'directory' },
          new: null,
        }],
        betaChanges: [{
          path: 'packages/plugins/unsafe-plugin/package.json',
          old: null,
          new: { kind: 'untracked' },
        }],
      },
    ],
  }), ['packages/plugins/retired-plugin']);

  for (const session of [
    { ...recoverable, mode: 'two-way-safe' },
    {
      ...recoverable,
      conflicts: [{
        ...recoverable.conflicts[0],
        alphaChanges: [{ path: 'packages/plugins/retired-plugin/src/index.ts' }],
      }],
    },
    {
      ...recoverable,
      conflicts: [{
        ...recoverable.conflicts[0],
        betaChanges: [{
          path: 'packages/plugins/retired-plugin/package.json',
          old: null,
          new: { kind: 'untracked' },
        }],
      }],
    },
    {
      ...recoverable,
      conflicts: [{ ...recoverable.conflicts[0], root: '../outside' }],
    },
  ]) {
    assert.deepEqual(resolveRecoverableReplicaArtifactConflictRoots(session), []);
  }
});

test('Mutagen conflict recovery recognizes a disposable artifact directory created only on the replica', () => {
  const root = 'packages/plugins/antigravity/.turbo';
  const recoverable = {
    mode: 'one-way-replica',
    conflicts: [{
      root,
      alphaChanges: [{ path: root, old: null, new: null }],
      betaChanges: [{
        path: `${root}/turbo-project:finite.log`,
        old: null,
        new: { kind: 'untracked' },
      }],
    }],
  };

  assert.deepEqual(resolveRecoverableReplicaArtifactConflictRoots(recoverable), [root]);

  for (const session of [
    {
      ...recoverable,
      conflicts: [{
        ...recoverable.conflicts[0],
        betaChanges: [{
          path: `${root}/turbo-project:finite.log`,
          old: { kind: 'file' },
          new: { kind: 'untracked' },
        }],
      }],
    },
    {
      ...recoverable,
      conflicts: [{
        ...recoverable.conflicts[0],
        betaChanges: [{
          path: `${root}/turbo-project:finite.log`,
          old: null,
          new: { kind: 'file' },
        }],
      }],
    },
    {
      ...recoverable,
      conflicts: [{
        ...recoverable.conflicts[0],
        root: 'packages/plugins/antigravity/src',
        alphaChanges: [{ path: 'packages/plugins/antigravity/src', old: null, new: null }],
        betaChanges: [{
          path: 'packages/plugins/antigravity/src/generated.ts',
          old: null,
          new: { kind: 'untracked' },
        }],
      }],
    },
  ]) {
    assert.deepEqual(resolveRecoverableReplicaArtifactConflictRoots(session), []);
  }
});

test('Mutagen conflict recovery recognizes plugin SDK example build output created only on the replica', () => {
  const root = 'packages/plugin-sdk/.example-builds';
  const recoverable = {
    mode: 'one-way-replica',
    conflicts: [{
      root,
      alphaChanges: [{ path: root, old: null, new: null }],
      betaChanges: [{
        path: `${root}/public-authoring/dist`,
        old: null,
        new: { kind: 'untracked' },
      }],
    }],
  };

  assert.deepEqual(resolveRecoverableReplicaArtifactConflictRoots(recoverable), [root]);
});
