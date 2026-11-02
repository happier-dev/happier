import { expect, it } from 'vitest';
import { MachineAgentIsolationPreviewResultV1Schema, MachineAgentIsolationSetResultV1Schema } from '@happier-dev/protocol';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { registerActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { createAgentIsolationEffectsBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { registerDaemonMachineAgentIsolationRpcHandlers } from './daemonMachineAgentIsolation';

it.each(['rpc', 'owned'] as const)('retains a readable current isolation review through %s ingress', async ingress => {
  const target = { serverId: 'home', machineId: 'guest', installationId: 'installation', custodianAccountId: 'owner' };
  const operations = createHostActionOperationRuntime({ serverId: target.serverId, machineId: target.machineId,
    resolveAccountId: async () => target.custodianAccountId, generateOperationId: () => 'isolation-review' });
  const native = createAgentIsolationEffectsBoundary({ installationId: target.installationId,
    installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
    publishStatus: async () => { throw new Error('A stale review must not publish isolation status'); } });
  const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
    transportRequestId: 'rpc_transport-request',
    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: target.machineId,
      installationId: target.installationId, role: 'manage', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true };
  const rpc = new RpcHandlerManager({ scopePrefix: target.machineId, localMachineId: target.machineId,
    encryptionMode: 'plain', logger() {}, authorizeRequest: async () => ({ ok: true }) });
  // Extra route ports are deliberately supplied via a variable: before the fix
  // registration ignores the real runtime, so RED is a missing receipt, not a type error.
  const routes = { target: () => target, read: () => ({ enabled: false, status: { kind: 'disabled' as const } }),
    readCanonicalHomeServerIdentityId: () => target.serverId, effects: native.effects,
    runActionOperation: operations.runActionOperation,
    captureMetadataPort: () => ({ read: async () => ({ status: 'ready' as const,
      metadata: { agentIsolation: { enabled: false } }, metadataVersion: 5 }),
      compareAndSwap: async () => { throw new Error('A stale review must not write metadata'); } }) };
  registerDaemonMachineAgentIsolationRpcHandlers(rpc, routes);
  registerActionOperationRpcHandlers(rpc, operations.handlers);
  const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await rpc.invokeLocal('machines.agentIsolation.preview',
    { machineId: target.machineId, enabled: true }, { rpcContext: context }));
  if (preview.kind !== 'ready') throw new Error('Expected reviewable native effects');
  const input = { machineId: target.machineId, enabled: true, expectedPolicy: preview.policy,
    expectedMetadataVersion: preview.metadataVersion, expectedPlanDigest: 'stale-digest' };
  const invoke = async (localActionContext?: RpcHandlerContext['localActionContext']) =>
    rpc.invokeLocal('machines.agentIsolation.set', input, { rpcContext: context,
      localActionContext: { actionRequestId: context.transportRequestId, ...localActionContext } });
  const result = ingress === 'rpc' ? await invoke() : await operations.runActionOperation({
    actionId: 'machines.agentIsolation.set', input, context: { ...context, surface: 'rpc', serverId: target.serverId,
      actionRequestId: 'owned-request' }, execute: async owned => ({ ok: true, result: await invoke(owned) }),
  }).then(execution => { if (!execution.ok) throw new Error(execution.errorCode); return execution.result; });
  const changed = MachineAgentIsolationSetResultV1Schema.parse(result);
  expect(changed).toMatchObject({ kind: 'plan_changed', current: preview });
  if (changed.kind !== 'plan_changed' || !changed.operationId) throw new Error('Changed review must name its retained receipt');
  const found = await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: changed.operationId }, { rpcContext: context });
  expect(found).toMatchObject({ kind: 'found', operation: { operationId: changed.operationId, state: 'running',
    observation: { kind: 'review_required', machineId: target.machineId, enabled: true, current: preview } } });
  expect(await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.list, { states: ['running'] }, { rpcContext: context }))
    .toMatchObject({ items: [{ operationId: changed.operationId }] });
  expect(native.launches).toEqual([]);
  expect(native.mutations).toEqual([]);
});
