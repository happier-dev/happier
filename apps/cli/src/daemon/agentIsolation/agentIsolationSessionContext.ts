import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { AgentIsolationLaunchMaterialFailureCode } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { requireAgentIsolationMaterialNativeIdentity, projectAgentIsolationOperationMaterial,
  type AgentLaunchMaterialization, type AgentLaunchOperationMaterialization } from './agentLaunchMaterials';
import { resolveHostRequesterAgentPlacementForHost, selectHostRequesterExecutionIdentity, type HostAgentIsolationLaunchContext, type HostAgentIsolationLaunchSnapshot } from './agentIsolationLaunchPolicy';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import { readAgentIsolationNativeIdentity } from './agentIsolationNativeIdentity';
import type { AgentIsolationMemberRequester, AgentIsolationDaemonObservation } from './provisioning';
import type { AgentIsolationMemberNativeIdentity } from './agentIsolationNativeIdentity';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

function withWorkspaceRoot(snapshot: HostAgentIsolationLaunchSnapshot | undefined,
  workspaceRoot: string | undefined): HostAgentIsolationLaunchSnapshot | undefined {
  if (!snapshot || !workspaceRoot || snapshot.workspaceRoots.includes(workspaceRoot)) return snapshot;
  return { ...snapshot, workspaceRoots: [...snapshot.workspaceRoots, workspaceRoot] };
}

function memberLaunchFailureRecovery(input: Readonly<{
  machine: HostAgentIsolationLaunchContext;
  requesterIdentity: AgentIsolationMemberRequester;
  rpcContext?: RpcHandlerContext;
  signal?: AbortSignal;
}>): HostAgentIsolationLaunchContext['onNativeLaunchFailure'] {
  const prepareMember = input.machine.prepareMember;
  if (!prepareMember) return undefined;
  return async () => {
    if (input.signal?.aborted || input.rpcContext?.signal.aborted) return;
    try {
      const result = await prepareMember({ requesterIdentity: input.requesterIdentity,
        rpcContext: input.rpcContext, signal: input.signal });
      return result.repaired === true ? 'agent_isolation_unavailable' : undefined;
    } catch {
      // Failed repair never turns the failed command into a success or replays it.
      if (!input.signal?.aborted && !input.rpcContext?.signal.aborted) return 'agent_isolation_unavailable';
    }
  };
}

/** Each native invocation consumes its existing current materialization lease. */
export function createAgentIsolationSessionContext(input: Readonly<{
  machine?: HostAgentIsolationLaunchContext;
  managedHappierBinaryPath: string | undefined;
  sessionRequester?: RequesterWorkAttributionV1;
  sessionRequesterHomeServerIdentityId?: string | null;
  sessionCustodianAccountId?: string | null;
  hostHomeServerIdentityId?: string | null;
  resolveRequesterIdentity?: HostAgentIsolationLaunchContext['resolveRequesterIdentity'];
  providerEnvironmentKeys?: readonly string[];
  readMaterial(): AgentLaunchMaterialization | undefined;
}>): HostAgentIsolationLaunchContext {
  const requesterIdentity = selectHostRequesterExecutionIdentity({ sessionRequester: input.sessionRequester,
    sessionRequesterHomeServerIdentityId: input.sessionRequesterHomeServerIdentityId,
    sessionCustodianAccountId: input.sessionCustodianAccountId, hostHomeServerIdentityId: input.hostHomeServerIdentityId });
  return {
    ...(input.managedHappierBinaryPath ? { managedHappierBinaryPath: input.managedHappierBinaryPath } : {}),
    ...(input.resolveRequesterIdentity ? { resolveRequesterIdentity: input.resolveRequesterIdentity } : {}),
    requesterIdentity,
    ...(input.machine?.qualifyNativeReadiness ? { qualifyNativeReadiness: input.machine.qualifyNativeReadiness } : {}),
    read: () => {
      const snapshot = input.machine?.read();
      if (!snapshot?.enabled || requesterIdentity.kind !== 'isolated') return snapshot;
      const memberIdentity = input.readMaterial()?.memberIdentity;
      return withWorkspaceRoot({ ...snapshot, ...(memberIdentity ? { memberIdentity } : {}) }, memberIdentity?.workspaceRoot);
    },
    ...(input.machine ? { async prepareLaunch({ requesterIdentity, sessionMcpContext, mcpLaunchMaterial, agentNativeLaunch, signal }: Parameters<NonNullable<HostAgentIsolationLaunchContext['prepareLaunch']>>[0]) {
      const material = input.readMaterial();
      const member = material?.memberIdentity;
      const managedHappierBinaryPath = (member ? input.machine?.memberManagedHappierBinaryPath : undefined)
        ?? input.managedHappierBinaryPath;
      if (!material || !managedHappierBinaryPath
        || agentNativeLaunch && !sessionMcpContext) throw new PluginError({ code: 'agent_isolation_unavailable',
        message: 'Current Session isolation material is unavailable', retryable: false,
        details: { phase: 'native_execution_preparation', cause: (!material ? 'session_launch_material_missing'
          : !managedHappierBinaryPath ? 'managed_binary_missing' : 'session_mcp_context_missing') satisfies AgentIsolationLaunchMaterialFailureCode } });
      // Ordinary Account Sessions use the Home already qualified by the
      // requester resolver; protected requester birth keeps its retained Home.
      const home = input.sessionRequesterHomeServerIdentityId ?? input.hostHomeServerIdentityId;
      if (requesterIdentity?.kind !== 'isolated' || !home) throw new PluginError({
        code: 'agent_isolation_unavailable', message: 'Current Session requester is unavailable', retryable: false });
      if (member) {
        requireAgentIsolationMaterialNativeIdentity(member, { ...requesterIdentity, homeServerIdentityId: home });
        if (!isCanonicalAbsolutePathInsideRoot(member.home, material.runtimeHome)) throw new PluginError({
          code: 'agent_isolation_unavailable', message: 'Current Session material belongs to a different requester', retryable: false });
      } else if (resolveHostRequesterAgentPlacementForHost({ identity: requesterIdentity, snapshot: input.machine?.read() }) === 'member') {
        throw new PluginError({ code: 'agent_isolation_unavailable',
          message: 'Current Session member material is unavailable', retryable: false });
      }
      if (mcpLaunchMaterial) {
        const native = mcpLaunchMaterial.nativeIdentity;
        const projectedMember = mcpLaunchMaterial.memberIdentity;
        if (mcpLaunchMaterial.runtimeHome !== material.runtimeHome
          || !!member !== !!projectedMember
          || !Number.isSafeInteger(native.agentUid) || native.agentUid <= 0
          || !Number.isSafeInteger(native.agentGid) || native.agentGid <= 0
          || !isCanonicalAbsolutePathInsideRoot(native.home, material.runtimeHome)) throw new PluginError({
          code: 'agent_isolation_unavailable', message: 'Current MCP material belongs to a different lifetime', retryable: false });
        if (member && projectedMember) {
          requireAgentIsolationMaterialNativeIdentity(projectedMember, { ...requesterIdentity, homeServerIdentityId: home });
          if (native.home !== member.home || native.agentUid !== member.agentUid || native.agentGid !== member.agentGid
            || projectedMember.agentUid !== member.agentUid || projectedMember.agentGid !== member.agentGid) throw new PluginError({
            code: 'agent_isolation_unavailable', message: 'Current MCP native identity differs from its Session', retryable: false });
        }
      }
      const identity = member ?? mcpLaunchMaterial?.nativeIdentity ?? await readAgentIsolationNativeIdentity(signal);
      // Finite CLI probes consume the member selected at Session preparation;
      // only the native Session process requires its live MCP authority.
      if (!agentNativeLaunch && !sessionMcpContext) {
        if (!signal) throw new PluginError({ code: 'agent_isolation_unavailable',
          message: 'Current operation lifetime is unavailable', retryable: false });
        const selected = mcpLaunchMaterial ?? material;
        const operationMaterial = { materializationKey: material.runtimeHome,
          environment: selected.environment, selectedMaterials: selected.selectedMaterials,
          ...(selected.accountSettingsApplication ? { accountSettingsApplication: selected.accountSettingsApplication } : {}) };
        const operation = { machine: input.machine!, managedHappierBinaryPath,
          requesterIdentity: { ...requesterIdentity, homeServerIdentityId: home },
          signal,
          providerEnvironmentKeys: input.providerEnvironmentKeys,
          readTarget: () => input.readMaterial() === material ? material : undefined,
          readMaterial: () => operationMaterial };
        return createAgentIsolationOperationContext(member
          ? { ...operation, memberIdentity: member }
          : { ...operation, nativeIdentity: identity });
      }
      const launchMaterial = mcpLaunchMaterial ? { ...material,
        environment: { ...material.environment, ...mcpLaunchMaterial.environment },
        selectedMaterials: [...material.selectedMaterials, ...mcpLaunchMaterial.selectedMaterials] } : material;
      return { ...(member ? { onNativeLaunchFailure: memberLaunchFailureRecovery({ machine: input.machine!,
        requesterIdentity: { ...requesterIdentity, homeServerIdentityId: home }, signal }) } : {}), read() {
        if (input.readMaterial() !== material) throw new PluginError({ code: 'agent_isolation_unavailable',
          message: 'The Session materialization was retired', retryable: false });
        // A shared-agent Session can precede any Project. Its prepared native
        // home supplies the same root that finite native operations consume.
        const snapshot = withWorkspaceRoot(input.machine?.read(), member?.workspaceRoot ?? identity.home);
        if (!snapshot) throw new PluginError({ code: 'agent_isolation_unavailable',
          message: 'Current Machine isolation policy is unavailable', retryable: false });
        return { ...snapshot, ...(member ? { memberIdentity: member } : {}),
          localTransport: { agentUid: identity.agentUid, agentGid: identity.agentGid },
          launch: { managedHappierBinaryPath, runtimeHome: material.runtimeHome,
            providerEnvironmentKeys: input.providerEnvironmentKeys,
            environment: launchMaterial.environment, selectedEnvironmentKeys: Object.keys(launchMaterial.environment),
            selectedMaterials: launchMaterial.selectedMaterials, sessionMcpContext,
            ...(launchMaterial.accountSettingsApplication ? { accountSettingsApplication: launchMaterial.accountSettingsApplication } : {}) } };
      } };
    } } : {}),
  };
}

/** Whole-operation IO/PTY/MCP uses the same selected native/material owner,
 * without manufacturing Session MCP authority for a finite operation. */
export function createAgentIsolationOperationContext(input: Readonly<{
  machine: HostAgentIsolationLaunchContext;
  managedHappierBinaryPath: string;
  requesterIdentity: AgentIsolationMemberRequester;
  rpcContext?: RpcHandlerContext;
  daemonObservation?: AgentIsolationDaemonObservation | null;
  signal: AbortSignal;
  providerEnvironmentKeys?: readonly string[];
  readMaterial(): AgentLaunchOperationMaterialization | undefined;
}> & (Readonly<{
  memberIdentity: AgentIsolationMemberNativeIdentity;
  readTarget?(): AgentLaunchMaterialization | undefined;
}> | Readonly<{
  memberIdentity?: undefined;
  /** Already observed shared native fact and exact legacy owner material lease. */
  nativeIdentity: Pick<AgentIsolationMemberNativeIdentity, 'agentUid' | 'agentGid' | 'home'>;
  readTarget(): AgentLaunchMaterialization | undefined;
}>)): HostAgentIsolationLaunchContext {
  const unavailable: () => never = () => { throw new PluginError({ code: 'agent_isolation_unavailable',
    message: 'Requester native material is unavailable', retryable: false,
    details: { phase: 'native_execution_preparation' } }); };
  input.signal.throwIfAborted();
  const member = input.memberIdentity;
  const managedHappierBinaryPath = (member ? input.machine.memberManagedHappierBinaryPath : undefined)
    ?? input.managedHappierBinaryPath;
  const identity = member ? requireAgentIsolationMaterialNativeIdentity(member, input.requesterIdentity)
    : 'nativeIdentity' in input ? input.nativeIdentity : unavailable();
  const requesterIdentity = { kind: input.requesterIdentity.kind, requester: input.requesterIdentity.requester,
    separationRequired: input.requesterIdentity.separationRequired,
    ...(input.requesterIdentity.presentPerson ? { presentPerson: true as const } : {}),
    ...(input.requesterIdentity.accountAutomation ? { accountAutomation: true as const } : {}) };
  const initial = input.readMaterial();
  if (!initial?.materializationKey) unavailable();
  const materializationKey = initial.materializationKey;
  const target = input.readTarget?.();
  if (input.readTarget && !target) unavailable();
  if (target) {
    if (!isCanonicalAbsolutePathInsideRoot(identity.home, target.runtimeHome)
      || !!target.memberIdentity !== !!member) unavailable();
    if (member && target.memberIdentity) {
      const retained = requireAgentIsolationMaterialNativeIdentity(target.memberIdentity, input.requesterIdentity);
      if (retained.agentUid !== member.agentUid || retained.agentGid !== member.agentGid) unavailable();
    }
  }
  const snapshot = input.machine.read();
  const read = (captured?: AgentLaunchOperationMaterialization) => {
    input.signal.throwIfAborted();
    const material = input.readMaterial();
    if (!material || material.materializationKey !== materializationKey || captured && material !== captured) unavailable();
    if (target && input.readTarget?.() !== target) unavailable();
    const projected = target ? { runtimeHome: target.runtimeHome,
      environment: material.environment, selectedMaterials: material.selectedMaterials,
      ...(material.accountSettingsApplication ? { accountSettingsApplication: material.accountSettingsApplication } : {}) }
      : member ? projectAgentIsolationOperationMaterial(member, material) : unavailable();
    // Finite workers use the selected native home before any Project exists.
    const machine = withWorkspaceRoot(snapshot, member?.workspaceRoot ?? identity.home);
    if (!machine) unavailable();
    return { ...machine, ...(member ? { memberIdentity: member } : {}),
      ...(input.daemonObservation ? { daemonObservation: input.daemonObservation } : {}),
      localTransport: { agentUid: identity.agentUid, agentGid: identity.agentGid },
      launch: { managedHappierBinaryPath, runtimeHome: projected.runtimeHome,
        providerEnvironmentKeys: input.providerEnvironmentKeys,
        environment: projected.environment, selectedEnvironmentKeys: Object.keys(projected.environment),
        selectedMaterials: projected.selectedMaterials,
        ...(projected.accountSettingsApplication ? { accountSettingsApplication: projected.accountSettingsApplication } : {}) } };
  };
  const onNativeLaunchFailure = member ? memberLaunchFailureRecovery(input) : undefined;
  return { requesterIdentity, ...(onNativeLaunchFailure ? { onNativeLaunchFailure } : {}),
    resolveRequesterIdentity: async signal => {
      signal?.throwIfAborted(); input.signal.throwIfAborted(); return requesterIdentity;
    },
    read: () => read(),
    async prepareLaunch({ requesterIdentity, signal, sessionMcpContext, mcpLaunchMaterial }) {
      signal?.throwIfAborted(); input.signal.throwIfAborted();
      if (requesterIdentity?.kind !== 'isolated') unavailable();
      if (member) requireAgentIsolationMaterialNativeIdentity(member, { ...requesterIdentity,
        homeServerIdentityId: input.requesterIdentity.homeServerIdentityId });
      const captured = input.readMaterial();
      if (!captured) unavailable();
      read(captured);
      return { requesterIdentity, ...(onNativeLaunchFailure ? { onNativeLaunchFailure } : {}), read: () => {
        const snapshot = read(captured);
        return { ...snapshot, launch: { ...snapshot.launch,
          ...(mcpLaunchMaterial ? { environment: { ...snapshot.launch.environment, ...mcpLaunchMaterial.environment },
            selectedEnvironmentKeys: [...new Set([...snapshot.launch.selectedEnvironmentKeys, ...Object.keys(mcpLaunchMaterial.environment)])],
            selectedMaterials: [...snapshot.launch.selectedMaterials, ...mcpLaunchMaterial.selectedMaterials] } : {}),
          ...(sessionMcpContext ? { sessionMcpContext } : {}) } };
      } };
    },
  };
}
