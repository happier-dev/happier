import { describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceRefV1, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';

import { prepareWorkspaceSyncBetween, resolveWorkspaceSyncWorkerTarget, assertWorkspaceSyncWorkerTargetCurrent,
  resolveWorkspaceSyncRelationshipDependencyMachines } from './workspaceSyncPreparation';
import type { WorkspaceSyncStatusV1 } from './workspaceSyncTypes';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

const basePolicy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
const contentPolicy = { ...basePolicy, policyDigest: computeWorkspaceSyncPolicyDigest(basePolicy) };
const refs: readonly WorkspaceRefV1[] = [
  { id: 'a', serverId: 's', machineId: 'ma', rootPath: '/a', createdAtMs: 1 },
  { id: 'b', serverId: 's', machineId: 'mb', rootPath: '/b', createdAtMs: 1 },
  { id: 'c', serverId: 's', machineId: 'mc', rootPath: '/c', createdAtMs: 1 },
];
const relationship = (id: string, alpha: string, beta: string, mode: WorkspaceSyncRelationshipV1['mode'] = 'keep_both_in_sync'): WorkspaceSyncRelationshipV1 => ({
  v: 1, relationshipId: id, controllerMachineId: 'ma', alphaWorkspaceRefId: alpha, betaWorkspaceRefId: beta,
  mode, contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1,
});
const workerCopy = (value: WorkspaceSyncRelationshipV1): WorkspaceSyncRelationshipV1 => ({ ...value,
  provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: value.alphaWorkspaceRefId, targetWorkspaceRefId: value.betaWorkspaceRefId },
});
const status = (id: string): WorkspaceSyncStatusV1 => ({
  relationshipId: id, controllerMachineId: 'ma', state: 'watching', alphaPath: '/a', betaPath: '/b', mode: 'keep_both_in_sync',
  endpointStates: {
    alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
    beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
  }, conflictCount: 0, lastCycleObservedAtMs: null,
});

describe('prepareWorkspaceSyncBetween', () => {
  it('requires an admitted worker copy, ignores ordinary linked roots and retains copy custody at dequeue', () => {
    const ordinary = relationship('ab', 'a', 'b', 'keep_synced');
    const input = { serverId: 's', sourceWorkspaceRefId: 'a', targetMachineId: 'mb', workspaceRefs: refs, relationships: [ordinary] };
    expect(resolveWorkspaceSyncWorkerTarget({ ...input, relationships: [] })).toEqual({ ok: false, errorCode: 'worker_copy_missing' });
    expect(resolveWorkspaceSyncWorkerTarget(input)).toEqual({ ok: false, errorCode: 'worker_copy_missing' });
    const dedicated = workerCopy(ordinary);
    const second = { ...refs[1]!, id: 'ordinary', rootPath: '/ordinary' };
    const basis = resolveWorkspaceSyncWorkerTarget({ ...input, workspaceRefs: [...refs, second],
      relationships: [dedicated, relationship('a-ordinary', 'a', 'ordinary')] });
    expect(basis).toMatchObject({ ok: true, target: { id: 'b' } });
    if (!basis.ok) throw new Error('Dedicated fixture did not resolve');
    expect(() => assertWorkspaceSyncWorkerTargetCurrent(basis, input)).toThrow(expect.objectContaining({ code: 'relationship_changed' }));
  });
  it('prepares the existing parent relationship from an admitted bind child without changing its execution identity', async () => {
    const child = { id: 'child', serverId: 's', machineId: 'child-machine', rootPath: '/work/custom', createdAtMs: 1 };
    const observation = { nativeResourceId: 'native-child', user: 'coder', workspaceFolder: child.rootPath,
      storage: { kind: 'bind' as const, hostPath: '/a', childPath: child.rootPath } };
    const projection = { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer' as const, parentMachineId: 'ma' }, observation };
    const managedMachine = { id: 'managed-child', homeId: 's', custodianAccountId: 'owner',
      controller: { machineId: 'ma', installationId: 'controller-installation' },
      launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Child', choices: {} },
      resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
        value: {}, devcontainerObservation: observation },
      allocation: 'bound' as const, creationState: 'active' as const, enrolledMachineId: child.machineId,
      desired: 'start' as const, desiredWhen: 'now' as const, intentRevision: 1,
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } satisfies ManagedMachineV1;
    const childMachines = [{ serverId: 's', machineId: child.machineId, installationId: 'child-installation',
      projection, managedMachine, controller: { ...managedMachine.controller, available: true } }];
    const relationships = [workerCopy(relationship('ab', 'a', 'b'))];
    const flushed: string[] = [];
    const input = { serverId: 's', sourceWorkspaceRefId: child.id, targetWorkspaceRefId: 'b',
      readCurrent: async () => ({ workspaceRefs: [...refs, child], relationships, childMachines }),
      flush: async (id: string) => { flushed.push(id); return status(id); } };
    await expect(prepareWorkspaceSyncBetween(input)).resolves.toMatchObject({ ok: true, traversed: [{ relationshipId: 'ab' }] });
    expect(flushed).toEqual(['ab']);
    expect(resolveWorkspaceSyncWorkerTarget({ serverId: 's', sourceWorkspaceRefId: child.id, targetMachineId: 'mb',
      workspaceRefs: [...refs, child], relationships, childMachines })).toMatchObject({ ok: true,
      source: { id: 'child', machineId: 'child-machine', rootPath: '/work/custom' }, target: { id: 'b', machineId: 'mb', rootPath: '/b' } });
    expect(resolveWorkspaceSyncWorkerTarget({ serverId: 's', sourceWorkspaceRefId: 'b', targetMachineId: child.machineId,
      workspaceRefs: [...refs, child], relationships, childMachines })).toEqual({ ok: false, errorCode: 'worker_copy_missing' });
    const workerBasis = resolveWorkspaceSyncWorkerTarget({ serverId: 's', sourceWorkspaceRefId: child.id, targetMachineId: 'mb',
      workspaceRefs: [...refs, child], relationships, childMachines });
    if (!workerBasis.ok) throw new Error('Bind worker fixture did not resolve');
    const replacement = { ...observation, nativeResourceId: 'replacement-native' };
    expect(() => assertWorkspaceSyncWorkerTargetCurrent(workerBasis, { serverId: 's', workspaceRefs: [...refs, child], relationships,
      childMachines: [{ ...childMachines[0]!, projection: { ...projection, observation: replacement },
        managedMachine: { ...managedMachine, resource: { ...managedMachine.resource, devcontainerObservation: replacement } } }] }))
      .toThrow(expect.objectContaining({ code: 'workspace_sync_child_unavailable' }));
    for (const invalid of [
      { ...childMachines[0]!, controller: { ...childMachines[0]!.controller, available: false } },
      { ...childMachines[0]!, managedMachine: { ...managedMachine, enrolledMachineId: 'replacement-child' } },
      { ...childMachines[0]!, projection: { ...projection, observation: { ...observation, nativeResourceId: 'replacement-native' } } },
      { ...childMachines[0]!, projection: { ...projection, observation: { ...observation, workspaceFolder: '/changed-root' } } },
    ]) {
      flushed.length = 0;
      await expect(prepareWorkspaceSyncBetween({ ...input,
        readCurrent: async () => ({ workspaceRefs: [...refs, child], relationships, childMachines: [invalid] }),
      })).resolves.toMatchObject({ ok: false, errorCode: 'workspace_sync_child_unavailable', completed: [] });
      expect(flushed).toEqual([]);
    }
    flushed.length = 0;
    await expect(prepareWorkspaceSyncBetween({ ...input,
      readCurrent: async () => ({ workspaceRefs: [...refs, child], relationships,
        childMachines: [{ ...childMachines[0]!, projection: { ...projection,
          observation: { ...observation, storage: { kind: 'child' as const, childPath: child.rootPath } } },
          managedMachine: { ...managedMachine, resource: { ...managedMachine.resource,
            devcontainerObservation: { ...observation, storage: { kind: 'child' as const, childPath: child.rootPath } } } } }] }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'route_not_found', completed: [] });
    expect(flushed).toEqual([]);
    let reads = 0;
    await expect(prepareWorkspaceSyncBetween({ ...input,
      readCurrent: async () => ({ workspaceRefs: [...refs, child], relationships,
        childMachines: ++reads === 1 ? childMachines : [{ ...childMachines[0]!, managedMachine: {
          ...managedMachine, resource: { ...managedMachine.resource, devcontainerObservation: {
            ...observation, storage: { ...observation.storage, hostPath: '/replacement-bind' } } } } }] }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'workspace_sync_child_unavailable', completed: [] });
    expect(flushed).toEqual([]);
    await expect(prepareWorkspaceSyncBetween({ ...input,
      readCurrent: async () => ({ workspaceRefs: [...refs, { ...refs[0]!, id: 'duplicate-parent' }, child], relationships, childMachines }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'workspace_sync_child_unavailable', completed: [] });
    expect(flushed).toEqual([]);
    reads = 0;
    await expect(prepareWorkspaceSyncBetween({ ...input,
      readCurrent: async () => ({ workspaceRefs: [...refs, child], relationships,
        childMachines: ++reads === 1 ? childMachines : [{ ...childMachines[0]!, projection: { ...projection, observation: replacement },
          managedMachine: { ...managedMachine, resource: { ...managedMachine.resource, devcontainerObservation: replacement } } }] }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'workspace_sync_child_unavailable', completed: [] });
    expect(flushed).toEqual([]);
  });

  it('resolves the selected worker from the reviewed source through the canonical star, never another component or first match', () => {
    const relationships = [relationship('ca', 'a', 'c'), workerCopy(relationship('ab', 'a', 'b', 'keep_synced'))];
    const input = { serverId: 's', sourceWorkspaceRefId: 'c', targetMachineId: 'mb', workspaceRefs: refs, relationships };
    expect(resolveWorkspaceSyncRelationshipDependencyMachines({ ...input, relationshipId: 'ca' }).sort())
      .toEqual(['ma', 'mb', 'mc']);
    expect(resolveWorkspaceSyncRelationshipDependencyMachines({ ...input, relationshipId: 'ab' }).sort())
      .toEqual(['ma', 'mb', 'mc']);
    expect(resolveWorkspaceSyncWorkerTarget(input)).toMatchObject({ ok: true,
      source: { id: 'c' }, target: { id: 'b' }, relationships: [{ relationshipId: 'ca' }, { relationshipId: 'ab' }] });
    const unrelated = { ...refs[1]!, id: 'unrelated' };
    expect(resolveWorkspaceSyncWorkerTarget({ ...input, workspaceRefs: [...refs, unrelated] })).toMatchObject({ ok: true, target: { id: 'b' } });
    const second = { ...refs[1]!, id: 'second', rootPath: '/second' };
    expect(resolveWorkspaceSyncWorkerTarget({ ...input, workspaceRefs: [...refs, second],
      relationships: [...relationships, workerCopy(relationship('a-second', 'a', 'second'))] }))
      .toEqual({ ok: false, errorCode: 'workspace_sync_target_ambiguous' });
    expect(resolveWorkspaceSyncWorkerTarget({ ...input, relationships: [relationships[1]!] }))
      .toMatchObject({ ok: false, errorCode: 'worker_copy_missing' });
    expect(resolveWorkspaceSyncWorkerTarget({ ...input, relationships: [relationship('ca', 'a', 'c', 'keep_synced'), relationships[1]!] }))
      .toMatchObject({ ok: false, errorCode: 'direction_mismatch' });
    const basis = resolveWorkspaceSyncWorkerTarget(input);
    if (!basis.ok) throw new Error('Fixture route unavailable');
    expect(() => assertWorkspaceSyncWorkerTargetCurrent(basis, input)).not.toThrow();
    const changedPolicy = { ...basePolicy, extraIgnorePatterns: ['current-approved-ignore'] };
    expect(() => assertWorkspaceSyncWorkerTargetCurrent(basis, { ...input,
      relationships: [{ ...relationships[0]!, updatedAtMs: 2,
        contentPolicy: { ...changedPolicy, policyDigest: computeWorkspaceSyncPolicyDigest(changedPolicy) } }, relationships[1]!] }))
      .not.toThrow();
    for (const changed of [
      { ...relationships[0]!, relationshipId: 'replacement-source-edge' },
      { ...relationships[0]!, controllerMachineId: 'mc' },
      { ...relationships[0]!, alphaWorkspaceRefId: 'c', betaWorkspaceRefId: 'a' },
    ]) {
      expect(() => assertWorkspaceSyncWorkerTargetCurrent(basis, { ...input,
        relationships: [changed, relationships[1]!] }))
        .toThrow(expect.objectContaining({ code: 'relationship_changed' }));
    }
    expect(() => assertWorkspaceSyncWorkerTargetCurrent(basis, { ...input,
      workspaceRefs: refs.map(ref => ref.id === 'a' ? { ...ref, rootPath: '/replacement-hub' } : ref) }))
      .toThrow(expect.objectContaining({ code: 'workspace_ref_changed' }));
  });

  it('flushes a two-link route in source-to-target order and returns actual facts', async () => {
    const relationships = [relationship('ca', 'a', 'c'), relationship('ab', 'a', 'b', 'keep_synced')];
    const flush = vi.fn(async (id: string) => status(id));
    await expect(prepareWorkspaceSyncBetween({
      sourceWorkspaceRefId: 'c', targetWorkspaceRefId: 'b', readCurrent: async () => ({ workspaceRefs: refs, relationships }), flush,
    })).resolves.toEqual({ ok: true, traversed: [
      { relationshipId: 'ca', policyDigest: contentPolicy.policyDigest, status: status('ca') },
      { relationshipId: 'ab', policyDigest: contentPolicy.policyDigest, status: status('ab') },
    ] });
    expect(flush.mock.calls.map(([id]) => id)).toEqual(['ca', 'ab']);
  });

  it('reports first-link completion and the blocked second link without rollback', async () => {
    const relationships = [relationship('ca', 'a', 'c'), relationship('ab', 'a', 'b', 'keep_synced')];
    const blocked = { ...status('ab'), state: 'conflicted' as const, conflictCount: 1 };
    const flush = vi.fn(async (id: string) => id === 'ca' ? status(id) : blocked);
    await expect(prepareWorkspaceSyncBetween({
      sourceWorkspaceRefId: 'c', targetWorkspaceRefId: 'b', readCurrent: async () => ({ workspaceRefs: refs, relationships }), flush,
    })).resolves.toMatchObject({
      ok: false, errorCode: 'workspace_sync_not_clean',
      completed: [{ relationshipId: 'ca' }], blockedRelationshipId: 'ab', blockedStatus: blocked,
    });
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('stops when a traversed definition changes between links', async () => {
    const relationships = [relationship('ca', 'a', 'c'), relationship('ab', 'a', 'b', 'keep_synced')];
    let reads = 0;
    const flush = vi.fn(async (id: string) => status(id));
    const result = await prepareWorkspaceSyncBetween({
      sourceWorkspaceRefId: 'c', targetWorkspaceRefId: 'b',
      readCurrent: async () => ({ workspaceRefs: refs, relationships: ++reads < 3 ? relationships : [{ ...relationships[0]!, enabled: false }, relationships[1]!] }),
      flush,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'relationship_changed', completed: [{ relationshipId: 'ca' }], blockedRelationshipId: 'ab' });
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
