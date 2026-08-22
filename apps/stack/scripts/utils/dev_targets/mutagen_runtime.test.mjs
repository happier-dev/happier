import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseMutagenSyncList,
  resolveRecoverableReplicaArtifactConflictRoots,
  resolveDevTargetMutagenRuntime,
} from './mutagen_runtime.mjs';

test('dev target Mutagen runtime resolves the same stack-scoped daemon state as the supervisor', () => {
  const stackBaseDir = '/tmp/happier/stacks/repo-test';
  const runtime = resolveDevTargetMutagenRuntime({
    stackBaseDir,
    env: { PATH: '/test/bin', MUTAGEN_SSH_CONNECT_TIMEOUT: '17' },
    pathExists: (path) => path === join(stackBaseDir, 'mutagen', 'openssh'),
  });

  assert.equal(runtime.projectFile, join(stackBaseDir, 'mutagen', 'mutagen.yml'));
  assert.equal(
    runtime.syncServiceStateFile,
    join(stackBaseDir, 'mutagen', 'sync-service-state.v1.json'),
  );
  assert.equal(runtime.env.MUTAGEN_DATA_DIRECTORY, join(stackBaseDir, 'mutagen', 'data'));
  assert.equal(runtime.env.MUTAGEN_SSH_PATH, join(stackBaseDir, 'mutagen', 'openssh'));
  assert.equal(runtime.env.MUTAGEN_SSH_CONNECT_TIMEOUT, '17');
});

test('Mutagen list parsing distinguishes ready, synchronizing, paused, unhealthy, and missing sessions', () => {
  const ready = parseMutagenSyncList(JSON.stringify([{
    name: 'happier-linux', paused: false, status: 'watching', successfulCycles: 4,
  }]), 'happier-linux');
  assert.equal(ready.state, 'ready');

  const synchronizing = parseMutagenSyncList(JSON.stringify([{
    name: 'happier-linux', paused: false, status: 'watching', successfulCycles: 0,
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
    }]), 'happier-mac');
    assert.equal(result.state, 'synchronizing', status);
  }
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
