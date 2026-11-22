import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { HostAgentIsolationLaunchContext, HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { createMemberWorkspaceReadServices, createMemberWorkspaceReadSource, type MemberWorkspaceReadServices } from './memberWorkspaceSource';
import { authorizeWorkspaceEffectLaunch, runWorkspaceEffectChild } from './workspaceEffectProcess';

export type MemberProjectReadEffect = Readonly<{ kind: 'project_read'; workspaceRoot: string; root: string }>;
export type MemberProjectReadService = (reads: MemberWorkspaceReadServices) => Promise<void>;
const unavailable = (code = 'project_workspace_unavailable') => new PluginError({ code, message: code });

/** Parent retains Account authority and the canonical inspector; only filesystem facts cross this port. */
export async function readProjectAsMember<T>(input: Readonly<{
    agentIsolation: HostAgentIsolationLaunchContext;
    requesterIdentity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>;
    workspaceRoot: string; root: string; signal: AbortSignal;
    read(): Promise<T>;
}>): Promise<T> {
    const binary = input.agentIsolation.read()?.launch?.managedHappierBinaryPath;
    if (!binary) throw unavailable('agent_isolation_unavailable');
    const launch = await authorizeWorkspaceEffectLaunch({ agentIsolation: input.agentIsolation, requesterIdentity: input.requesterIdentity,
        workspaceRoot: input.workspaceRoot, managedHappierBinaryPath: binary, signal: input.signal,
        assertCurrent: () => input.signal.throwIfAborted() });
    const id = randomUUID();
    let result: { value: T } | undefined;
    let failure: unknown;
    const outcome = await runWorkspaceEffectChild({ launch, signal: input.signal, id,
        effect: { kind: 'project_read', workspaceRoot: input.workspaceRoot, root: input.root } satisfies MemberProjectReadEffect,
        refusal: unavailable, services: { onEffectsIssued: async () => {}, complete: async () => { throw unavailable('workspace_effect_protocol_invalid'); },
            fail: async (error: Error) => { failure = error; },
            readProject: async (reads: MemberWorkspaceReadServices) => {
                result = { value: await runWithWorkspaceSource(createMemberWorkspaceReadSource(reads, id), input.read) };
            } },
    });
    if (outcome.failure !== undefined) throw outcome.failure;
    if (failure !== undefined) throw failure;
    input.signal.throwIfAborted();
    if (!outcome.settled || !result) throw unavailable('workspace_effect_outcome_unknown');
    return result.value;
}

/** Child-only root admission precedes every Project-file or adapter read. */
export async function executeMemberProjectRead(effect: MemberProjectReadEffect, signal: AbortSignal,
    services: Readonly<{ readProject: MemberProjectReadService }>): Promise<void> {
    signal.throwIfAborted();
    if (canonicalAbsolutePathsEqual(effect.workspaceRoot, effect.root)
        || !isCanonicalAbsolutePathInsideRoot(effect.workspaceRoot, effect.root)) throw unavailable();
    const info = await lstat(effect.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    const [workspaceRoot, root] = await Promise.all([realpath(effect.workspaceRoot), realpath(effect.root)]);
    if (canonicalAbsolutePathsEqual(workspaceRoot, root) || !isCanonicalAbsolutePathInsideRoot(workspaceRoot, root)) throw unavailable();
    signal.throwIfAborted();
    await services.readProject(createMemberWorkspaceReadServices());
}
