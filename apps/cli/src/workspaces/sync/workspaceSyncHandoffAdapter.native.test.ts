import { describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProjectAccountSnapshotV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { isManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createWorkspaceSyncHandoffAdapter, materializeWorkspaceSyncForOpen, type PrepareWorkspaceSyncHandoffInput } from './workspaceSyncHandoffAdapter';
import { createWorkspaceSyncRelationshipOwner } from './workspaceSyncRelationshipOwner';
import { WorkspaceSyncController } from './workspaceSyncController';
import { createWorkspaceSyncMutagenAdapter } from './workspaceSyncMutagenAdapter';
import { createWorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import { computeWorkspaceSyncPolicyDigest } from './workspaceSyncTypes';
import { deriveWorkspaceSyncEndpointId, type MutagenControlCommandV1, type MutagenSessionSummaryV1 } from './transport/workspaceSyncBrokerProtocol';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';

describe('native Workspace Sync handoff', () => {
  it.each(['managedId', 'machineId', 'installationId'] as const)('preserves ambiguity when a retained managed %s changes', async field => {
    const directory = await mkdtemp(join(tmpdir(), 'workspace-sync-native-identity-'));
    const controller = new WorkspaceSyncController({
      adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef: () => null, send: async () => {
        throw new Error('Resolving private refs must not start the native engine');
      } }), lifecycle: { start: async () => undefined, stop: async () => undefined },
      localMachineId: 'controller', localServerId: 'home', resolveWorkspaceRef: () => null,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(directory, 'locks') }),
    });
    const adapter = createWorkspaceSyncHandoffAdapter({ sync: controller });
    const workspace = { v: 2 as const, kind: 'managed' as const, id: 'native', serverId: 'home', managedId: 'guest',
      controller: { machineId: 'controller', installationId: 'installation' }, rootPath: '/same/root', createdAtMs: 1 };
    const retain = (operationId: string, ref: typeof workspace) => {
      const snapshot: ActiveProjectAccountRowsSnapshot = { source: 'network', workspaceRefs: [ref], relationships: [],
        organizations: [], rows: [], graphRevision: 'absent', loadedAtMs: 1, scopeKey: 'reader' };
      adapter.retainPrivateExecution!({ input: { operationId, action: { kind: 'none' }, sourceMachineId: 'controller',
        sourceRootPath: ref.rootPath, targetMachineId: 'controller', targetRootPath: ref.rootPath }, execution: {
        credentials: { token: 'reader', encryption: null }, accountRowsCustody: { serverId: 'home', accountId: 'reader',
          serverHttpBaseUrl: 'https://home.invalid', isCurrent: async () => true }, getSnapshot: () => snapshot,
        assertTransferCurrent: async () => undefined, release: async () => undefined,
      } });
    };
    try {
      retain('first', workspace);
      retain('identical', { ...workspace });
      expect(adapter.resolvePrivateWorkspaceRef!('native', 'home')).toEqual({ kind: 'resolved', workspace });
      retain('changed', field === 'managedId' ? { ...workspace, managedId: 'other' }
        : { ...workspace, controller: { ...workspace.controller, [field]: 'other' } });
      expect(adapter.resolvePrivateWorkspaceRef!('native', 'home')).toEqual({ kind: 'unavailable' });
    } finally {
      await adapter.releaseAllPrivateExecutions!();
      await controller.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(['commit', 'abort', 'failed'] as const)('moves captured return bytes into the finite source lifetime before retiring the capture (%s)', async settlement => {
    const directory = await mkdtemp(join(tmpdir(), 'workspace-sync-return-capture-'));
    const stageRoot = join(directory, 'stage');
    await mkdir(stageRoot);
    const controller = new WorkspaceSyncController({
      adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef: () => null, send: async () => {
        throw new Error('Capturing source custody must not start the native engine');
      } }), lifecycle: { start: async () => undefined, stop: async () => undefined },
      localMachineId: 'controller', localServerId: 'home', resolveWorkspaceRef: () => null,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(directory, 'locks') }),
    });
    const adapter = createWorkspaceSyncHandoffAdapter({ sync: controller, bootstrap: async () => {
      throw new Error('The remote target is unavailable');
    } });
    const captureInput: PrepareWorkspaceSyncHandoffInput = { operationId: 'capture', accountServerId: 'home',
      action: { kind: 'none' }, sourceMachineId: 'controller', sourceWorkspaceRefId: 'captured-source',
      sourceRootPath: stageRoot, targetMachineId: 'controller', targetRootPath: stageRoot };
    adapter.retainPrivateExecution!({ input: captureInput, execution: {
      credentials: { token: 'requester', encryption: null },
      ephemeralSource: { sessionId: 'session', workspace: { id: 'captured-source', serverId: 'home',
        machineId: 'controller', rootPath: stageRoot, createdAtMs: 1 } },
      accountRowsCustody: { serverId: 'home', accountId: 'reader', serverHttpBaseUrl: 'https://home.invalid',
        isCurrent: async () => true }, assertTransferCurrent: async () => undefined,
      release: async () => { await rm(stageRoot, { recursive: true, force: true }); },
    } });
    try {
      const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
      const copyInput: PrepareWorkspaceSyncHandoffInput = { ...captureInput, operationId: 'finite-copy',
        targetWorkspaceRefId: settlement === 'failed' ? 'target' : captureInput.sourceWorkspaceRefId,
        ...(settlement === 'failed' ? { targetMachineId: 'original', targetRootPath: '/private/return-stage' } : {}),
        action: { kind: 'copy_once', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } } };
      adapter.transferPrivateExecution!('capture', copyInput);
      await adapter.releasePrivateExecution!('capture');
      await expect(access(stageRoot)).resolves.toBeUndefined();
      expect(adapter.resolvePrivateExecution!({ operationId: 'capture' })).toBeNull();
      expect(adapter.resolvePrivateExecution!({ operationId: 'finite-copy' })?.execution.accountRowsCustody.accountId).toBe('reader');
      if (settlement === 'commit') await materializeWorkspaceSyncForOpen(adapter, copyInput);
      else if (settlement === 'failed') await expect(materializeWorkspaceSyncForOpen(adapter, copyInput)).rejects.toThrow('The remote target is unavailable');
      else await adapter.abort({ operationId: 'finite-copy' });
      await expect(access(stageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await adapter.releaseAllPrivateExecutions!();
      await controller.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('materializes the original Machine source into a native target without traversing guest roots', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-native-open-'));
    const hostRootPath = join(fixture, 'original');
    await mkdir(hostRootPath);
    const managed = { managedId: 'guest', controller: { machineId: 'controller', installationId: 'installed-controller' } };
    const sourceRootPath = hostRootPath;
    let snapshot = parseProjectAccountSnapshotV1({ workspaceRefs: [{ id: 'original', serverId: 'home',
      machineId: 'source',
      rootPath: sourceRootPath, createdAtMs: 1, projectKey: 'accepted-project' }] });
    const commands: MutagenControlCommandV1[] = [];
    const hostRoots: string[] = [];
    const released: string[] = [];
    const resolveWorkspaceRef = (id: string) => snapshot.workspaceRefs.find(ref => ref.id === id) ?? null;
    const endpointState = { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 };
    let session: MutagenSessionSummaryV1 = { identifier: 'native-copy', name: 'native-copy', labels: {},
      alpha: { protocol: 'external', host: deriveWorkspaceSyncEndpointId('native-copy', 'alpha'), path: '', state: endpointState },
      beta: { protocol: 'external', host: deriveWorkspaceSyncEndpointId('native-copy', 'beta'), path: '', state: endpointState },
      mode: 'one-way-safe', paused: false, status: 'watching', successfulCycles: 1, conflictCount: 0 };
    const sourceSync = new WorkspaceSyncController({
      adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef, send: async command => {
        // The native engine process is the boundary; adapters and graph owners stay real.
        commands.push(command);
        if (command.t === 'list') return { sessions: [], nextCursor: null };
        if (command.t === 'terminate') return null;
        if (command.t === 'create') session = { ...session, labels: command.session.labels };
        return session;
      } }),
      lifecycle: { start: async () => undefined, stop: async () => undefined },
      localMachineId: 'source', localServerId: 'home', resolveWorkspaceRef,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      resolvePrivateWorkspaceRoot: async root => { hostRoots.push(root); return root; },
    });
    const unusedRelationshipEffect = async (): Promise<never> => { throw new Error('copy must not create a relationship'); };
    const relationshipOwner = createWorkspaceSyncRelationshipOwner({ localMachineId: 'source',
      readProjectSnapshot: async () => snapshot,
      mutateProjectSnapshot: async mutate => {
        snapshot = parseProjectAccountSnapshotV1(await mutate(snapshot));
        return { status: 'applied', version: 1, snapshot };
      },
      waitForProjectReconciliation: async () => undefined,
      ensureRelationship: unusedRelationshipEffect, flushRelationship: unusedRelationshipEffect,
      terminateRelationshipRuntime: unusedRelationshipEffect, commitRelationshipTarget: unusedRelationshipEffect,
      createId: () => 'native-target', nowMs: () => 2,
    });
    const source = createWorkspaceSyncHandoffAdapter({ sync: sourceSync, relationshipOwner, localMachineId: 'source',
      bootstrap: async input => {
        // Signed TARGET transport is the boundary. Its retained receiver resolves the native ref.
        expect(input.targetManaged).toEqual(managed);
        const targetWorkspace = resolveWorkspaceRef(input.targetWorkspaceRefId!);
        if (!targetWorkspace || !isManagedWorkspaceRefV2(targetWorkspace)) throw new Error('receiver locator was lost');
        return { targetWorkspace, release: async reason => { released.push(reason); } };
      },
    });
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const input: PrepareWorkspaceSyncHandoffInput = { operationId: 'native-copy', accountServerId: 'home',
      action: { kind: 'copy_once', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } },
      sourceMachineId: 'source', sourceWorkspaceRefId: 'original', sourceRootPath,
      targetMachineId: 'controller', targetRootPath: '/guest-only/repo', targetManaged: managed,
    };
    try {
      await source.prepare(input);
      await expect(source.prepare({ ...input, targetManaged: { ...managed, managedId: 'another-guest' } }))
        .rejects.toMatchObject({ code: 'workspace_sync_operation_conflict' });
      await materializeWorkspaceSyncForOpen(source, input);
      expect(snapshot.workspaceRefs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'native-target',
        kind: 'managed', managedId: 'guest', rootPath: '/guest-only/repo',
        projectKey: 'accepted-project' })]));
      expect(snapshot.workspaceRefs).toHaveLength(2);
      expect(commands.find(command => command.t === 'create')).toBeDefined();
      expect(released).toEqual(['commit']);
      expect(hostRoots).not.toContain('/guest-only/repo');
    } finally {
      await source.abort({ operationId: input.operationId });
      await sourceSync.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
