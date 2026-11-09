import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createCliMachineActionTransport } from './machineTransport';
import type { MachineActionDirectTargetTransport } from '../createCliActionDeps';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { readMachineAdminAccessV1 } from '@happier-dev/protocol';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { registerDaemonMachineAdminAccessRpcHandlers } from '@/rpc/handlers/daemonMachineAdminAccess';
import { createMachineAdminAccessObserver } from '@/machines/adminAccess/observeMachineAdminAccess';
import { createMachineAdminAccessHost } from '@/machines/adminAccess/machineAdminAccessHost';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { createAgentIsolationEffectsBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';

afterEach(() => vi.restoreAllMocks());

describe('isolation and admin-access Machine admission', () => {
  it('previews enrollment isolation with the receiving Action admission instead of serializing its proof again', async () => {
    const actionId = 'machines.agentIsolation.preview';
    const target = { serverId: 'home-profile', machineId: 'guest', installationId: 'installation', custodianAccountId: 'owner' };
    const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'guest',
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const externalTarget = { kind: 'machine' as const, machineId: 'guest' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'receiving-admission', binding: {
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId, requestId: 'enrollment-preview', machineId: 'guest',
      installationId: 'installation', target: externalTarget, requestEnvelopeDigest: 'a'.repeat(43),
      managedContinuation: { managedId: 'managed', creationRequestId: 'creation', expectedIntentRevision: 0,
        controller: { machineId: 'controller', installationId: 'controller-installation' }, acquireRequestEnvelopeDigest: 'a'.repeat(43) },
    } });
    const request = { serverId: 'home', machineId: 'guest', enabled: true, memberProvisioning: 'linuxUsersV1' };
    const native = createAgentIsolationEffectsBoundary({ installationId: 'installation', installedCli: '/opt/happier/current/happier',
      readRoots: () => [], readSessionsToReplace: () => 0, publishStatus: async () => {} });
    const rpc = new RpcHandlerManager({ scopePrefix: 'guest', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: input => authorizeMachineRpcRequest(input, { machineId: 'guest', resolveInstallationId: () => 'installation',
        resolveCustodianAccountId: async () => 'owner', resolveHomeServerIdentityId: async () => 'home', verifyMachineAdmission: async () => true }) });
    registerDaemonMachineAgentIsolationRpcHandlers(rpc, { target: () => target, readCanonicalHomeServerIdentityId: () => 'home',
      read: () => ({ enabled: false, status: { kind: 'disabled' } }), effects: native.effects,
      captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
        compareAndSwap: async () => { throw new Error('Preview must not write'); } }) });
    // Socket transport is the boundary: the Action envelope digest is not the
    // digest of a newly serialized native RPC. Keep the receiver/authorizer real.
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async input => rpc.handleRequest({
      method: `guest:${input.method}`, params: input.request, requestId: 'rpc-enrollment-preview',
      callerAuthority: 'present_user', callerInputAuthorization: authorization, machineAdmission,
    }));
    const transport = createCliMachineActionTransport({ credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
      serverId: 'home-profile', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.example.test',
      externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: new Uint8Array(64),
      machineActionDirectTargetTransport: { machineId: 'guest', invoke: (method, input, options) => rpc.invokeLocal(method, input, options) } });
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home', actionRequestId: 'enrollment-preview',
      machineAdmission, externalActionExecutionAuthorization: authorization, externalActionTarget: externalTarget } satisfies RpcActionExecutorContext;
    expect(await transport.callMachineAction({ machineId: 'guest', serverId: 'home', method: actionId, effectActionId: actionId,
      request, context, exactMachine: true })).toMatchObject({ kind: 'ready' });
    expect(native.mutations).toEqual([]);
  });
  it('settles an admitted administrator Action at its receiving operation owner and persists its policy', async () => {
    const actionId = 'machines.setup.adminAccess.set';
    const target = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
    const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'e2ee' as const };
    const externalTarget = { kind: 'machine' as const, machineId: 'machine' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'receiving-admission',
      binding: { accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'e2ee', serverIdentityId: 'home', actionId, requestId: 'enrollment-admin',
        machineId: 'machine', installationId: 'installation', target: externalTarget, requestEnvelopeDigest: 'a'.repeat(43) } });
    const request = { serverId: 'home', machineId: 'machine', expectedMetadataVersion: 0, expectedAdminAccess: { version: 1, mode: 'none' },
      adminAccess: { version: 1, mode: 'preauthorized' }, comparison: 'field' };
    let metadata: Record<string, unknown> = {}, metadataVersion = 0;
    // Opened Machine metadata is the storage boundary; mutation and operation logic remain real.
    const port: MachineMetadataFieldPortV1 = { read: async () => ({ status: 'ready', metadata, metadataVersion }),
      compareAndSwap: async input => {
        if (input.expectedMetadataVersion !== metadataVersion) return { status: 'conflict', metadata, metadataVersion };
        metadata = input.metadata; metadataVersion++;
        return { status: 'applied', metadata, metadataVersion };
      } };
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'owner' });
    // Home verification is the authorization boundary. The native receiver still checks the exact Machine and Manage role.
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: input => authorizeMachineRpcRequest(input, { machineId: 'machine',
        resolveInstallationId: () => 'installation', resolveCustodianAccountId: async () => 'owner',
        resolveHomeServerIdentityId: async () => 'home', verifyMachineAdmission: async () => true }) });
    const observer = createMachineAdminAccessObserver({ platform: 'win32', onChanged: async () => {} });
    const host = createMachineAdminAccessHost({ installationId: 'installation', installedCli: '/unused',
      readPolicy: async () => { const value = readMachineAdminAccessV1(metadata);
        if (value.status !== 'ready') throw new Error('Metadata unavailable'); return value.policy; },
      observe: async () => (await observer.inspect()).observation });
    registerDaemonMachineAdminAccessRpcHandlers(rpc, { target: () => target, observer,
      reconcile: host.reconcile, captureMetadataPort: () => port, runActionOperation: operations.runActionOperation });
    // A serialized self-RPC cannot retain the active host operation and would join itself.
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockRejectedValue(new Error('Lost receiving operation through self-RPC'));
    const transport = createCliMachineActionTransport({
      credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
      serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.example.test',
      externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: new Uint8Array(64),
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: (method, input, options) => rpc.invokeLocal(method, input, options) },
    });
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home', actionRequestId: 'enrollment-admin',
      machineAdmission, externalActionExecutionAuthorization: authorization, externalActionTarget: externalTarget } satisfies RpcActionExecutorContext;
    const result = await operations.runActionOperation({ actionId, input: request, context,
      execute: async context => ({ ok: true, result: await transport.callMachineAction({ machineId: 'machine',
        method: actionId, effectActionId: actionId, request, context, exactMachine: true }) }) });
    expect(result).toMatchObject({ ok: true, result: { status: 'applied', policy: { version: 1, mode: 'preauthorized' } } });
    expect(readMachineAdminAccessV1(metadata)).toMatchObject({ status: 'ready', source: 'stored', policy: { mode: 'preauthorized' } });
  });
  it.each([...ACTION_ID_FAMILIES_V1.machine_agent_isolation, ...ACTION_ID_FAMILIES_V1.machine_admin_access]
    .flatMap(actionId => { const method = getActionSpec(actionId).bindings?.rpcMethod; return method ? [method] : []; }))('keeps protected native %s on authenticated Machine ingress', async method => {
      const local = vi.fn<MachineActionDirectTargetTransport['invoke']>();
      const admitted = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ status: 'unavailable', code: 'permission_denied' });
      const transport = createCliMachineActionTransport({
        credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
        serverId: 'home-profile', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example.test',
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: local },
      });
      expect(await transport.callMachineAction({ machineId: 'machine', method, request: {} }))
        .toEqual({ status: 'unavailable', code: 'permission_denied' });
      expect(local).not.toHaveBeenCalled();
      expect(admitted).toHaveBeenCalledOnce();
    });
});
