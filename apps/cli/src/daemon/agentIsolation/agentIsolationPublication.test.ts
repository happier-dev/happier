import { expect, it } from 'vitest';
import { MachineAgentIsolationPreviewResultV1Schema, type MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import { MachineUpdateMetadataRequestSchema, MachineUpdateStateRequestSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import { ApiMachineClient } from '@/api/apiMachine';
import type { Machine } from '@/api/types';
import type { RpcHandlerContext, RpcHandlerMap } from '@/api/rpc/types';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { createMachineAdminAccessObserver } from '@/machines/adminAccess/observeMachineAdminAccess';
import { createDaemonAgentIsolationEffects } from './createDaemonAgentIsolationEffects';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import { createOnChildExited } from '@/daemon/sessions/onChildExited';
import type { TrackedSession } from '@/daemon/types';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

it.skipIf(process.platform !== 'linux')('settles admitted Off on final physical runner retirement without a second Apply or Session read', async () => {
  const machine: Machine = { id: 'off-retirement', encryptionMode: 'plain', metadataVersion: 1, daemonStateVersion: 1,
    metadata: { host: 'fixture', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/happier',
      happyHomeDir: '/home/happier/.happier', agentIsolation: { enabled: true } },
    daemonState: { status: 'running', runtimeId: 'daemon', agentIsolation: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } } };
  let stateWrites = 0, sessionReads = 0;
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
    if (event === 'machine-update-metadata') {
      const write = MachineUpdateMetadataRequestSchema.parse(payload);
      return { result: 'success', version: write.expectedVersion + 1, metadata: write.metadata };
    }
    if (event !== 'machine-update-state') throw new Error(`Unexpected retirement publication: ${event}`);
    const write = MachineUpdateStateRequestSchema.parse(payload);
    stateWrites++;
    return { result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState };
  } });
  const client = new ApiMachineClient('token', machine, { runtimeId: 'daemon' });
  Reflect.set(client, 'socket', socket);
  const trackedSessions = new Map<SessionTrackingKey, TrackedSession>([[legacyPidSessionTrackingKey(456789), { trackingKey: legacyPidSessionTrackingKey(456789), pid: 456789, startedBy: 'daemon' }]]);
  const sessionChanges = createSessionLiveWorkProducer({ readSessions: () => [...trackedSessions.values()],
    readActivity: async () => { sessionReads++; return { session: 'unknown', input: 'unknown' }; } });
  const target = { serverId: 'home', machineId: machine.id, installationId: 'installation', custodianAccountId: 'account' };
  const productionInput = { getMachineClient: () => client,
    adminAccess: { target: () => target, observer: createMachineAdminAccessObserver({ onChanged: async () => {} }) },
    readRoots: () => [], trackedSessions, protectedRoots: [], privateRoots: [], sessionChanges };
  const production = createDaemonAgentIsolationEffects(productionInput);
  const native = createAgentIsolationEffectsBoundary({ installationId: target.installationId,
    installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: production.readSessionsToReplace,
    publishStatus: production.publishStatus });
  const handlers: RpcHandlerMap = new Map();
  registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
    target: () => target, readCanonicalHomeServerIdentityId: () => 'home',
    read: () => client.getAgentIsolationSnapshot(), effects: native.effects,
    runActionOperation: createHostActionOperationRuntime({ serverId: 'home', machineId: machine.id,
      resolveAccountId: async () => 'account' }).runActionOperation,
    captureMetadataPort: () => ({ read: () => client.getMachineMetadataSnapshot(),
      compareAndSwap: input => client.compareAndSwapMachineMetadata(input) }),
  });
  const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user', transportRequestId: 'off',
    machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: machine.id,
      installationId: target.installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
  try {
    const review = MachineAgentIsolationPreviewResultV1Schema.parse(await handlers.get('machines.agentIsolation.preview')!(
      { machineId: machine.id, enabled: false }, context));
    if (review.kind !== 'ready') throw new Error('Expected reviewed Off');
    await expect(handlers.get('machines.agentIsolation.set')!({ machineId: machine.id, enabled: false,
      expectedPolicy: review.policy, expectedMetadataVersion: review.metadataVersion, expectedPlanDigest: review.plan.planDigest }, context))
      .resolves.toMatchObject({ kind: 'accepted', status: { kind: 'applying', phase: 'runtime_replacement' } });
    const writesAfterApply = stateWrites;
    sessionChanges.notifyChanged();
    await client.updateDaemonState(state => state!); // Flush the existing publication drain.
    expect(stateWrites).toBe(writesAfterApply);
    const retire = createOnChildExited({ trackedSessionsByKey: trackedSessions, spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null,
      // Marker deletion is the filesystem boundary; physical retirement remains real.
      removeSessionMarkerIfOwnedFn: async () => true });
    await retire(456789, { reason: 'process-exited', code: 0, signal: null });
    expect(trackedSessions.size).toBe(0);
    sessionChanges.notifyChanged(); // Same event as the daemon's onChildExited wrapper.
    await client.updateDaemonState(state => state!);
    expect(client.getAgentIsolationSnapshot()).toMatchObject({ enabled: false, status: { kind: 'disabled' } });
    await expect(handlers.get('machines.agentIsolation.status')!({ machineId: machine.id }, context))
      .resolves.toMatchObject({ status: { kind: 'disabled' } });
    expect(stateWrites).toBe(writesAfterApply + 1);
    for (let index = 0; index < 8; index++) sessionChanges.notifyChanged();
    await client.updateDaemonState(state => state!);
    expect(stateWrites).toBe(writesAfterApply + 1);
    expect(sessionReads).toBe(0);
    // A late retirement notification cannot overwrite the next enabled policy.
    machine.metadata = { ...machine.metadata!, agentIsolation: { enabled: true } };
    await production.publishStatus({ kind: 'applying', phase: 'runtime_replacement' });
    const enabledWrites = stateWrites;
    sessionChanges.notifyChanged();
    await client.updateDaemonState(state => state!);
    expect(client.getAgentIsolationSnapshot()).toMatchObject({ enabled: true, status: { kind: 'applying', phase: 'runtime_replacement' } });
    expect(stateWrites).toBe(enabledWrites);
    expect(native.mutations).toEqual([]);
  } finally { await client.shutdown(); }
});

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

it.skipIf(process.platform !== 'linux')('settles a cancelled admitted apply instead of retaining its applying publication', async () => {
  const controller = new AbortController();
  let enabled = false, metadataVersion = 1;
  let status: MachineAgentIsolationStatusV1 = { kind: 'disabled' };
  const native = createAgentIsolationEffectsBoundary({ installationId: 'installation', installedCli: '/opt/happier/cli/current/happier',
    readRoots: () => [], readSessionsToReplace: () => 0, publishStatus: async value => {
      status = value;
      // The requester leaves after observing its own desired-policy publication.
      if (value.kind === 'applying') controller.abort(new Error('RPC request cancelled by caller'));
    } });
  const target = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
  const handlers: RpcHandlerMap = new Map();
  registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
    target: () => target, read: () => ({ enabled, status }), effects: native.effects,
    runActionOperation: createHostActionOperationRuntime({ serverId: target.serverId, machineId: target.machineId,
      resolveAccountId: async () => target.custodianAccountId }).runActionOperation,
    captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadataVersion, metadata: { agentIsolation: { enabled } } }),
      compareAndSwap: async () => { enabled = true; metadataVersion++; return { status: 'applied', metadataVersion,
        metadata: { agentIsolation: { enabled } } }; } }),
  });
  const context: RpcHandlerContext = { signal: controller.signal, callerAuthority: 'present_user', transportRequestId: 'setup',
    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation',
      role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => !controller.signal.aborted };
  const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await handlers.get('machines.agentIsolation.preview')!({
    machineId: 'machine', enabled: true }, context));
  if (preview.kind !== 'ready') throw new Error('Expected reviewed setup');
  const result = await handlers.get('machines.agentIsolation.set')!({ machineId: 'machine', enabled: true,
    expectedPolicy: preview.policy, expectedMetadataVersion: preview.metadataVersion, expectedPlanDigest: preview.plan.planDigest }, context);
  expect(result).toMatchObject({ kind: 'failed', code: 'cancelled' });
  expect(status).toEqual({ kind: 'unavailable', code: 'provisioning_unavailable' });
  expect(native.mutations).toEqual([]);
});

it.skipIf(process.platform !== 'linux').each([1, 2])('settles isolation publication rejection %s without retrying the failed write', async failAt => {
  const machine: Machine = { id: 'isolation-publication', encryptionMode: 'plain', metadataVersion: 1, daemonStateVersion: 1,
    metadata: { host: 'fixture', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/happier',
      happyHomeDir: '/home/happier/.happier', agentIsolation: { enabled: false } },
    daemonState: { status: 'running', runtimeId: 'daemon', agentIsolation: { kind: 'disabled' } } };
  let statusWrites = 0;
  let rejectWrites = true;
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
    if (event === 'machine-update-metadata') {
      const write = MachineUpdateMetadataRequestSchema.parse(payload);
      return { result: 'success', version: write.expectedVersion + 1, metadata: write.metadata };
    }
    if (event !== 'machine-update-state') throw new Error(`Unexpected publication: ${event}`);
    const write = MachineUpdateStateRequestSchema.parse(payload);
    if (++statusWrites >= failAt && rejectWrites) return { result: 'error', message: 'database_transaction_timeout' };
    return { result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState };
  } });
  const client = new ApiMachineClient('token', machine, { runtimeId: 'daemon' });
  Reflect.set(client, 'socket', socket);
  const target = { serverId: 'home', machineId: machine.id, installationId: 'installation', custodianAccountId: 'account' };
  const production = createDaemonAgentIsolationEffects({ getMachineClient: () => client,
    adminAccess: { target: () => target, observer: createMachineAdminAccessObserver({ onChanged: async () => {} }) },
    readRoots: () => [], trackedSessions: new Map(), protectedRoots: [], privateRoots: [] });
  const native = createAgentIsolationEffectsBoundary({ installationId: target.installationId,
    installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 3,
    publishStatus: production.publishStatus });
  const handlers: RpcHandlerMap = new Map();
  registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
    target: () => target, read: () => client.getAgentIsolationSnapshot(), effects: native.effects,
    runActionOperation: request => client.runActionOperation(request),
    captureMetadataPort: () => ({ read: () => client.getMachineMetadataSnapshot(),
      compareAndSwap: input => client.compareAndSwapMachineMetadata(input) }),
  });
  const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user', transportRequestId: 'operation',
    machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: machine.id,
      installationId: target.installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
  try {
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await handlers.get('machines.agentIsolation.preview')!(
      { machineId: machine.id, enabled: true }, context));
    expect(preview.kind).toBe('ready');
    if (preview.kind !== 'ready') throw new Error('Expected a reviewed isolation plan');
    const failure = await handlers.get('machines.agentIsolation.set')!({ machineId: machine.id, enabled: true,
      expectedPolicy: preview.policy, expectedMetadataVersion: preview.metadataVersion, expectedPlanDigest: preview.plan.planDigest }, context)
      .catch((error: unknown) => error);
    expect(client.getAgentIsolationSnapshot()).toMatchObject({ enabled: true,
      status: { kind: 'unavailable', code: 'provisioning_unavailable' } });
    expect(failure).toMatchObject({ message: 'Machine daemon-state update failed: database_transaction_timeout' });
    expect(statusWrites).toBe(failAt);
    // A later admitted publication clears the held failure, using the unchanged
    // server version rather than treating the failed write as acknowledged.
    expect(machine.daemonStateVersion).toBe(failAt);
    rejectWrites = false;
    await production.publishStatus({ kind: 'applying', phase: 'runtime_replacement' });
    expect(client.getAgentIsolationSnapshot().status).toEqual({ kind: 'applying', phase: 'runtime_replacement' });
    expect(machine.daemonStateVersion).toBe(failAt + 1);
  } finally { await client.shutdown(); }
});
