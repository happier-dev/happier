import { describe, expect, it } from 'vitest';
import type { RpcHandlerContext, RpcHandlerMap, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createMachineResourcesPolicyRuntime } from '@/daemon/resources/machineResourcesPolicy';
import { registerDaemonMachineResourcesPolicyRpcHandlers } from './daemonMachineResourcesPolicy';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';

describe('machine resources policy Manage admission', () => {
  it.each(['owner', 'recipient'])('finishes an admitted %s policy save with one authorization and refuses the next request after revocation', async actorAccountId => {
    const identity = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
    let current = true;
    let verifications = 0;
    let written = false;
    const policy = createMachineResourcesPolicyRuntime({ port: {
      read: async () => { current = false; return { status: 'ready', metadata: {}, metadataVersion: 1 }; },
      compareAndSwap: async ({ metadata }) => { written = true; return { status: 'applied', metadata, metadataVersion: 2 }; },
    } });
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: identity.machineId,
        resolveCustodianAccountId: async () => identity.custodianAccountId, resolveInstallationId: () => identity.installationId,
        // Home authorization is the network boundary; policy admission and metadata CAS remain real.
        verifyMachineAdmission: async () => { verifications++; return current; } }) });
    registerDaemonMachineResourcesPolicyRpcHandlers(manager, { policy, target: () => identity });
    const request = { method: `machine:${RPC_METHODS.MACHINES_RESOURCES_POLICY_SET}`,
      params: { machineId: 'machine', expectedRevision: 1, patch: { alerts: { cpu: { enabled: true } } } },
      callerAuthority: 'present_user' as const,
      machineAdmission: { machineId: identity.machineId, installationId: identity.installationId,
        custodianAccountId: identity.custodianAccountId, actorAccountId, role: 'manage' as const, encryptionMode: 'plain' as const } };
    try {
      expect(await manager.handleRequest(request)).toMatchObject({ status: 'applied', revision: 2 });
      expect(written).toBe(true);
      expect(verifications).toBe(1);
      expect(await manager.handleRequest(request)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      expect(verifications).toBe(2);
    } finally { policy.stop(); }
  });
  it('saves custodian policies for a caller-local label of the admitted Home', async () => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      await withTempDir('happier-resources-home-', async home => {
        env.patch({ HAPPIER_HOME_DIR: home }); reloadConfiguration();
        const profile = await addServerProfile({ name: 'stack_resources__id_default', serverUrl: 'https://qa.example.test', webappUrl: 'https://qa.example.test' });
        const homeId = 'srv_resources_qa';
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
          v: 1, homeServerIdentityId: homeId, canonicalServerUrl: profile.serverUrl, revision: 1,
          endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        const identity = { serverId: profile.id, machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
        let metadata: Record<string, unknown> = {}; let revision = 1;
        const policy = createMachineResourcesPolicyRuntime({ port: {
          read: async () => ({ status: 'ready', metadata, metadataVersion: revision }),
          compareAndSwap: async input => { metadata = input.metadata; return { status: 'applied', metadata, metadataVersion: ++revision }; },
        } });
        const handlers: RpcHandlerMap = new Map();
        registerDaemonMachineResourcesPolicyRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, { policy, target: () => identity });
        const set = handlers.get(RPC_METHODS.MACHINES_RESOURCES_POLICY_SET)!;
        const context: RpcHandlerContext = { signal: new AbortController().signal,
          machineAdmission: { ...identity, actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' },
          verifyMachineAdmissionCurrent: async () => true };
        const input = { serverId: 'browser-home', machineId: 'machine', expectedRevision: revision, patch: { alerts: { memory: { enabled: true } } } };
        try {
          await expect(set({ ...input, machineId: 'other-machine' }, context)).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
          await expect(set(input, { ...context, machineAdmission: { ...context.machineAdmission!, installationId: 'replaced' } })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
          await expect(set(input, { ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'recipient', role: 'use' } })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
          expect(await set(input, context)).toMatchObject({ status: 'applied', policy: { alerts: { memory: { enabled: true } } } });
          expect(await set({ ...input, expectedRevision: revision, patch: { processes: { allProcessesVisible: true } } }, context))
            .toMatchObject({ status: 'applied', policy: { processes: { allProcessesVisible: true }, alerts: { memory: { enabled: true } } } });
        } finally { policy.stop(); }
      });
    } finally { env.restore(); reloadConfiguration(); }
  });
  it('allows owner and Manage member saves and refuses Use and locally cancelled saves', async () => {
    const identity = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
    let writes = 0;
    const controller = new AbortController();
    let cancelDuringRead = false;
    const runtime = createMachineResourcesPolicyRuntime({ port: {
      read: async () => { if (cancelDuringRead) controller.abort(); return { status: 'ready', metadata: {}, metadataVersion: 1 }; },
      compareAndSwap: async ({ metadata }) => { writes++; return { status: 'applied', metadata, metadataVersion: 2 }; },
    } });
    // Match the canonical erased heterogeneous RPC transport registry.
    const handlers: RpcHandlerMap = new Map();
    const rpc: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
    registerDaemonMachineResourcesPolicyRpcHandlers(rpc, { policy: runtime, target: () => identity });
    const handler = handlers.get(RPC_METHODS.MACHINES_RESOURCES_POLICY_SET)!;
    const context = (actorAccountId: string, role: 'manage' | 'use' = 'manage'): RpcHandlerContext => ({ signal: controller.signal,
      machineAdmission: { machineId: identity.machineId, installationId: identity.installationId, custodianAccountId: 'owner', actorAccountId, role, encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true,
    });
    const input = { machineId: 'machine', expectedRevision: 1, patch: { alerts: { cpu: { enabled: true } } } };
    await expect(handler(input, context('recipient', 'use'))).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
    expect(writes).toBe(0);
    expect(await handler(input, context('owner'))).toMatchObject({ status: 'applied', revision: 2 });
    expect(await handler(input, context('recipient'))).toMatchObject({ status: 'applied', revision: 2 });
    cancelDuringRead = true;
    expect(await handler(input, context('owner'))).toMatchObject({ status: 'unavailable' });
    expect(writes).toBe(2);
    runtime.stop();
  });
});
