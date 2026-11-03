import { expect, it } from 'vitest';
import { MachineAgentIsolationPreviewResultV1Schema } from '@happier-dev/protocol';
import { MachineUpdateStateRequestSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import { ApiMachineClient } from '@/api/apiMachine';
import type { Machine } from '@/api/types';
import type { RpcHandlerContext, RpcHandlerMap } from '@/api/rpc/types';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { createMachineAdminAccessObserver } from '@/machines/adminAccess/observeMachineAdminAccess';
import { createDaemonAgentIsolationEffects } from './createDaemonAgentIsolationEffects';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';

it.skipIf(process.platform !== 'linux').each(['required_fact_unavailable', 'PRIVATE_NATIVE_DETAIL'])('publishes an unavailable preview with its native reason through the Machine state owner (%s)', async reason => {
  const machine: Machine = { id: 'isolation-refusal', encryptionMode: 'plain', metadataVersion: 1, daemonStateVersion: 1,
    metadata: { host: 'fixture', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/happier',
      happyHomeDir: '/home/happier/.happier' }, daemonState: { status: 'running', runtimeId: 'daemon' } };
  let statusWrites = 0;
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
    if (event !== 'machine-update-state') throw new Error(`Preview must not mutate metadata: ${event}`);
    const write = MachineUpdateStateRequestSchema.parse(payload);
    statusWrites++;
    return { result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState };
  } });
  const client = new ApiMachineClient('token', machine, { runtimeId: 'daemon' });
  Reflect.set(client, 'socket', socket);
  const target = { serverId: 'home', machineId: machine.id, installationId: 'installation', custodianAccountId: 'account' };
  const publication = createDaemonAgentIsolationEffects({ getMachineClient: () => client,
    adminAccess: { target: () => target, observer: createMachineAdminAccessObserver({ onChanged: async () => {} }) },
    readRoots: () => [], trackedSessions: new Map(), protectedRoots: [], privateRoots: [] });
  const native = createAgentIsolationEffectsBoundary({ installationId: target.installationId,
    installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
    publishStatus: publication.publishStatus, backend: {
      observe: async step => ({ stepId: step.id, status: 'unavailable', facts: {}, reason }),
      apply: async () => { throw new Error('Unavailable preview must not apply native changes'); },
    } });
  const handlers: RpcHandlerMap = new Map();
  registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
    target: () => target, read: () => client.getAgentIsolationSnapshot(), effects: native.effects,
    captureMetadataPort: () => ({ read: async () => client.getMachineMetadataSnapshot(),
      compareAndSwap: async () => { throw new Error('Preview must not change desired isolation'); } }),
  });
  const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user', transportRequestId: 'preview',
    machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: machine.id,
      installationId: target.installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
  try {
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await handlers.get('machines.agentIsolation.preview')!(
      { machineId: machine.id, enabled: true }, context));
    const failure = { kind: 'native_check_unavailable', ...(reason === 'required_fact_unavailable' ? { reason } : {}) };
    expect(preview).toMatchObject({ kind: 'unavailable', setup: { reasonCode: 'native_check_unavailable', failure } });
    expect(client.getAgentIsolationSnapshot().status).toEqual({ kind: 'unavailable', code: 'provisioning_unavailable',
      setup: { outcome: 'not_applied', reasonCode: 'native_check_unavailable',
        failure } });
    expect(JSON.stringify(preview)).not.toContain('PRIVATE_NATIVE_DETAIL');
    expect(statusWrites).toBe(1); // One settled fact, no publication or provisioning retry.
    expect(native.mutations).toEqual([]);
    expect(machine.metadata).not.toHaveProperty('agentIsolation');
  } finally { await client.shutdown(); }
});
