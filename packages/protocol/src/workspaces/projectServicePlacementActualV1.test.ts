import { describe, expect, it } from 'vitest';
import { observeProjectServicePlacementActualV1 } from './projectServicePlacementV1.js';
import type { WorkspaceSyncChildMachineFacts } from './workspaceSyncTopology.js';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '../sessions/control/handoff/workspaceSyncSchemas.js';

describe('actual service placement through admitted Sync endpoints', () => {
  it.each(['source', 'worker'] as const)('observes a bind child %s namespace on a paused physical component without requiring its controller', async childRole => {
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
    const relationship = { v: 1, relationshipId: 'physical-link', controllerMachineId: source.machineId,
      alphaWorkspaceRefId: source.id, betaWorkspaceRefId: worker.id, mode: 'keep_synced', enabled: false,
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
      childMachines: [{ ...childMachines[0], managedMachine: { ...childMachines[0].managedMachine, enrolledMachineId: 'replaced-child' } }],
    })).toEqual({ status: 'unavailable' });
  });
});
