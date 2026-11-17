import type { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import type { ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, rm } from 'node:fs/promises';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { HostAgentIsolationLaunchContext, HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { authorizeWorkspaceEffectLaunch, runWorkspaceEffectChild } from '@/workspaces/activation/workspaceEffectProcess';
import { createMemberWorkspaceReadServices, type MemberWorkspaceReadServices } from '@/workspaces/activation/memberWorkspaceSource';

export type MemberSessionDirectoryRemovalEffect = Readonly<{
    kind: 'session_directory_remove'; workspaceRoot: string; directory: string;
}>;
/** Account authority and teardown stay in the original host operation. */
export type MemberSessionDirectoryRemovalService = (reads: MemberWorkspaceReadServices,
    removeDirectory: () => Promise<void>) => Promise<void>;
export type PreparedMemberSessionDirectoryRemoval = Readonly<{ remove(): Promise<void>; dispose(): Promise<void> }>;

const unavailable = (code = 'session_directory_unavailable') => new PluginError({ code, message: code });

/** The existing same-binary member effect owns every payload read and its removal. */
async function removeSessionDirectoryAsMember(input: Readonly<{
    agentIsolation: HostAgentIsolationLaunchContext;
    requesterIdentity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>;
    workspaceRoot: string; directory: string; signal: AbortSignal;
    removeSessionDirectory: MemberSessionDirectoryRemovalService;
}>): Promise<void> {
    const binary = input.agentIsolation.read()?.launch?.managedHappierBinaryPath;
    if (!binary) throw unavailable('agent_isolation_unavailable');
    const launch = await authorizeWorkspaceEffectLaunch({ agentIsolation: input.agentIsolation,
        requesterIdentity: input.requesterIdentity, signal: input.signal,
        assertCurrent: () => input.signal.throwIfAborted(), managedHappierBinaryPath: binary, workspaceRoot: input.workspaceRoot });
    let completed = false;
    let failure: unknown;
    const outcome = await runWorkspaceEffectChild({ launch, signal: input.signal, id: randomUUID(),
        effect: { kind: 'session_directory_remove', workspaceRoot: input.workspaceRoot,
            directory: input.directory } satisfies MemberSessionDirectoryRemovalEffect,
        refusal: unavailable,
        services: { onEffectsIssued: async () => {}, complete: async () => { throw unavailable('workspace_effect_protocol_invalid'); },
            fail: async (error: Error) => { failure = error; },
            removeSessionDirectory: input.removeSessionDirectory,
            completeSessionDirectoryRemoval: async () => { completed = true; } },
    });
    if (outcome.failure !== undefined) throw outcome.failure;
    if (failure !== undefined) throw failure;
    if (!outcome.settled || !completed) throw unavailable('workspace_effect_outcome_unknown');
}

/** Keeps the admitted child and its removal closure alive across the containing Home DELETE. */
export async function prepareSessionDirectoryRemovalAsMember(input: Omit<Parameters<typeof removeSessionDirectoryAsMember>[0],
    'removeSessionDirectory'> & Readonly<{ prepareRemoval(reads: MemberWorkspaceReadServices): Promise<void> }>): Promise<PreparedMemberSessionDirectoryRemoval> {
    let decide!: (remove: boolean) => void;
    const decision = new Promise<boolean>(resolve => { decide = resolve; });
    let prepared!: () => void;
    let rejectPreparation!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { prepared = resolve; rejectPreparation = reject; });
    const pending = removeSessionDirectoryAsMember({ ...input, async removeSessionDirectory(reads, removeDirectory) {
        try {
            await input.prepareRemoval(reads);
            prepared();
            if (await decision) await removeDirectory();
        } catch (error) {
            rejectPreparation(error);
            if (isPluginError(error)) throw error;
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? error.code : 'session_directory_unavailable';
            const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
            throw new PluginError({ code, message: code,
                ...(details === undefined ? {} : { details: projectNativeJsonValueForTransport(details) }) });
        }
    } });
    // A worker refusal before invoking the callback must also release preparation.
    const settled = pending.then(() => rejectPreparation(unavailable('workspace_effect_outcome_unknown')), error => { rejectPreparation(error); });
    try { await ready; }
    catch (error) { decide(false); await settled; throw error; }
    const finish = async (remove: boolean) => {
        decide(remove);
        try { await pending; }
        catch (error) {
            if (isPluginError(error)) throw Object.assign(new Error(error.data.message), { code: error.data.code, details: error.data.details });
            throw error;
        }
    };
    return { remove: () => finish(true), dispose: async () => { decide(false); await settled; } };
}

/** Member worker only: the host never resolves or opens this controlled path. */
export async function executeMemberSessionDirectoryRemoval(effect: MemberSessionDirectoryRemovalEffect, signal: AbortSignal,
    services: Readonly<{ removeSessionDirectory: MemberSessionDirectoryRemovalService }>): Promise<void> {
    signal.throwIfAborted();
    if (canonicalAbsolutePathsEqual(effect.workspaceRoot, effect.directory)
        || !isCanonicalAbsolutePathInsideRoot(effect.workspaceRoot, effect.directory)) throw unavailable();
    const info = await lstat(effect.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    const [root, directory] = await Promise.all([realpath(effect.workspaceRoot), realpath(effect.directory)]);
    if (canonicalAbsolutePathsEqual(root, directory) || !isCanonicalAbsolutePathInsideRoot(root, directory)) throw unavailable();
    await services.removeSessionDirectory(createMemberWorkspaceReadServices(), async () => {
        signal.throwIfAborted();
        await rm(effect.directory, { recursive: true });
    });
}

/** Shared native allocation preparation; requester admission remains with the containing Action. */
export async function prepareManagedSessionDirectoryRemovalAsMember(input: Readonly<{
    nativeOperationRuntime: Pick<ApiMachineClient, 'prepareNativeOperation' | 'readMemberFolderOwner'>;
    ingress: RpcHandlerContext; operation: ProjectSetupOperationContext; directory: string;
    prepareRemoval(reads: MemberWorkspaceReadServices,
        runtime: Pick<ProjectFiniteActionRuntime, 'requesterIdentity' | 'agentIsolation'>): Promise<void>;
}>): Promise<PreparedMemberSessionDirectoryRemoval> {
    const identity = await input.nativeOperationRuntime.readMemberFolderOwner(input.directory);
    if (!identity) throw Object.assign(new Error('agent_isolation_unavailable'), { code: 'agent_isolation_unavailable' });
    const material = Object.freeze({ materializationKey: input.operation.operationAcceptance?.operationId
        ?? input.operation.actionRequestId ?? input.directory,
        environment: Object.freeze({}), selectedMaterials: Object.freeze([]) });
    const native = await input.nativeOperationRuntime.prepareNativeOperation({ requesterIdentity: identity,
        ingress: input.ingress, signal: input.operation.signal, readMaterial: () => material, allowMemberPreparation: false });
    try {
        if (!native.memberIdentity) throw Object.assign(new Error('agent_isolation_unavailable'), { code: 'agent_isolation_unavailable' });
        const retained = await prepareSessionDirectoryRemovalAsMember({ agentIsolation: native.agentIsolation, requesterIdentity: identity,
            workspaceRoot: native.memberIdentity.workspaceRoot, directory: input.directory, signal: input.operation.signal,
            prepareRemoval: reads => input.prepareRemoval(reads, { requesterIdentity: identity, agentIsolation: native.agentIsolation }) });
        return { remove: () => retained.remove(), dispose: async () => {
            try { await retained.dispose(); } finally { await native.dispose(); }
        } };
    } catch (error) { await native.dispose(); throw error; }
}
