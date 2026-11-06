import { readAgentIsolationNativeIdentity } from '@/daemon/agentIsolation/agentIsolationNativeIdentity';
import { requireAgentIsolationMaterialNativeIdentity } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import type { AgentRuntimeRunnerBootstrapLaunchV1 } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import type { AgentLaunchMaterialization } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { refuseMcpExecutionSource, type McpExecutionSource } from './mcpExecutionSource';

/** Consume the protected launch placement and the Session owner's captured
 * requester authority; metadata alone cannot describe the executing native UID. */
export async function resolveSessionMcpNativeLaunchMaterial({ launch, source, homeServerIdentityId, isolationEnabled, signal }: Readonly<{
  launch: Pick<AgentRuntimeRunnerBootstrapLaunchV1, 'agentIsolationMemberIdentity' | 'agentIsolationRuntimeHome'> | undefined;
  source: McpExecutionSource;
  homeServerIdentityId: string | null | undefined;
  isolationEnabled: boolean;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  identity: Awaited<ReturnType<typeof readAgentIsolationNativeIdentity>>;
  target?: Pick<AgentLaunchMaterialization, 'runtimeHome' | 'memberIdentity'>;
}> | null> {
  const identity = launch?.agentIsolationMemberIdentity;
  const runtimeHome = launch?.agentIsolationRuntimeHome;
  if (identity) {
    // The private carrier retains a native observation, not Session
    // authority. Bind it to the same captured birth and canonical Home
    // used by this Session before granting the payload socket access.
    if (source.kind !== 'requester' || source.identity.kind !== 'isolated'
      || !source.hostHomeServerIdentityId
      || source.hostHomeServerIdentityId !== homeServerIdentityId) {
      return refuseMcpExecutionSource('requester_authority_unavailable');
    }
    const nativeIdentity = requireAgentIsolationMaterialNativeIdentity(identity, {
      ...source.identity, homeServerIdentityId: source.hostHomeServerIdentityId,
    });
    if (!runtimeHome || !isCanonicalAbsolutePathInsideRoot(nativeIdentity.home, runtimeHome)) {
      return refuseMcpExecutionSource('requester_authority_unavailable');
    }
    // The native launch tuple is closed on the runner wire. Keep requester
    // provenance only in the separately typed member placement carrier.
    return { identity: { home: nativeIdentity.home, agentUid: nativeIdentity.agentUid, agentGid: nativeIdentity.agentGid },
      target: { runtimeHome, memberIdentity: nativeIdentity } };
  }
  if (runtimeHome || isolationEnabled) {
    if (source.kind !== 'requester' || source.identity.kind !== 'isolated'
      || (!runtimeHome && source.identity.separationRequired) || !source.hostHomeServerIdentityId
      || source.hostHomeServerIdentityId !== homeServerIdentityId) {
      return refuseMcpExecutionSource('requester_authority_unavailable');
    }
    // The daemon already selected shared versus member placement in this
    // protected carrier. Requester separation is not another native policy.
    const nativeIdentity = await readAgentIsolationNativeIdentity(signal);
    if (runtimeHome && !isCanonicalAbsolutePathInsideRoot(nativeIdentity.home, runtimeHome)) {
      return refuseMcpExecutionSource('requester_authority_unavailable');
    }
    return { identity: nativeIdentity, ...(runtimeHome ? { target: { runtimeHome } } : {}) };
  }
  return null;
}
