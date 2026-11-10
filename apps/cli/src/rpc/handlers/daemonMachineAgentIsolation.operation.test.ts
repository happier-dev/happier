import { expect, it } from 'vitest';
import { MachineAgentIsolationPreviewResultV1Schema, MachineAgentIsolationSetResultV1Schema,
  readMachineAgentIsolationPolicyV1, type MachineAgentIsolationPolicyV1, type MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { registerActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { createAgentIsolationEffectsBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { registerDaemonMachineAgentIsolationRpcHandlers } from './daemonMachineAgentIsolation';
import { createMachineSetupNativeBackend } from '@happier-dev/cli-common/machineSetup';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readActionOperationTerminalResultV1, projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
import { ActionOperationSnapshotV1Schema as PredecessorSnapshotSchema } from '@/daemon/actionOperations/testFixtures/predecessorActionOperationV1';

it.skipIf(process.platform !== 'linux')('retains a missing ACL tool repair through elevated APPLY, Machine status and the operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-isolation-apply-acl-'));
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    const target = { serverId: 'home', machineId: 'guest', installationId: 'installation', custodianAccountId: 'owner' };
    let policy: MachineAgentIsolationPolicyV1 = { enabled: false };
    let status: MachineAgentIsolationStatusV1 = { kind: 'disabled' }, metadataVersion = 1;
    const native = createMachineSetupNativeBackend({ run: async ({ executable }) => {
      if (executable === 'getent') return { code: 0, stdout: 'happier-agent:x:41001:41000::/home/agent:/usr/sbin/nologin\n', stderr: '' };
      if (executable === 'getfacl') return { code: 0, stdout: 'user::rwx\ngroup::---\nother::---\n', stderr: '' };
      if (executable === 'setfacl') return { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
      throw new Error(`Unexpected native command ${executable}`);
    } });
    const os = createAgentIsolationEffectsBoundary({ installationId: target.installationId,
      installedCli: '/opt/happier/current/happier', readRoots: () => [{ rootId: 'workspace', path: workspace }],
      readSessionsToReplace: () => 0, publishStatus: async value => { status = value; } });
    const boundary = createAgentIsolationEffectsBoundary({ ...os.effects, installationId: target.installationId,
      backend: { observe: step => step.kind === 'pathTraversal' ? native.observe(step) : os.effects.backend!.observe(step),
        apply: step => step.kind === 'pathTraversal' ? native.apply(step) : os.effects.backend!.apply(step) } });
    const operations = createHostActionOperationRuntime({ serverId: target.serverId, machineId: target.machineId,
      resolveAccountId: async () => target.custodianAccountId });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      transportRequestId: 'missing-acl-apply', machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner',
        machineId: target.machineId, installationId: target.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    const rpc = new RpcHandlerManager({ scopePrefix: target.machineId, localMachineId: target.machineId,
      encryptionMode: 'plain', logger() {}, authorizeRequest: async () => ({ ok: true }) });
    registerDaemonMachineAgentIsolationRpcHandlers(rpc, { target: () => target, read: () => ({ ...policy, status }),
      effects: { ...boundary.effects, backend: undefined }, runActionOperation: operations.runActionOperation,
      captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadataVersion, metadata: { agentIsolation: policy } }),
        compareAndSwap: async input => {
          const parsed = readMachineAgentIsolationPolicyV1(input.metadata);
          if (parsed.status !== 'ready') throw new Error('Expected policy');
          policy = parsed.policy; metadataVersion++;
          return { status: 'applied', metadataVersion, metadata: input.metadata };
        } }) });
    const desired = { machineId: target.machineId, enabled: true, memberProvisioning: 'linuxUsersV1' } as const;
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await rpc.invokeLocal('machines.agentIsolation.preview', desired,
      { rpcContext: context, localActionContext: { actionRequestId: 'missing-acl-preview' } }));
    if (preview.kind !== 'ready') throw new Error(`The readable ACL must permit review: ${JSON.stringify(preview)}; native boundary: ${boundary.boundaryFailures.map(String).join(', ')}`);
    const input = { ...desired, expectedMetadataVersion: preview.metadataVersion,
      expectedPolicy: preview.policy, expectedPlanDigest: preview.plan.planDigest };
    const invoke = async () => MachineAgentIsolationSetResultV1Schema.parse(await rpc.invokeLocal('machines.agentIsolation.set', input,
      { rpcContext: context, localActionContext: { actionRequestId: 'missing-acl-apply' } }));
    const result = await invoke();
    expect(result.kind).toBe('failed');
    const failure = { kind: 'native_effect_failed', reason: 'required_fact_unavailable', requiredFact: 'commandExecutable',
      remedy: 'Install the acl package on this Machine, then try again.' };
    expect(result).toMatchObject({ kind: 'failed', setup: { outcome: 'not_applied', reasonCode: 'native_effect_failed', failure } });
    expect(status).toMatchObject({ kind: 'unavailable', setup: { outcome: 'not_applied', reasonCode: 'native_effect_failed', failure } });
    if (result.kind !== 'failed' || !result.operationId) throw new Error('Expected owned failure');
    const operation = operations.store.get({ accountId: 'owner', machineId: 'guest' }, result.operationId);
    expect(operation).toMatchObject({
      state: 'failed', error: { errorCode: 'native_effect_failed', details: { kind: 'machineSetup', failure } } });
    if (!operation) throw new Error('Expected retained operation');
    expect(readActionOperationTerminalResultV1(operation)).toMatchObject({ ok: true, result });
    expect(PredecessorSnapshotSchema.safeParse(projectActionOperationSnapshotForV1Reader(operation)).success).toBe(true);
    const launches = boundary.launches.length;
    expect(await invoke()).toEqual(result);
    expect(boundary.launches).toHaveLength(launches);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves a reviewed member policy across its desired publication and elevated APPLY', async () => {
  const target = { serverId: 'home', machineId: 'guest', installationId: 'installation', custodianAccountId: 'owner' };
  let policy: MachineAgentIsolationPolicyV1 = { enabled: false };
  let status: MachineAgentIsolationStatusV1 = { kind: 'disabled' };
  let metadataVersion = 1, publications = 0;
  const native = createAgentIsolationEffectsBoundary({ installationId: target.installationId,
    installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
    publishStatus: async value => { status = value; } });
  const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
    transportRequestId: 'member-apply', machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner',
      machineId: target.machineId, installationId: target.installationId, role: 'manage', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true };
  const rpc = new RpcHandlerManager({ scopePrefix: target.machineId, localMachineId: target.machineId,
    encryptionMode: 'plain', logger() {}, authorizeRequest: async () => ({ ok: true }) });
  registerDaemonMachineAgentIsolationRpcHandlers(rpc, { target: () => target,
    read: () => ({ ...policy, status }), effects: { ...native.effects, backend: undefined },
    runActionOperation: createHostActionOperationRuntime({ serverId: target.serverId, machineId: target.machineId,
      resolveAccountId: async () => target.custodianAccountId }).runActionOperation,
    captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadataVersion, metadata: { agentIsolation: policy } }),
      compareAndSwap: async input => {
        const parsed = readMachineAgentIsolationPolicyV1(input.metadata);
        if (parsed.status !== 'ready') throw new Error('Expected admitted policy');
        policy = parsed.policy; metadataVersion++; publications++;
        return { status: 'applied', metadataVersion, metadata: input.metadata };
      } }) });
  const desired = { machineId: target.machineId, enabled: true, memberProvisioning: 'linuxUsersV1' } as const;
  const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await rpc.invokeLocal('machines.agentIsolation.preview',
    desired, { rpcContext: context, localActionContext: { actionRequestId: 'member-preview' } }));
  if (preview.kind !== 'ready') throw new Error('Expected review');
  const applied = await rpc.invokeLocal('machines.agentIsolation.set', { ...desired,
    expectedMetadataVersion: preview.metadataVersion, expectedPolicy: preview.policy, expectedPlanDigest: preview.plan.planDigest },
  { rpcContext: context, localActionContext: { actionRequestId: 'member-apply' } });
  expect(applied).toMatchObject({ kind: 'accepted', status: { kind: 'applying', phase: 'runtime_replacement' } });
  expect(publications).toBe(1);
  expect(native.mutations.length).toBeGreaterThan(0);
});

it('refuses a changed reviewed policy before direct RPC effects', async () => {
  const target = { serverId: 'home', machineId: 'guest', installationId: 'installation', custodianAccountId: 'owner' };
  const native = createAgentIsolationEffectsBoundary({ installationId: target.installationId,
    installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
    publishStatus: async () => { throw new Error('Stale admission must not publish'); } });
  const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
    transportRequestId: 'stale-review', machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner',
      machineId: target.machineId, installationId: target.installationId, role: 'manage', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true };
  const rpc = new RpcHandlerManager({ scopePrefix: target.machineId, localMachineId: target.machineId,
    encryptionMode: 'plain', logger() {}, authorizeRequest: async () => ({ ok: true }) });
  registerDaemonMachineAgentIsolationRpcHandlers(rpc, { target: () => target,
    read: () => ({ enabled: false, status: { kind: 'disabled' } }), effects: native.effects,
    captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadataVersion: 17,
      metadata: { agentIsolation: { enabled: false } } }),
      compareAndSwap: async () => { throw new Error('Stale admission must not write'); } }) });
  const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await rpc.invokeLocal('machines.agentIsolation.preview',
    { machineId: target.machineId, enabled: true }, { rpcContext: context }));
  if (preview.kind !== 'ready') throw new Error('Expected review');
  expect(await rpc.invokeLocal('machines.agentIsolation.set', { machineId: target.machineId, enabled: true,
    expectedMetadataVersion: 16, expectedPolicy: { enabled: true, memberProvisioning: 'linuxUsersV1' },
    expectedPlanDigest: preview.plan.planDigest }, { rpcContext: context }))
    .toEqual({ kind: 'conflict', policy: { enabled: false }, metadataVersion: 17 });
  expect(native.launches).toEqual([]);
  expect(native.mutations).toEqual([]);
});

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
