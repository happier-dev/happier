import { projectSessionRunnerLaunchAdmissionFailure, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import type { PreparedRequesterNativeIdentity } from '../agentIsolation/prepareNativeOperation';
import { type AgentIsolationMemberNativeIdentity } from '../agentIsolation/agentIsolationNativeIdentity';
import { projectAgentIsolationLaunchRefusal } from '../agentIsolation/agentIsolationLaunchRefusal';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import type { ManagedSessionDirectoryPayloadPlacement } from '@/session/creation/managedSessionDirectories';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

/** Undefined is ordinary daemon placement; native refusals reject. */
export type PrepareAgentIsolationMember = (input: Readonly<{
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
    signal?: AbortSignal;
}>) => Promise<PreparedRequesterNativeIdentity | undefined>;

export type PreparedDaemonAgentIsolationIdentity = Readonly<{
    requesterNativeIdentity?: PreparedRequesterNativeIdentity;
    memberIdentity?: AgentIsolationMemberNativeIdentity;
    nativeIdentity?: Pick<AgentIsolationMemberNativeIdentity, 'agentUid' | 'agentGid' | 'home'>;
    payloadPlacement?: ManagedSessionDirectoryPayloadPlacement;
}>;

/** Select once before allocating a cwd, then retain this result for native materialization. */
export async function prepareDaemonAgentIsolationIdentity(input: Readonly<{
    hasAgentRuntime: boolean;
    prepareAgentIsolationMember?: PrepareAgentIsolationMember;
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
    signal?: AbortSignal;
    managedDirectory?: Readonly<{ directory: string; workspaceRoots: readonly string[] }>;
}>): Promise<({ ok: true } & PreparedDaemonAgentIsolationIdentity)
    | { ok: false; result: Extract<SpawnSessionResult, { type: 'error' }> }> {
    try {
        const requesterNativeIdentity = input.hasAgentRuntime ? await input.prepareAgentIsolationMember?.({
            requesterWorkAttributionV1: input.requesterWorkAttributionV1, signal: input.signal,
        }) : undefined;
        const memberIdentity = requesterNativeIdentity?.kind === 'member' ? requesterNativeIdentity.identity : undefined;
        const nativeIdentity = requesterNativeIdentity?.identity;
        let payloadPlacement: ManagedSessionDirectoryPayloadPlacement | undefined;
        if (nativeIdentity && input.managedDirectory) {
            const managedDirectory = input.managedDirectory;
            let root = memberIdentity?.workspaceRoot;
            if (!root) {
                const roots = managedDirectory.workspaceRoots;
                const exact = roots.find(candidate => canonicalAbsolutePathsEqual(candidate, managedDirectory.directory));
                const containing = exact ? [exact] : roots.filter(candidate => isCanonicalAbsolutePathInsideRoot(candidate, managedDirectory.directory));
                root = containing.length === 1 ? containing[0]
                    : containing.length === 0 && roots.length === 1 ? roots[0] : undefined;
            }
            if (!root) return { ok: false, result: projectSessionRunnerLaunchAdmissionFailure({
                kind: 'launch_error', code: 'agent_isolation_unavailable',
                message: 'Choose an accepted Workspace or path for this Session',
            })! };
            payloadPlacement = { root, agentUid: nativeIdentity.agentUid };
        }
        return { ok: true, ...(requesterNativeIdentity ? { requesterNativeIdentity } : {}), ...(memberIdentity ? { memberIdentity } : {}), ...(nativeIdentity ? { nativeIdentity } : {}),
            ...(payloadPlacement ? { payloadPlacement } : {}) };
    } catch (error) {
        const refusal = projectAgentIsolationLaunchRefusal(error);
        if (!refusal) throw error;
        return { ok: false, result: projectSessionRunnerLaunchAdmissionFailure(refusal)! };
    }
}
