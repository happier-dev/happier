import { PluginError } from '@happier-dev/plugin-sdk';
import { projectSessionRunnerLaunchAdmissionFailure, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { readAgentIsolationNativeIdentity, type AgentIsolationMemberNativeIdentity } from '../agentIsolation/agentIsolationNativeIdentity';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import type { ManagedSessionDirectoryPayloadPlacement } from '@/session/creation/managedSessionDirectories';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

/** Undefined is the admission owner's ordinary/shared-user result; member refusals reject. */
export type PrepareAgentIsolationMember = (input: Readonly<{
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
    signal?: AbortSignal;
}>) => Promise<AgentIsolationMemberNativeIdentity | undefined>;

export type PreparedDaemonAgentIsolationIdentity = Readonly<{
    memberIdentity?: AgentIsolationMemberNativeIdentity;
    nativeIdentity?: Pick<AgentIsolationMemberNativeIdentity, 'agentUid' | 'agentGid' | 'home'>;
    payloadPlacement?: ManagedSessionDirectoryPayloadPlacement;
}>;

/** Select once before allocating a cwd, then retain this result for native materialization. */
export async function prepareDaemonAgentIsolationIdentity(input: Readonly<{
    hasAgentRuntime: boolean;
    prepareAgentIsolationMember?: PrepareAgentIsolationMember;
    readAgentIsolationEnabled?: () => boolean;
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
    signal?: AbortSignal;
    managedDirectory?: Readonly<{ directory: string; workspaceRoots: readonly string[] }>;
}>): Promise<({ ok: true } & PreparedDaemonAgentIsolationIdentity)
    | { ok: false; result: Extract<SpawnSessionResult, { type: 'error' }> }> {
    try {
        const memberIdentity = input.hasAgentRuntime ? await input.prepareAgentIsolationMember?.({
            requesterWorkAttributionV1: input.requesterWorkAttributionV1, signal: input.signal,
        }) : undefined;
        const nativeIdentity = memberIdentity ?? (input.prepareAgentIsolationMember
            && input.readAgentIsolationEnabled?.() === true && input.hasAgentRuntime
            ? await readAgentIsolationNativeIdentity(input.signal) : undefined);
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
        return { ok: true, ...(memberIdentity ? { memberIdentity } : {}), ...(nativeIdentity ? { nativeIdentity } : {}),
            ...(payloadPlacement ? { payloadPlacement } : {}) };
    } catch (error) {
        if (!(error instanceof PluginError) || error.code !== 'agent_isolation_unavailable') throw error;
        return { ok: false, result: projectSessionRunnerLaunchAdmissionFailure({
            kind: 'launch_error', code: 'agent_isolation_unavailable', message: 'Member execution requires owner setup',
        })! };
    }
}
