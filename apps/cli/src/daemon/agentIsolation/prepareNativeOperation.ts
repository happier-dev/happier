import { isDeepStrictEqual } from 'node:util';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { prepareRequesterOperationMaterial } from '@/daemon/connectedServices/purposeBindings/requesterOperationMaterial';
import { resolveInstalledMachineEffectCli } from '@/machines/adminAccess/runElevatedEffect';
import { assertHostRequesterExecutionAdmissionForHost, resolveHostRequesterAgentPlacementForHost,
  type HostAgentIsolationLaunchContext, type HostRequesterExecutionIdentity } from './agentIsolationLaunchPolicy';
import { readAgentIsolationNativeIdentity, type AgentIsolationMemberNativeIdentity } from './agentIsolationNativeIdentity';
import { observeAgentIsolationMemberLaunchReadiness } from './agentIsolationReadiness';
import { createAgentIsolationOperationContext } from './agentIsolationSessionContext';
import { projectAgentIsolationOperationMaterial, type AgentLaunchMaterialization,
  type AgentLaunchOperationMaterialization } from './agentLaunchMaterials';

export type PrepareRequesterNativeOperationInput = Readonly<{
  requesterIdentity: HostRequesterExecutionIdentity;
  requesterAccount?: RequesterAccountActionContext;
  resolveRequesterIdentity: NonNullable<HostAgentIsolationLaunchContext['resolveRequesterIdentity']>;
  readMaterial(): AgentLaunchOperationMaterialization | undefined;
  ingress?: RpcHandlerContext;
  signal: AbortSignal;
}>;

/** Finite native effects consume admitted requester custody. Shared-user
 * readiness belongs to the Machine; member readiness belongs to the exact
 * prepared identity and is observed before its operation material is used. */
export async function prepareRequesterNativeOperation(input: PrepareRequesterNativeOperationInput, host: Readonly<{
  machine?: HostAgentIsolationLaunchContext;
  homeServerIdentityId?: string | null;
  machineId: string;
  installationId: string | null | undefined;
  reloadController: Parameters<typeof prepareRequesterOperationMaterial>[0]['reloadController'];
}>) {
  const unavailable = () => Object.assign(new PluginError({ code: 'agent_isolation_unavailable',
    message: 'Requester native execution is unavailable', retryable: false,
    details: { reason: 'requester_authority_unavailable', phase: 'native_execution_preparation' },
  }), { rpcErrorCode: 'agent_isolation_unavailable' });
  input.signal.throwIfAborted();
  const selected = await input.resolveRequesterIdentity(input.signal);
  const { machine, homeServerIdentityId } = host;
  if (selected.kind !== 'isolated' || !isDeepStrictEqual(selected, input.requesterIdentity)
    || !machine || !homeServerIdentityId || selected.requester.machineId !== host.machineId
    || selected.requester.installationId !== host.installationId) throw unavailable();
  const requesterIdentity = { ...selected, homeServerIdentityId };
  const snapshot = machine.read();
  const placement = resolveHostRequesterAgentPlacementForHost({ identity: selected, snapshot });
  if (placement === 'daemon') throw unavailable();
  const operation = { machine, requesterIdentity, signal: input.signal,
    managedHappierBinaryPath: machine.managedHappierBinaryPath ?? resolveInstalledMachineEffectCli(),
    readMaterial: input.readMaterial };
  let memberIdentity: AgentIsolationMemberNativeIdentity | undefined;
  let workingDirectory: string;
  let target: AgentLaunchMaterialization | undefined;
  let agentIsolation: HostAgentIsolationLaunchContext;
  if (placement === 'member') {
    if (!machine.prepareMember) throw unavailable();
    const native = await machine.prepareMember({ requesterIdentity, rpcContext: input.ingress, signal: input.signal });
    const readiness = await observeAgentIsolationMemberLaunchReadiness({ installedCli: operation.managedHappierBinaryPath,
      memberIdentity: native.identity, signal: input.signal });
    if (readiness.kind !== 'member_native_ready') throw Object.assign(new PluginError({ code: 'agent_isolation_unavailable',
      message: 'Requester native execution is unavailable', retryable: false,
      details: { reason: readiness.code, phase: 'native_execution_preparation' },
    }), { rpcErrorCode: 'agent_isolation_unavailable' });
    // This is the existing native readiness owner's result for this operation,
    // never a publication of global/shared-user readiness or inferred consent.
    const memberSnapshot = snapshot && { ...snapshot, status: readiness.status };
    assertHostRequesterExecutionAdmissionForHost({ identity: selected, snapshot: memberSnapshot, agentLaunchKind: 'exec' });
    memberIdentity = native.identity;
    workingDirectory = native.identity.workspaceRoot;
    agentIsolation = createAgentIsolationOperationContext({ ...operation,
      machine: { read: () => memberSnapshot }, memberIdentity, daemonObservation: native.daemonObservation });
  } else {
    assertHostRequesterExecutionAdmissionForHost({ identity: selected, snapshot, agentLaunchKind: 'exec' });
    const nativeIdentity = await readAgentIsolationNativeIdentity(input.signal);
    const material = input.readMaterial();
    if (!material) throw unavailable();
    target = projectAgentIsolationOperationMaterial(nativeIdentity, material);
    workingDirectory = nativeIdentity.home;
    agentIsolation = createAgentIsolationOperationContext({ ...operation, nativeIdentity, readTarget: () => target });
  }
  const launch = agentIsolation.read()?.launch;
  if (!launch) throw unavailable();
  let material: Awaited<ReturnType<typeof prepareRequesterOperationMaterial>> | undefined;
  try {
    if (input.requesterAccount) material = await prepareRequesterOperationMaterial({
      requesterAccount: input.requesterAccount, requesterIdentity,
      reloadController: host.reloadController, signal: input.signal });
    input.signal.throwIfAborted();
    return { requesterIdentity: selected, memberIdentity, workingDirectory, agentIsolation,
      materialTarget: { runtimeHome: launch.runtimeHome, ...(memberIdentity ? { memberIdentity } : {}) },
      ...(material ? { material, connectedAccounts: material.connectedAccounts } : {}),
      async dispose() { target = undefined; await material?.dispose(); } };
  } catch (error) {
    try { await material?.dispose(); }
    catch { /* Material owner retains its typed cleanup failure. */ }
    throw error;
  }
}
