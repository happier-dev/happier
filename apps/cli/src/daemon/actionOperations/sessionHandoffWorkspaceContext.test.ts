import { describe, expect, it } from 'vitest';

import { computeWorkspaceSyncPolicyDigest } from '@/workspaces/sync/workspaceSyncTypes';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { deriveManagedDevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import type { WorkspaceSyncChildMachineFacts } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { resolveSessionHandoffWorkspaceContext } from './sessionHandoffWorkspaceContext';

const policyInput = {
  v: 1 as const,
  selection: 'all_files' as const,
  extraIgnorePatterns: [],
  extraIncludePatterns: [],
};
const contentPolicy = {
  ...policyInput,
  policyDigest: computeWorkspaceSyncPolicyDigest(policyInput),
};
const refs = [
  { id: 'source-ref', serverId: 'server-1', machineId: 'source-machine', rootPath: '/source', createdAtMs: 1 },
  { id: 'target-ref', serverId: 'server-1', machineId: 'target-machine', rootPath: '/target', createdAtMs: 1 },
  { id: 'hub-ref', serverId: 'server-1', machineId: 'hub-machine', rootPath: '/hub', createdAtMs: 1 },
];
const relationship = {
  v: 1 as const,
  relationshipId: 'relationship-1',
  controllerMachineId: 'source-machine',
  alphaWorkspaceRefId: 'source-ref',
  betaWorkspaceRefId: 'target-ref',
  mode: 'keep_synced' as const,
  contentPolicy,
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 1,
};

function enrolledBindChild() {
    const child = { id: 'child-ref', serverId: 'server-1', machineId: 'child-machine', rootPath: '/work/child', createdAtMs: 1 };
    const managedMachine = ManagedMachineV1Schema.parse({
      id: 'managed-child', homeId: 'server-1', custodianAccountId: 'owner',
      controller: { machineId: 'source-machine', installationId: 'parent-installation' },
      launch: { provider: { pluginId: 'acme.devcontainer', localId: 'child' }, schemaVersion: 1, name: 'Child', choices: {} },
      allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, enrolledMachineId: child.machineId,
      resource: { contributionRef: { pluginId: 'acme.devcontainer', localId: 'child' }, schemaVersion: 1, value: {},
        devcontainerObservation: { nativeResourceId: 'container-1', user: 'custom-user', workspaceFolder: child.rootPath,
          storage: { kind: 'bind', hostPath: '/source', childPath: child.rootPath } } },
    });
    const projection = deriveManagedDevcontainerChildProjectionV1({ managedMachineId: managedMachine.id,
      controllerMachineId: managedMachine.controller.machineId, enrolledMachineId: child.machineId, resource: managedMachine.resource });
    if (!projection) throw new Error('Expected ordinary enrolled child projection');
    const facts = { serverId: 'server-1', machineId: child.machineId, installationId: 'child-installation', projection, managedMachine,
      controller: { ...managedMachine.controller, available: true } } satisfies WorkspaceSyncChildMachineFacts;
    return { child, managedMachine, facts };
}

describe('resolveSessionHandoffWorkspaceContext', () => {
  it('routes a bind-backed child through the physical relationship while retaining the child execution roots', () => {
    const { child, managedMachine, facts } = enrolledBindChild();
    const input = { serverId: 'server-1', action: { kind: 'relationship' as const, relationshipId: relationship.relationshipId, flushBeforeCommit: true },
      workspaceRefs: [...refs, child], relationships: [relationship], childMachines: [facts],
      sourceMachineId: child.machineId, sourceRootPath: child.rootPath, targetMachineId: 'target-machine', targetRootPath: '/target' };
    expect(resolveSessionHandoffWorkspaceContext(input)).toMatchObject({ sourceWorkspaceRefId: child.id,
      sourceRootPath: child.rootPath, targetWorkspaceRefId: 'target-ref', targetRootPath: '/target',
      controllerMachineId: 'source-machine', relationshipIds: ['relationship-1'] });
    expect(resolveSessionHandoffWorkspaceContext({ ...input,
      action: { kind: 'linked_workspace' }, sourceMachineId: 'target-machine', sourceRootPath: '/target',
      targetMachineId: child.machineId, targetRootPath: child.rootPath,
      relationships: [{ ...relationship, mode: 'keep_both_in_sync' }],
    })).toMatchObject({ sourceWorkspaceRefId: 'target-ref', targetWorkspaceRefId: child.id,
      sourceRootPath: '/target', targetRootPath: child.rootPath, controllerMachineId: 'source-machine' });
    expect(() => resolveSessionHandoffWorkspaceContext({ ...input, childMachines: [{ ...facts,
      managedMachine: { ...managedMachine, enrolledMachineId: 'replacement-child' } }] }))
      .toThrowError(expect.objectContaining({ code: 'workspace_sync_child_unavailable' }));
  });

  it('admits a parent-to-own-bind-child linked no-op without fabricating a relationship or content policy', () => {
    const { child, facts } = enrolledBindChild();
    const input = { serverId: 'server-1', action: { kind: 'linked_workspace' as const },
      workspaceRefs: [...refs, child], relationships: [], childMachines: [facts],
      sourceMachineId: 'source-machine', sourceRootPath: '/source', targetMachineId: child.machineId, targetRootPath: child.rootPath };
    expect(resolveSessionHandoffWorkspaceContext(input)).toEqual({ sourceWorkspaceRefId: 'source-ref', targetWorkspaceRefId: child.id,
      sourceRootPath: '/source', targetRootPath: child.rootPath, controllerMachineId: 'source-machine',
      relationshipIds: [], contentSelections: [] });
    expect(() => resolveSessionHandoffWorkspaceContext({ ...input,
      action: { kind: 'relationship', relationshipId: 'invented-edge', flushBeforeCommit: true } }))
      .toThrowError(expect.objectContaining({ code: 'relationship_target_mismatch' }));
  });

  it('resolves the selected Home when another Home has the same endpoint ids and machine roots', () => {
    expect(resolveSessionHandoffWorkspaceContext({
      serverId: 'server-1',
      action: { kind: 'relationship', relationshipId: 'relationship-1', flushBeforeCommit: true },
      workspaceRefs: [...refs.map((ref) => ({ ...ref, serverId: 'server-2' })), ...refs],
      relationships: [relationship],
      sourceMachineId: 'source-machine',
      sourceRootPath: '/source',
      targetMachineId: 'target-machine',
      targetRootPath: '/target',
    })).toMatchObject({ sourceWorkspaceRefId: 'source-ref', targetWorkspaceRefId: 'target-ref' });
  });

  it('derives relationship endpoints from its canonical settings record and rejects a mismatched picker target', () => {
    expect(resolveSessionHandoffWorkspaceContext({
      serverId: 'server-1',
      action: { kind: 'relationship', relationshipId: 'relationship-1', flushBeforeCommit: true },
      workspaceRefs: refs,
      relationships: [relationship],
      sourceMachineId: 'source-machine',
      sourceRootPath: '/source',
      targetMachineId: 'target-machine',
    })).toEqual({
      sourceWorkspaceRefId: 'source-ref',
      targetWorkspaceRefId: 'target-ref',
      sourceRootPath: '/source',
      targetRootPath: '/target',
      controllerMachineId: 'source-machine',
      contentSelection: 'all_files',
      relationshipIds: ['relationship-1'],
      contentSelections: ['all_files'],
    });

    expect(() => resolveSessionHandoffWorkspaceContext({
      serverId: 'server-1',
      action: { kind: 'relationship', relationshipId: 'relationship-1', flushBeforeCommit: true },
      workspaceRefs: refs,
      relationships: [relationship],
      sourceMachineId: 'source-machine',
      sourceRootPath: '/source',
      targetMachineId: 'target-machine',
      targetRootPath: '/somewhere-else',
    })).toThrowError(expect.objectContaining({ code: 'relationship_target_mismatch' }));
  });

  it('fails closed when the source machine/root scope is ambiguous', () => {
    expect(() => resolveSessionHandoffWorkspaceContext({
      serverId: 'server-1',
      action: { kind: 'relationship', relationshipId: 'relationship-1', flushBeforeCommit: true },
      workspaceRefs: [...refs, { ...refs[0]!, id: 'duplicate-source' }],
      relationships: [relationship],
      sourceMachineId: 'source-machine',
      sourceRootPath: '/source',
      targetMachineId: 'target-machine',
    })).toThrowError(expect.objectContaining({ code: 'relationship_source_mismatch' }));
  });

  it('derives a linked-spoke destination and ordered route from current settings', () => {
    const sourceHub = {
      ...relationship,
      relationshipId: 'source-hub',
      controllerMachineId: 'hub-machine',
      alphaWorkspaceRefId: 'hub-ref',
      betaWorkspaceRefId: 'source-ref',
      mode: 'keep_both_in_sync' as const,
    };
    const hubTarget = {
      ...relationship,
      relationshipId: 'hub-target',
      controllerMachineId: 'hub-machine',
      alphaWorkspaceRefId: 'hub-ref',
      betaWorkspaceRefId: 'target-ref',
    };
    expect(resolveSessionHandoffWorkspaceContext({
      serverId: 'server-1',
      action: { kind: 'linked_workspace' },
      workspaceRefs: refs,
      relationships: [sourceHub, hubTarget],
      sourceMachineId: 'source-machine',
      sourceRootPath: '/source',
      targetMachineId: 'target-machine',
      targetRootPath: '/target',
    })).toMatchObject({
      sourceWorkspaceRefId: 'source-ref',
      targetWorkspaceRefId: 'target-ref',
      controllerMachineId: 'hub-machine',
      relationshipIds: ['source-hub', 'hub-target'],
      contentSelections: ['all_files', 'all_files'],
    });
  });
});
