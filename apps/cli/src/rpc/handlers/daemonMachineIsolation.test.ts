import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { machineIsolationMetadataFieldV1 } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { registerDaemonMachineIsolationRpcHandlers } from './daemonMachineIsolation';

describe('Machine isolation policy Manage admission', () => {
  it('refuses Use, admits Manage, and preserves unrelated metadata at the actual metadata boundary', async () => {
    const identity = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
    let metadata: Record<string, unknown> = { host: 'h' };
    let version = 1;
    let writes = 0;
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: identity.machineId,
        resolveCustodianAccountId: async () => identity.custodianAccountId, resolveInstallationId: () => identity.installationId,
        // Home authorization is the network boundary; local role admission and CAS stay real.
        verifyMachineAdmission: async () => true }) });
    registerDaemonMachineIsolationRpcHandlers(manager, { target: () => identity,
      captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadata, metadataVersion: version }),
        compareAndSwap: async input => { writes++; metadata = input.metadata; return { status: 'applied', metadata, metadataVersion: ++version }; } }),
      validateConfiguredSandboxes: async () => { throw new Error('This policy has no saved preset references'); },
    });
    const expectedPolicy = machineIsolationMetadataFieldV1.defaultValue();
    const policy = { ...expectedPolicy, agentNativeSandboxEnabled: true };
    const request = (role: 'use' | 'manage', actorAccountId: string, expectedMetadataVersion = 1,
      before = expectedPolicy, after = policy) => ({ method: `machine:${RPC_METHODS.MACHINES_ISOLATION_SET}`,
      params: { machineId: 'machine', expectedMetadataVersion, expectedPolicy: before, policy: after }, callerAuthority: 'present_user' as const,
      machineAdmission: { machineId: identity.machineId, installationId: identity.installationId,
        custodianAccountId: identity.custodianAccountId, actorAccountId, role, encryptionMode: 'plain' as const } });
    expect(await manager.handleRequest(request('use', 'member'))).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(writes).toBe(0);
    expect(await manager.handleRequest(request('manage', 'owner'))).toMatchObject({ status: 'applied', policy });
    expect(writes).toBe(1);
    expect(metadata).toEqual({ host: 'h', isolationPolicyV1: policy });
    const next = { ...policy, agentNativeSandboxEnabled: false };
    expect(await manager.handleRequest(request('manage', 'member', 2, policy, next))).toMatchObject({ status: 'applied', policy: next });
    expect(writes).toBe(2);
  });
});
