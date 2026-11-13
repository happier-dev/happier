import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { encodeAgentLaunchFrame } from './agentLaunchFrame';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { AgentIsolationMemberRequester, AgentIsolationDaemonObservation } from './provisioning';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { prepareRequesterOperationMaterial } from '@/daemon/connectedServices/purposeBindings/requesterOperationMaterial';
import { resolveInstalledMachineEffectCli } from '@/machines/adminAccess/runElevatedEffect';
import { assertHostRequesterExecutionAdmissionForHost, resolveHostRequesterAgentPlacementForHost,
  type HostAgentIsolationLaunchContext, type HostAgentIsolationLaunchSnapshot, type HostRequesterExecutionIdentity } from './agentIsolationLaunchPolicy';
import { readAgentIsolationNativeIdentity, type AgentIsolationMemberNativeIdentity } from './agentIsolationNativeIdentity';
import { createAgentIsolationOperationContext } from './agentIsolationSessionContext';
import { projectAgentIsolationOperationMaterial, type AgentLaunchMaterialization,
  type AgentLaunchOperationMaterialization } from './agentLaunchMaterials';

export type PreparedRequesterNativeIdentity = Readonly<{
  requesterIdentity: AgentIsolationMemberRequester;
  snapshot: HostAgentIsolationLaunchSnapshot | undefined;
} & (
  { kind: 'member'; identity: AgentIsolationMemberNativeIdentity; daemonObservation?: AgentIsolationDaemonObservation | null }
  | { kind: 'sharedAgent'; identity: Pick<AgentIsolationMemberNativeIdentity, 'agentUid' | 'agentGid' | 'home'> }
)>;

/** Deliberate admission uses the incumbent member provisioner on a cold or
 * broken binding. Read-only inventory never calls this preparation entry. */
export async function prepareAgentIsolationMemberForIntent(machine: HostAgentIsolationLaunchContext,
  input: Parameters<NonNullable<HostAgentIsolationLaunchContext['readMember']>>[0]
): ReturnType<NonNullable<HostAgentIsolationLaunchContext['readMember']>> {
  if (!machine.readMember) throw new Error('Member identity reader is unavailable');
  return machine.readMember(input).catch(error => {
    input.signal?.throwIfAborted();
    if (!machine.prepareMember) throw error;
    return machine.prepareMember(input);
  });
}

/** A committed member binding is ready independently of the shared agent user. */
export function projectMemberNativeOperationSnapshot(snapshot: HostAgentIsolationLaunchSnapshot | undefined): HostAgentIsolationLaunchSnapshot | undefined {
  return snapshot && { ...snapshot, status: { kind: 'effective', platform: 'linux' } };
}

export type PrepareRequesterNativeOperationInput = Readonly<{
  requesterIdentity: HostRequesterExecutionIdentity;
  /** Exact native fact already prepared by Session admission. */
  preparedIdentity?: PreparedRequesterNativeIdentity;
  requesterAccount?: RequesterAccountActionContext;
  retainedRequesterCustody?: ReturnType<NonNullable<RequesterAccountActionContext['retainCustody']>>;
  readMaterial(identity: Pick<AgentIsolationMemberNativeIdentity, 'agentUid' | 'agentGid' | 'home'>): AgentLaunchOperationMaterialization | undefined;
  ingress?: RpcHandlerContext;
  signal: AbortSignal;
  /** A status read consumes an existing native binding without provisioning. */
  allowMemberPreparation?: false;
}>;

/** Finite native effects consume admitted requester custody. Shared-user
 * readiness belongs to setup/own-status; operations consume the admitted native
 * binding and actual launch failures use the existing repair owner. */
export async function prepareRequesterNativeOperation(input: PrepareRequesterNativeOperationInput, host: Readonly<{
  machine?: HostAgentIsolationLaunchContext;
  homeServerIdentityId?: string | null;
  machineId: string;
  installationId: string | null | undefined;
  reloadController?: Parameters<typeof prepareRequesterOperationMaterial>[0]['reloadController'];
}>) {
  const unavailable = () => Object.assign(new PluginError({ code: 'agent_isolation_unavailable',
    message: 'Requester native execution is unavailable', retryable: false,
    details: { reason: 'requester_authority_unavailable', phase: 'native_execution_preparation' },
  }), { rpcErrorCode: 'agent_isolation_unavailable' });
  input.signal.throwIfAborted();
  const selected = input.requesterIdentity;
  const { homeServerIdentityId } = host;
  const machine = input.preparedIdentity && host.machine
    ? { ...host.machine, ...(input.allowMemberPreparation === false ? { prepareMember: undefined } : {}),
      read: () => input.preparedIdentity!.snapshot }
    : input.allowMemberPreparation === false && host.machine
      ? { ...host.machine, prepareMember: undefined } : host.machine;
  if (selected.kind !== 'isolated'
    || !machine || !homeServerIdentityId || selected.requester.machineId !== host.machineId
    || selected.requester.installationId !== host.installationId) throw unavailable();
  const requesterIdentity = { ...selected, homeServerIdentityId };
  if (!input.preparedIdentity && input.allowMemberPreparation !== false) await machine.qualifyNativeReadiness?.({ requesterIdentity: selected, signal: input.signal });
  const snapshot = input.preparedIdentity ? input.preparedIdentity.snapshot : machine.read();
  const placement = input.preparedIdentity?.kind ?? resolveHostRequesterAgentPlacementForHost({ identity: selected, snapshot });
  if (placement === 'daemon') throw unavailable();
  const operation = { machine, requesterIdentity, signal: input.signal,
    managedHappierBinaryPath: machine.managedHappierBinaryPath ?? resolveInstalledMachineEffectCli(),
  };
  let memberIdentity: AgentIsolationMemberNativeIdentity | undefined;
  let workingDirectory: string;
  let target: AgentLaunchMaterialization | undefined;
  let agentIsolation: HostAgentIsolationLaunchContext;
  if (placement === 'member') {
    if (!input.preparedIdentity && !machine.readMember) throw unavailable();
    const memberInput = { requesterIdentity, rpcContext: input.ingress, signal: input.signal };
    const native = input.preparedIdentity?.kind === 'member' ? input.preparedIdentity
      : await prepareAgentIsolationMemberForIntent(machine, memberInput);
    // This operation consumes a committed member binding. Global shared-user
    // readiness is independent and is not republished by native operations.
    const memberSnapshot = projectMemberNativeOperationSnapshot(snapshot);
    if (!input.preparedIdentity) assertHostRequesterExecutionAdmissionForHost({ identity: selected, snapshot: memberSnapshot, agentLaunchKind: 'exec' });
    memberIdentity = native.identity;
    workingDirectory = native.identity.workspaceRoot;
    agentIsolation = createAgentIsolationOperationContext({ ...operation,
      readMaterial: () => input.readMaterial(native.identity),
      machine: { ...machine, read: () => memberSnapshot }, memberIdentity,
      rpcContext: input.ingress, daemonObservation: native.daemonObservation });
  } else {
    if (!input.preparedIdentity) assertHostRequesterExecutionAdmissionForHost({ identity: selected, snapshot, agentLaunchKind: 'exec' });
    const nativeIdentity = input.preparedIdentity?.kind === 'sharedAgent' ? input.preparedIdentity.identity
      : await readAgentIsolationNativeIdentity(input.signal);
    const material = input.readMaterial(nativeIdentity);
    if (!material) throw unavailable();
    target = projectAgentIsolationOperationMaterial(nativeIdentity, material);
    workingDirectory = nativeIdentity.home;
    agentIsolation = createAgentIsolationOperationContext({ ...operation, nativeIdentity,
      readMaterial: () => input.readMaterial(nativeIdentity), readTarget: () => target });
  }
  const launch = agentIsolation.read()?.launch;
  if (!launch) throw unavailable();
  const runtimeHome = launch.runtimeHome;
  let material: Awaited<ReturnType<typeof prepareRequesterOperationMaterial>> | undefined;
  try {
    if (input.requesterAccount) {
      if (!host.reloadController) throw unavailable();
      material = await prepareRequesterOperationMaterial({
        requesterAccount: input.requesterAccount, requesterIdentity,
        ...(input.retainedRequesterCustody ? { retainedCustody: input.retainedRequesterCustody } : {}),
        reloadController: host.reloadController, signal: input.signal });
    }
    input.signal.throwIfAborted();
    return { requesterIdentity: selected, memberIdentity, workingDirectory, agentIsolation,
      materialTarget: { runtimeHome: launch.runtimeHome, ...(memberIdentity ? { memberIdentity } : {}) },
      ...(material ? { material, connectedAccounts: material.connectedAccounts } : {}),
      async dispose() {
        target = undefined;
        // The caller's native process custody has settled before this lease releases.
        // Its cancellation may already be aborted; cleanup is still awaited.
        try {
          await execFileWithDeadline('sudo', ['-n', '-u', memberIdentity?.username ?? 'happier-agent', '--',
            operation.managedHappierBinaryPath, 'agent-launch'], { env: {}, inputBytes: encodeAgentLaunchFrame({
              v: 1, action: 'retire_operation', runtimeHome,
              ...(memberIdentity ? { nativeIdentity: { username: memberIdentity.username, agentUid: memberIdentity.agentUid,
                agentGid: memberIdentity.agentGid, home: memberIdentity.home } } : {}),
            }) });
        } catch (cause) {
          throw new PluginError({ code: 'requester_material_cleanup_failed', message: 'Requester material cleanup failed',
            retryable: false, details: { phase: 'requester_material_cleanup' } }, { cause });
        } finally { await material?.dispose(); }
      } };
  } catch (error) {
    try { await material?.dispose(); }
    catch { /* Material owner retains its typed cleanup failure. */ }
    throw error;
  }
}
