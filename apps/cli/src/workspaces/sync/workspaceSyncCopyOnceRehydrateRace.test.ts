import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveWorkspaceSyncEndpointId } from './transport/workspaceSyncBrokerProtocol';
import { WorkspaceSyncController } from './workspaceSyncController';
import { createWorkspaceSyncMutagenAdapter } from './workspaceSyncMutagenAdapter';
import { createWorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import { computeWorkspaceSyncPolicyDigest } from './workspaceSyncTypes';

const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
const contentPolicy = { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) };
const relationship = {
  v: 1 as const,
  relationshipId: 'rel-1',
  controllerMachineId: 'm1',
  alphaWorkspaceRefId: 'rel-a',
  betaWorkspaceRefId: 'rel-b',
  mode: 'keep_synced' as const,
  contentPolicy,
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 1,
};

const copyOnceOperation = {
  v: 1 as const,
  operationId: 'copy-live-1',
  controllerMachineId: 'm1',
  alphaWorkspaceRefId: 'copy-a',
  betaWorkspaceRefId: 'copy-b',
  contentPolicy,
};

function copyOnceLabels(op: typeof copyOnceOperation) {
  return {
    'external.owner': 'happier-workspace-sync',
    'external.relationship_id': op.operationId,
    'external.endpoint_role': 'alpha|beta',
    'external.schema': 'workspace-sync-v1',
    'external.policy_digest': op.contentPolicy.policyDigest,
    'external.alpha_workspace_ref_id': op.alphaWorkspaceRefId,
    'external.beta_workspace_ref_id': op.betaWorkspaceRefId,
    'external.controller_machine_id': op.controllerMachineId,
    'external.operation_kind': 'copy_once',
    'external.policy_selection': op.contentPolicy.selection,
  };
}

function liveCopySession(paused: boolean, successfulCycles: number) {
  return {
    identifier: 'mutagen-copy-live-1',
    name: copyOnceOperation.operationId,
    labels: copyOnceLabels(copyOnceOperation),
    alpha: {
      protocol: 'external',
      host: deriveWorkspaceSyncEndpointId(copyOnceOperation.operationId, 'alpha'),
      path: '',
      state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
    },
    beta: {
      protocol: 'external',
      host: deriveWorkspaceSyncEndpointId(copyOnceOperation.operationId, 'beta'),
      path: '',
      state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
    },
    mode: 'one-way-safe',
    paused,
    status: 'watching',
    successfulCycles,
    conflictCount: 0,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('copyOnce concurrent with rehydrateFromSettings', () => {
  it('does not discover or terminate an in-flight copyOnce session during concurrent rehydrate', async () => {
    const flushStarted = deferred();
    const releaseFlush = deferred();
    let activeSession = false;
    let terminateCount = 0;

    const adapter = createWorkspaceSyncMutagenAdapter({
      resolveWorkspaceRef: async id => ({ machineId: 'm1', rootPath: `/${id}` }),
      send: async command => {
        if (command.t === 'list') {
          return { sessions: activeSession ? [liveCopySession(false, 0)] : [], nextCursor: null };
        }
        if (command.t === 'get_policy') {
          return { selection: 'all_files', patterns: ['.git'], nextCursor: null };
        }
        if (command.t === 'create') {
          activeSession = true;
          return liveCopySession(true, 0);
        }
        if (command.t === 'resume') {
          return liveCopySession(false, 0);
        }
        if (command.t === 'flush') {
          flushStarted.resolve();
          await releaseFlush.promise;
          return liveCopySession(false, 1);
        }
        if (command.t === 'terminate') {
          terminateCount += 1;
          if (!activeSession) {
            throw Object.assign(new Error('unable to locate requested session'), { code: 'engine_error' });
          }
          activeSession = false;
          return { ok: true };
        }
        throw new Error(`Unexpected command: ${command.t}`);
      },
    });

    const copyPromise = adapter.copyOnce(copyOnceOperation);
    await flushStarted.promise;

    const recoveries = await adapter.discoverCopyOnceRecoveries();
    expect(recoveries).toEqual([]);
    await adapter.rehydrate([]);
    expect(activeSession).toBe(true);
    expect(terminateCount).toBe(0);

    releaseFlush.resolve();
    const status = await copyPromise;
    expect(status.relationshipId).toBe(copyOnceOperation.operationId);
    expect(status.state).toBe('watching');
    expect(terminateCount).toBe(1);
    expect(activeSession).toBe(false);
  });

  it('controller rehydrateFromSettings starting before copyOnce does not terminate the live copyOnce session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-rws-copy-race-'));
    try {
      const targetPrepareStarted = deferred();
      const releaseTargetPrepare = deferred();
      const flushStarted = deferred();
      const releaseFlush = deferred();
      let activeCopySession = false;
      let terminateCount = 0;

      const refs = new Map([
        ['rel-a', { machineId: 'm1', rootPath: join(root, 'rel-a') }],
        ['rel-b', { machineId: 'm1', rootPath: join(root, 'rel-b') }],
        ['copy-a', { machineId: 'm1', rootPath: join(root, 'copy-a') }],
        ['copy-b', { machineId: 'm1', rootPath: join(root, 'copy-b') }],
      ]);
      for (const ref of refs.values()) await mkdir(ref.rootPath, { recursive: true });

      const adapter = createWorkspaceSyncMutagenAdapter({
        resolveWorkspaceRef: async id => refs.get(id) ?? null,
        send: async command => {
          if (command.t === 'list') {
            return { sessions: activeCopySession ? [liveCopySession(false, 0)] : [], nextCursor: null };
          }
          if (command.t === 'get_policy') {
            return { selection: 'all_files', patterns: ['.git'], nextCursor: null };
          }
          if (command.t === 'create') {
            if (command.session.name === copyOnceOperation.operationId) {
              activeCopySession = true;
              return liveCopySession(true, 0);
            }
            return {
              identifier: 'mutagen-rel-1',
              name: relationship.relationshipId,
              labels: {
                'external.owner': 'happier-workspace-sync',
                'external.relationship_id': relationship.relationshipId,
                'external.endpoint_role': 'alpha|beta',
                'external.schema': 'workspace-sync-v1',
                'external.policy_digest': relationship.contentPolicy.policyDigest,
                'external.alpha_workspace_ref_id': relationship.alphaWorkspaceRefId,
                'external.beta_workspace_ref_id': relationship.betaWorkspaceRefId,
                'external.controller_machine_id': relationship.controllerMachineId,
                'external.operation_kind': 'relationship',
                'external.policy_selection': relationship.contentPolicy.selection,
              },
              alpha: {
                protocol: 'external',
                host: deriveWorkspaceSyncEndpointId(relationship.relationshipId, 'alpha'),
                path: '',
                state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
              },
              beta: {
                protocol: 'external',
                host: deriveWorkspaceSyncEndpointId(relationship.relationshipId, 'beta'),
                path: '',
                state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
              },
              mode: 'one-way-safe',
              paused: false,
              status: 'watching',
              successfulCycles: 1,
              conflictCount: 0,
            };
          }
          if (command.t === 'resume') return liveCopySession(false, 0);
          if (command.t === 'flush') {
            flushStarted.resolve();
            await releaseFlush.promise;
            return liveCopySession(false, 1);
          }
          if (command.t === 'terminate') {
            terminateCount += 1;
            if (!activeCopySession) {
              throw Object.assign(new Error('unable to locate requested session'), { code: 'engine_error' });
            }
            activeCopySession = false;
            return { ok: true };
          }
          throw new Error(`Unexpected command: ${command.t}`);
        },
      });

      const controller = new WorkspaceSyncController({
        adapter,
        lifecycle: {
          start: vi.fn(async () => undefined),
          stop: vi.fn(async () => undefined),
          health: vi.fn(() => ({ running: true, pid: 1, endpointPath: '/tmp/broker.sock' })),
        },
        localMachineId: 'm1',
        resolveWorkspaceRef: async id => refs.get(id) ?? null,
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(root, 'locks') }),
        prepareRelationshipTarget: async () => {
          targetPrepareStarted.resolve();
          await releaseTargetPrepare.promise;
          return undefined;
        },
      });

      // rehydrateFromSettings starts FIRST (so copy-live-1 is not in copyOperations yet).
      const rehydratePromise = controller.rehydrateFromSettings([relationship]);
      await targetPrepareStarted.promise;

      // copyOnce starts while rehydrateFromSettings is awaiting target preparation.
      const copyPromise = controller.copyOnce(copyOnceOperation);
      await flushStarted.promise;

      // Now rehydrateFromSettings finishes target preparation and runs discover + adapter.rehydrate.
      releaseTargetPrepare.resolve();
      await rehydratePromise;

      // copyOnce finishes flush and runs its own terminal cleanup.
      releaseFlush.resolve();
      const status = await copyPromise;
      expect(status.relationshipId).toBe(copyOnceOperation.operationId);
      expect(status.state).toBe('watching');
      expect(terminateCount).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
