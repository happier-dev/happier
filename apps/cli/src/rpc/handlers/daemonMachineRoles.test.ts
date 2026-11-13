import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createMachineRolesRuntime } from '@/daemon/roles/machineRolesRuntime';
import { registerDaemonMachineRolesRpcHandlers } from './daemonMachineRoles';

describe('machine roles Manage admission', () => {
  it('lets Manage change the role set and refuses a Team-shared Use member without writing', async () => {
    const identity = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
    let metadata: Record<string, unknown> = { host: 'h' };
    let version = 1;
    let writes = 0;
    const roles = createMachineRolesRuntime({ port: {
      read: async () => ({ status: 'ready', metadata, metadataVersion: version }),
      compareAndSwap: async input => { writes++; metadata = input.metadata; return { status: 'applied', metadata, metadataVersion: ++version }; },
    } });
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: identity.machineId,
        resolveCustodianAccountId: async () => identity.custodianAccountId, resolveInstallationId: () => identity.installationId,
        // Home authorization is the network boundary; role admission and metadata CAS stay real.
        verifyMachineAdmission: async () => true }) });
    registerDaemonMachineRolesRpcHandlers(manager, { roles, target: () => identity });
    const request = (role: 'use' | 'manage', actorAccountId: string) => ({ method: `machine:${RPC_METHODS.MACHINES_ROLES_SET}`,
      params: { machineId: 'machine', expectedMetadataVersion: 1, expectedPolicy: { active: ['sessions', 'broker', 'intake', 'deployments', 'workspaces', 'relay', 'memory', 'voice', 'devices'] },
        policy: { active: ['broker'] } },
      callerAuthority: 'present_user' as const,
      machineAdmission: { machineId: identity.machineId, installationId: identity.installationId,
        custodianAccountId: identity.custodianAccountId, actorAccountId, role, encryptionMode: 'plain' as const } });
    try {
      expect(await manager.handleRequest(request('use', 'member'))).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      expect(writes).toBe(0);
      expect(await manager.handleRequest(request('manage', 'owner'))).toMatchObject({ status: 'applied', policy: { active: ['broker'] } });
      expect(writes).toBe(1);
      expect(roles.isActive('sessions')).toBe(false);
    } finally { roles.stop(); }
  });
});
