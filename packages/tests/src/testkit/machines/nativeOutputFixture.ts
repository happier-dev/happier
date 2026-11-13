import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { listMachineVitalsSummariesV1 } from '@happier-dev/protocol/machines/vitals/listMachineVitalsSummariesV1';
import { RpcHandlerManager } from '../../../../../apps/cli/src/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '../../../../../apps/cli/src/api/machine/machineRpcAuthorization';
import { registerDaemonMachineVitalsRpcHandlers } from '../../../../../apps/cli/src/rpc/handlers/daemonMachineVitals';
import { registerDaemonMachineRolesRpcHandlers } from '../../../../../apps/cli/src/rpc/handlers/daemonMachineRoles';
import { registerDaemonMachineResourcesPolicyRpcHandlers } from '../../../../../apps/cli/src/rpc/handlers/daemonMachineResourcesPolicy';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '../../../../../apps/cli/src/rpc/handlers/daemonMachineAgentIsolation';
import { registerDaemonScheduledRpcHandlers } from '../../../../../apps/cli/src/rpc/handlers/daemonScheduled';
import { createScheduledObservation } from '../../../../../apps/cli/src/daemon/scheduled/observation';
import { createMachineVitalsSampler } from '../../../../../apps/cli/src/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../../../../../apps/cli/src/daemon/vitals/history/minuteHistoryStore';
import { createLinuxVitalsFixture } from '../../../../../apps/cli/src/daemon/vitals/readers/linux.testkit';
import { createLinuxMachineVitalsReader } from '../../../../../apps/cli/src/daemon/vitals/readers/linux';
import { createMachineRolesRuntime } from '../../../../../apps/cli/src/daemon/roles/machineRolesRuntime';
import { createStoragePolicyFixture } from '../../../../../apps/cli/src/storage/storagePolicy.testkit';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';

export const nativeOutputTarget = { serverId: 'srv_0123456789abcdef0123456789abcdef', machineId: 'output-native-machine',
  installationId: 'output-native-installation', custodianAccountId: 'output-native-owner' };
const target = nativeOutputTarget;
const inputTarget = { serverId: target.serverId, machineId: target.machineId };
export type NativeOutputFixture = Awaited<ReturnType<typeof createNativeOutputFixture>>;

/** Real receiving owners. Only Home admission, metadata transport and native OS
 * observations are substituted; no Action, RPC or domain result is supplied. */
export function createNativeOutputRpcManager() {
  return new RpcHandlerManager({ scopePrefix: target.machineId, localMachineId: target.machineId,
    encryptionMode: 'plain', logger() {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
      machineId: target.machineId, resolveCustodianAccountId: async () => target.custodianAccountId,
      resolveHomeServerIdentityId: async () => target.serverId,
      resolveInstallationId: () => target.installationId,
      // The authenticated Home transport is the boundary; local route policy,
      // requester binding, receiving dispatch and output producers remain real.
      verifyMachineAdmission: async () => true,
    }) });
}

export function invokeNativeOutput(manager: RpcHandlerManager, actionId: ActionId, input: unknown): Promise<unknown> {
  return manager.handleRequest({
    method: `${target.machineId}:${getActionSpec(actionId).bindings?.rpcMethod ?? actionId}`,
    params: input, requestId: randomUUID(), callerAuthority: 'present_user',
    machineAdmission: { machineId: target.machineId, installationId: target.installationId,
      custodianAccountId: target.custodianAccountId, actorAccountId: target.custodianAccountId,
      role: 'manage', encryptionMode: 'plain' },
  });
}

export async function createNativeOutputFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'machines-output-native-'));
  const cleanup: (() => void | Promise<void>)[] = [() => rm(directory, { recursive: true, force: true })];
  const manager = createNativeOutputRpcManager();
  try {
    const native = await createLinuxVitalsFixture(); cleanup.push(native.cleanup);
    const sampler = createMachineVitalsSampler({ readers: createLinuxMachineVitalsReader({ root: native.root }),
      historyStore: await createMinuteHistoryStore({ directory: join(directory, 'history') }) });
    cleanup.push(() => sampler.stop()); await sampler.start();
    registerDaemonMachineVitalsRpcHandlers(manager, { sampler, target: () => target });

    const resources = await createStoragePolicyFixture(); cleanup.push(() => resources.stop());
    registerDaemonMachineResourcesPolicyRpcHandlers(manager, { policy: resources, target: () => target });
    let metadata: Record<string, unknown> = { rolesV1: { active: [] } };
    let metadataVersion = 1;
    const port: MachineMetadataFieldPortV1 = {
      read: async () => ({ status: 'ready', metadata, metadataVersion }),
      compareAndSwap: async request => {
        if (request.expectedMetadataVersion !== metadataVersion) return { status: 'conflict', metadata, metadataVersion };
        metadata = request.metadata; metadataVersion++;
        return { status: 'applied', metadata, metadataVersion };
      },
    };
    const roles = createMachineRolesRuntime({ port }); cleanup.push(() => roles.stop()); await roles.reload();
    registerDaemonMachineRolesRpcHandlers(manager, { roles, target: () => target });
    registerDaemonMachineAgentIsolationRpcHandlers(manager, { target: () => target,
      readCanonicalHomeServerIdentityId: () => target.serverId,
      read: () => ({ enabled: false, status: { kind: 'disabled' } }) });

    const scheduled = createScheduledObservation({ read: async () => [{ source: 'fixture-native-scheduler',
      kind: 'available', jobs: [] }], subscribe: () => () => {} });
    cleanup.push(() => scheduled.dispose());
    registerDaemonScheduledRpcHandlers(manager, { machineId: target.machineId,
      accountId: target.custodianAccountId, observation: scheduled });

    const invoke = (actionId: ActionId, input: unknown) => invokeNativeOutput(manager, actionId, input);
    return { target: inputTarget, resources, roles, invoke,
      summaries: () => listMachineVitalsSummariesV1({ machines: [{ machineId: target.machineId,
        name: 'Native contract fixture', online: true, resources: { vitals: { state: 'reporting' },
          ...(sampler.host() ? { host: sampler.host()! } : {}) } }],
        readSummary: () => invoke('machines.vitals.get', inputTarget) }),
      close: async () => { for (const release of cleanup.splice(0).reverse()) await release(); },
    };
  } catch (error) { for (const release of cleanup.splice(0).reverse()) await release(); throw error; }
}

type NativeCase = Readonly<{ input(fixture: NativeOutputFixture): unknown | Promise<unknown>;
  execute?(fixture: NativeOutputFixture, input: unknown): Promise<unknown> }>;
export const nativeOutputCases = new Map<ActionId, NativeCase>([
  ['machines.vitals.get', { input: f => ({ ...f.target, view: 'overview' }) }],
  ['machines.vitals.history.get', { input: f => ({ ...f.target, range: '1h' }) }],
  ['machines.vitals.summaries.list', { input: f => ({ serverId: f.target.serverId }), execute: f => f.summaries() }],
  ['machines.resources.policy.set', { input: f => {
    const current = f.resources.read();
    if (current.status !== 'ready') throw new Error('Fixture metadata policy unavailable');
    return { ...f.target, expectedRevision: current.revision, patch: { processes: { allProcessesVisible: false } } };
  } }],
  ['machines.roles.set', { input: f => ({ ...f.target, expectedPolicy: { active: [] },
    expectedMetadataVersion: 1, policy: { active: [] } }) }],
  ['machines.agentIsolation.status', { input: f => f.target }],
  // A Machine without configured isolation effects settles inside the real
  // domain owner; this is its declared terminal outcome, after RPC admission.
  ['machines.agentIsolation.preview', { input: f => ({ ...f.target, enabled: true }) }],
  ['machines.agentIsolation.set', { input: f => ({ ...f.target, enabled: true, expectedPolicy: { enabled: false },
    expectedMetadataVersion: 1, expectedPlanDigest: 'not-configured-native-effects' }) }],
  ['machines.scheduled.list', { input: f => ({ ...f.target, pageSize: 10 }) }],
  ['machines.scheduled.watch', { input: f => ({ ...f.target, pageSize: 10, sinceRevision: 0 }) }],
]);
