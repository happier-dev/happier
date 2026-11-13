import { expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { applyManagedMachineEnrollmentIsolation } from '@happier-dev/cli-common/machines/managed';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { publishMachineMetadataOnce, readOpenedMachineMetadataSnapshot } from '@/api/machine/machineMetadataPublication';
import type { Machine } from '@/api/types';
import type { MachineAgentIsolationPolicyV1 } from '@happier-dev/protocol';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { readAgentIsolationSnapshot } from './agentIsolationPolicy';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';

it.each<MachineAgentIsolationPolicyV1>([
  { enabled: false },
  { enabled: true },
])('preserves a later isolation policy %j and running Sessions on enrolled recovery through the verified creation carrier', async laterPolicy => {
  const codec = createMachineContentCodec({ encryptionMode: 'plain' });
  const machine: Machine = { id: 'guest', encryptionMode: 'plain', metadataVersion: 1, daemonStateVersion: 1,
    metadata: { host: 'guest', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/happier',
      happyHomeDir: '/home/happier/.happier' },
    daemonState: { status: 'running', runtimeId: 'daemon', agentIsolation: { kind: 'disabled' } } };
  let publications = 0;
  const runningSessions = new Set<string>();
  const native = createAgentIsolationEffectsBoundary({ installationId: 'guest-installation', installedCli: '/opt/happier/cli/current/happier',
    readRoots: () => [], readSessionsToReplace: () => runningSessions.size,
    publishStatus: async status => { machine.daemonState = { ...machine.daemonState!, agentIsolation: status }; } });
  const port = {
    read: async () => readOpenedMachineMetadataSnapshot(machine, true),
    compareAndSwap: (input: Parameters<typeof publishMachineMetadataOnce>[1]) => publishMachineMetadataOnce({ getMachine: () => machine,
      codec, expectedDataEncryptionKey: null, isContentCurrent: () => true, retireAndRefreshContent: async () => {},
      notifyMetadataChanged: () => { publications++; }, socket: { connected: true, emitWithAck: async (_event, payload) => ({
        result: 'success' as const, version: payload.expectedVersion + 1, metadata: payload.metadata,
      }) } }, input),
  };
  const rpc = new RpcHandlerManager({ scopePrefix: machine.id, localMachineId: machine.id, encryptionMode: 'plain', logger: () => {},
    // Home authentication/current admission is the network boundary. Input
    // matching, receiving context, field CAS and native interpreter stay real.
    authorizeRequest: async () => ({ ok: true }) });
  registerDaemonMachineAgentIsolationRpcHandlers(rpc, {
    target: () => ({ serverId: 'home', machineId: machine.id, installationId: 'guest-installation', custodianAccountId: 'account' }),
    read: () => readAgentIsolationSnapshot({ metadata: readOpenedMachineMetadataSnapshot(machine, true),
      daemonState: machine.daemonState, runtimeId: 'daemon', platform: 'linux' }),
    captureMetadataPort: () => port, effects: native.effects,
    runActionOperation: createHostActionOperationRuntime({ serverId: 'home', machineId: machine.id,
      resolveAccountId: async () => 'account' }).runActionOperation,
  });
  let requestIndex = 0;
  const invoke = (actionId: 'machines.agentIsolation.preview' | 'machines.agentIsolation.set', params: unknown) => rpc.handleRequest({
    method: `${machine.id}:${actionId}`, params, requestId: `retry-${actionId}-${++requestIndex}`, callerAuthority: 'present_user',
    callerInputAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-child', binding: {
      serverIdentityId: 'home', accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', machineId: machine.id, installationId: 'guest-installation', actionId, requestId: 'retry',
      requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: machine.id },
      managedContinuation: { managedId: 'managed', creationRequestId: 'creation', expectedIntentRevision: 0,
        controller: { machineId: 'controller', installationId: 'controller-installation' }, acquireRequestEnvelopeDigest: 'a'.repeat(43) },
    } }), machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: machine.id,
      installationId: 'guest-installation', role: 'manage', encryptionMode: 'plain' },
  });
  // Check now, acquire replay and Retry install share this completion owner.
  const complete = () => applyManagedMachineEnrollmentIsolation({ target: { serverId: 'home', machineId: machine.id },
    policy: { enabled: true, memberProvisioning: 'linuxUsersV1' }, dispatch: request => invoke(request.actionId, request.input) });
  await complete();
  expect(machine.metadata?.agentIsolation).toEqual({ enabled: true, memberProvisioning: 'linuxUsersV1' });
  expect(publications).toBe(1);
  expect(native.mutations.length).toBeGreaterThan(0);
  expect(native.boundaryFailures).toEqual([]);
  // The person changes the policy after creation; other members then start
  // Sessions. Publishing applying here would request their replacement.
  machine.metadata = { ...machine.metadata!, agentIsolation: laterPolicy };
  machine.metadataVersion++;
  const laterStatus = laterPolicy.enabled ? { kind: 'effective' as const } : { kind: 'disabled' as const };
  machine.daemonState = { ...machine.daemonState!, agentIsolation: laterStatus };
  runningSessions.add('member-a-session'); runningSessions.add('member-b-session');
  const beforeRecovery = { metadataVersion: machine.metadataVersion, mutations: native.mutations.length };
  await expect(complete()).resolves.toBeUndefined();
  expect(machine.metadata?.agentIsolation).toEqual(laterPolicy);
  expect(machine.metadataVersion).toBe(beforeRecovery.metadataVersion);
  expect(machine.daemonState?.agentIsolation).toEqual(laterStatus);
  expect(publications).toBe(1);
  expect(native.mutations).toHaveLength(beforeRecovery.mutations);
  expect([...runningSessions]).toEqual(['member-a-session', 'member-b-session']);
  expect(native.boundaryFailures).toEqual([]);
});
