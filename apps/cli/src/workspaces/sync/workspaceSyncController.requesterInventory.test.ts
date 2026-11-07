import { expect, it } from 'vitest';
import { WorkspaceSyncController } from './workspaceSyncController';
import { createWorkspaceSyncMutagenAdapter } from './workspaceSyncMutagenAdapter';
import { createWorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from './workspaceSyncTypes';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('discovers own remote relationships from the admitted requester projection without exposing the installed Account inventory', async () => {
  const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const relationship: WorkspaceSyncRelationshipV1 = { v: 1, relationshipId: 'requester-remote', controllerMachineId: 'remote-machine',
    alphaWorkspaceRefId: 'requester-source', betaWorkspaceRefId: 'requester-target', mode: 'keep_both_in_sync',
    contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
  const installed = { ...relationship, relationshipId: 'custodian-remote' };
  const directory = await mkdtemp(join(tmpdir(), 'requester-sync-inventory-'));
  const controller = new WorkspaceSyncController({ localMachineId: 'source-machine', localServerId: 'home',
    lifecycle: { start: async () => {}, stop: async () => {} },
    rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: directory }),
    resolveWorkspaceRef: () => null,
    resolveAllRelationshipDefinitions: () => [installed],
    adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef: () => null,
      // The native broker transport is the system boundary. No native work is
      // needed to inventory this remote controller's saved relationship.
      send: async command => { if (command.t === 'list') return { sessions: [], nextCursor: null }; throw new Error('Unexpected native effect'); } }),
  });
  try {
    const listed = await controller.listRelationships({ workspaceRefId: 'requester-source' }, undefined,
      new Set([relationship.relationshipId]), [relationship]);
    expect(listed.remoteRelationships).toEqual([{ definition: relationship, controllerMachineId: 'remote-machine' }]);
    expect(listed.membership).toEqual({ workspaceRefId: 'requester-source', found: true });
    expect(listed.discoveryAvailable).toBe(true);
    const missing = await controller.listRelationships({ workspaceRefId: 'requester-source' }, undefined, new Set(), null);
    expect(missing.remoteRelationships).toEqual([]);
    expect(missing.discoveryAvailable).toBe(false);
  } finally { try { await controller.shutdown(); } finally { await rm(directory, { recursive: true, force: true }); } }
});
