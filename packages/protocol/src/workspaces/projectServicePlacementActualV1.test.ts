import { describe, expect, it } from 'vitest';
import { observeProjectServicePlacementActualV1, ProjectServicePlacementGetResultV1Schema, createDefaultProjectServicePlacementV1 } from './projectServicePlacementV1.js';
import type { WorkspaceSyncChildMachineFacts } from './workspaceSyncTopology.js';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '../sessions/control/handoff/workspaceSyncSchemas.js';

describe('actual service placement through admitted Sync endpoints', () => {
  it.each(['host', 'guest'] as const)('names unsupported daemon-free service observation from %s without addressing its guest root on the host', async source => {
    const host = { id: 'host', serverId: 'home', machineId: 'host-machine', rootPath: '/repo', createdAtMs: 1 };
    const guest = { v: 2 as const, kind: 'managed' as const, id: 'guest', serverId: 'home', managedId: 'guest',
      controller: { machineId: host.machineId, installationId: 'current' }, rootPath: host.rootPath, createdAtMs: 1 };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const snapshots: string[] = [];
    const childReads: string[] = [];
    expect(await observeProjectServicePlacementActualV1({ workspace: { serverId: 'home', refId: source }, serviceName: 'web',
      workspaceRefs: [host, guest], relationships: [{ v: 1, relationshipId: 'link', controllerMachineId: host.machineId,
        alphaWorkspaceRefId: host.id, betaWorkspaceRefId: guest.id, mode: 'keep_synced', enabled: true,
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 }],
      isCurrent: () => true, readChildMachines: async ids => { childReads.push(...ids); return []; },
      readSnapshot: async request => { snapshots.push(request.machineId); return { protocolVersion: 1,
        snapshot: { v: 1, machineId: host.machineId, updatedAt: 1, targets: [] } }; },
    })).toEqual({ status: 'unavailable', reasonCode: 'external_observation_unsupported' });
    expect(snapshots).toEqual(source === 'host' ? [host.machineId] : []);
    expect(childReads.every(id => id === host.machineId)).toBe(true);
  });
  it.each([
    ['currentness', 'observation_changed'],
    ['workspace', 'workspace_unavailable'],
    ['topology', 'topology_unavailable'],
    ['binding', 'binding_invalid'],
    ['child-read', 'observation_unavailable'],
  ] as const)('names the cause of an unavailable %s observation', async (cause, reasonCode) => {
    const source = { id: 'source', serverId: 'home', machineId: 'source-machine', rootPath: '/source', createdAtMs: 1 };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const actual = await observeProjectServicePlacementActualV1({ workspace: { serverId: 'home', refId: source.id }, serviceName: 'web',
      workspaceRefs: cause === 'workspace' ? [] : [source],
      relationships: cause === 'topology' ? [{ v: 1, relationshipId: 'broken', controllerMachineId: source.machineId,
        alphaWorkspaceRefId: source.id, betaWorkspaceRefId: 'missing', mode: 'keep_synced', enabled: true,
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 }] : [],
      isCurrent: () => cause !== 'currentness',
      ...(cause === 'child-read' ? { readChildMachines: async () => { throw new Error('Machine observation failed'); } } : {}),
      readSnapshot: async () => ({ protocolVersion: 1, snapshot: { v: 1, machineId: source.machineId, updatedAt: 1,
        targets: cause === 'binding' ? [{ id: 'incomplete', machineId: source.machineId, source: 'managed_service',
          sourceClass: { kind: 'managed_service', managedServiceId: 'instance' }, title: 'web', state: 'available', confidence: 'high', actions: [] }] : [] } }),
    });
    expect(actual).toMatchObject({ status: 'unavailable', reasonCode });
    expect(ProjectServicePlacementGetResultV1Schema.parse({ status: 'ready', placement: createDefaultProjectServicePlacementV1(),
      revision: 'absent', provenance: 'default', actual }).actual).toEqual(actual);
  });
  it.each([
    ['source', 'transport'], ['worker', 'transport'], ['source', 'snapshot'], ['source', 'binding'],
  ] as const)('retains the observed %s binding when the other native Machine read fails (%s)', async (hosting, failure) => {
    const source = { id: 'source', serverId: 'home', machineId: 'source-machine', rootPath: '/source', createdAtMs: 1 };
    const worker = { ...source, id: 'worker', machineId: 'worker-machine', rootPath: '/worker' };
    const host = hosting === 'source' ? source : worker;
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship: WorkspaceSyncRelationshipV1 = { v: 1, relationshipId: 'copy', controllerMachineId: source.machineId,
      alphaWorkspaceRefId: source.id, betaWorkspaceRefId: worker.id, mode: 'keep_synced', enabled: false,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 };
    const target = { id: 'actual', source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'instance' },
      machineId: host.machineId, workspaceId: host.id, workspace: { serverId: host.serverId, workspaceId: host.id,
        machineId: host.machineId, rootPath: host.rootPath }, cwd: host.rootPath,
      declaration: { workspaceRefId: host.id, selection: { kind: 'manifest', name: 'web' } },
      serviceState: 'healthy', readiness: 'ready', title: 'web', state: 'available', confidence: 'high', actions: ['manage'] };
    const actual = await observeProjectServicePlacementActualV1({ workspace: { serverId: source.serverId, refId: source.id }, serviceName: 'web',
      workspaceRefs: [source, worker], relationships: [relationship], isCurrent: () => true,
      readSnapshot: async request => {
        if (request.machineId !== host.machineId) {
          if (failure === 'transport') throw new Error('Candidate unavailable');
          if (failure === 'snapshot') return { protocolVersion: 1, snapshot: { v: 1, machineId: 'wrong-machine', updatedAt: 1, targets: [] } };
          const { declaration: _declaration, ...unqualified } = target;
          return { protocolVersion: 1, snapshot: { v: 1, machineId: request.machineId, updatedAt: 1, targets: [unqualified] } };
        }
        return { protocolVersion: 1, snapshot: { v: 1, machineId: host.machineId, updatedAt: 1, targets: [target] } };
      } });
    expect(actual).toEqual({ status: 'present', target });
    expect(ProjectServicePlacementGetResultV1Schema.parse({ status: 'ready', placement: createDefaultProjectServicePlacementV1(),
      provenance: 'default', revision: 'absent', actual })).toMatchObject({ actual });
  });
  it('excludes only explicitly uncommitted worker copies and names an unreadable committed or legacy Machine', async () => {
    const source = { id: 'source', serverId: 'home', machineId: 'source-machine', rootPath: '/source', createdAtMs: 1 };
    const worker = { ...source, id: 'worker', machineId: 'offline-machine', rootPath: '/worker' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = { v: 1 as const, relationshipId: 'copy', controllerMachineId: source.machineId,
      alphaWorkspaceRefId: source.id, betaWorkspaceRefId: worker.id, mode: 'keep_synced' as const, enabled: false,
      provenance: { kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: source.id, targetWorkspaceRefId: worker.id },
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 };
    const reads = new Set<string>();
    const input = { workspace: { serverId: 'home', refId: source.id }, serviceName: 'web', workspaceRefs: [source, worker],
      relationships: [relationship], isCurrent: () => true,
      readSnapshot: async (request: { machineId: string }) => {
        reads.add(request.machineId);
        if (request.machineId === worker.machineId) throw new Error('Machine offline');
        return { protocolVersion: 1, snapshot: { v: 1, machineId: request.machineId, updatedAt: 1, targets: [] } };
      } };
    for (const enabled of [false, true]) {
      expect(await observeProjectServicePlacementActualV1({ ...input, relationships: [{ ...relationship, enabled, committedAtMs: null }] }))
        .toEqual({ status: 'absent' });
      expect(reads).toEqual(new Set([source.machineId]));
    }
    for (const edge of [{ ...relationship, committedAtMs: 2 }, relationship,
      { ...relationship, committedAtMs: null, provenance: undefined }]) {
      const actual = await observeProjectServicePlacementActualV1({ ...input, relationships: [edge] });
      expect(actual)
        .toEqual({ status: 'unavailable', machineId: worker.machineId, reasonCode: 'machine_unavailable' });
      expect(ProjectServicePlacementGetResultV1Schema.parse({ status: 'ready', placement: createDefaultProjectServicePlacementV1(),
        provenance: 'default', revision: 'absent', actual })).toMatchObject({ actual });
    }
  });
  it.each(['source', 'worker'] as const)('observes the child %s as its own physical endpoint on a paused component', async childRole => {
    const source = { id: 'source', serverId: 'home', machineId: 'source-machine', rootPath: '/source', createdAtMs: 1 };
    const worker = { ...source, id: 'worker', machineId: 'worker-machine', rootPath: '/worker' };
    const child = { ...source, id: 'child', machineId: 'child-machine', rootPath: '/work/custom' };
    const parent = childRole === 'source' ? source : worker;
    const actual = childRole === 'worker' ? child : worker;
    const requested = childRole === 'source' ? child : source;
    const observation = { nativeResourceId: 'native-child', user: 'coder', workspaceFolder: child.rootPath,
      storage: { kind: 'bind' as const, hostPath: parent.rootPath, childPath: child.rootPath } };
    const controller = { machineId: parent.machineId, installationId: 'parent-installation' };
    const childMachines = [{ serverId: 'home', machineId: child.machineId, installationId: 'child-installation',
      projection: { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer', parentMachineId: parent.machineId }, observation },
      managedMachine: { id: 'managed-child', homeId: 'home', custodianAccountId: 'owner', controller,
        launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Child', choices: {} },
        resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {}, devcontainerObservation: observation },
        allocation: 'bound', creationState: 'active', enrolledMachineId: child.machineId,
        desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
      controller: { ...controller, available: false },
    }] satisfies readonly WorkspaceSyncChildMachineFacts[];
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const syncSource = childRole === 'source' ? child : source;
    const syncWorker = childRole === 'worker' ? child : worker;
    const relationship = { v: 1, relationshipId: 'physical-link', controllerMachineId: syncSource.machineId,
      alphaWorkspaceRefId: syncSource.id, betaWorkspaceRefId: syncWorker.id, mode: 'keep_synced', enabled: false,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1,
    } satisfies WorkspaceSyncRelationshipV1;
    const target = { id: 'actual', source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'instance' },
      machineId: actual.machineId, workspaceId: actual.id,
      workspace: { serverId: 'home', workspaceId: actual.id, machineId: actual.machineId, rootPath: actual.rootPath },
      cwd: actual.rootPath, declaration: { workspaceRefId: actual.id, selection: { kind: 'manifest', name: 'web' } },
      serviceState: 'running', readiness: 'not_reported', title: 'web', state: 'available', confidence: 'high', actions: ['manage'] };
    const input = { workspace: { serverId: 'home', refId: requested.id }, serviceName: 'web',
      workspaceRefs: [source, worker, child], relationships: [relationship], childMachines, isCurrent: () => true,
      // The exact daemon snapshot read is the remote-process boundary, not a mocked topology decision.
      readSnapshot: async (request: { machineId: string }) => ({ protocolVersion: 1, snapshot: { v: 1,
        machineId: request.machineId, updatedAt: 1, targets: request.machineId === actual.machineId ? [target] : [] } }),
    };
    expect(await observeProjectServicePlacementActualV1(input)).toEqual({ status: 'present', target });
    expect(await observeProjectServicePlacementActualV1({ ...input,
      workspace: { ...input.workspace, serverId: 'profile-alias' },
      context: { normalizeServerId: id => id === 'profile-alias' ? 'home' : id },
    })).toEqual({ status: 'present', target });
    const unrelated = { ...child, id: 'unrelated', machineId: 'unrelated-machine', rootPath: '/unrelated' };
    const unrelatedFact = { ...childMachines[0], machineId: unrelated.machineId,
      projection: { ...childMachines[0].projection, observation: { ...observation, workspaceFolder: unrelated.rootPath,
        storage: { kind: 'bind' as const, hostPath: '/unrelated-host', childPath: unrelated.rootPath } } },
      managedMachine: { ...childMachines[0].managedMachine, enrolledMachineId: 'retired-neighbour' } };
    expect(await observeProjectServicePlacementActualV1({ ...input, workspaceRefs: [...input.workspaceRefs, unrelated],
      childMachines: [...childMachines, unrelatedFact],
    })).toEqual({ status: 'present', target });
    const { childMachines: _facts, ...passiveInput } = input;
    const scopedInput = { ...passiveInput, workspaceRefs: [...input.workspaceRefs, unrelated],
      readChildMachines: async (machineIds: readonly string[]) => {
        if (machineIds.includes(unrelated.machineId)) throw new Error('Unrelated retired Machine must not be acquired');
        return childMachines.filter(fact => machineIds.includes(fact.machineId));
      } };
    expect(await observeProjectServicePlacementActualV1(scopedInput)).toEqual({ status: 'present', target });
    expect(await observeProjectServicePlacementActualV1({ ...input,
      childMachines: [{ ...childMachines[0], managedMachine: { ...childMachines[0].managedMachine, enrolledMachineId: 'replaced-child' } }],
    })).toMatchObject({ status: 'unavailable' });
  });
});
