import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { FILESYSTEM_BROWSER_ACTION_IDS_V1, FilesystemEffectFailureDetailsV1Schema, FilesystemMutationOutputSchema, type FilesystemActionId, type FilesystemMutationActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { projectWorkspaceFileSystemRoute, type WorkspaceFileSystemTarget } from './workspaceTarget';
import type { UiFilesystemActionDelivery } from '@/sync/ops/actions/filesystemActionDeps';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

export type WorkspaceFileSystemFailure = Extract<ReturnType<typeof FilesystemMutationOutputSchema.parse>, { success: false }>;
export type WorkspaceFileSystemMutationResponse =
    | Readonly<{ success: true }>
    | Readonly<WorkspaceFileSystemFailure & { approvalArtifactId?: string }>;

/** Keep only the owning filesystem cause, never arbitrary Action diagnostic payloads. */
export function projectWorkspaceFileSystemActionFailure(failure: ActionExecuteFailure): WorkspaceFileSystemFailure {
    const details = failure.errorCode === 'filesystem_identity_custody_unavailable'
        ? FilesystemEffectFailureDetailsV1Schema.safeParse(failure.details) : null;
    return { success: false, error: failure.error, errorCode: failure.errorCode,
        ...(details?.success ? { details: details.data } : {}) };
}

/** One UI ingress for every filesystem Action; the caller retains result-domain parsing. */
export async function invokeWorkspaceFileSystemAction(
    target: WorkspaceFileSystemTarget,
    actionId: FilesystemActionId,
    input: unknown,
    options?: Readonly<{ signal?: AbortSignal | null; accountId?: string; timeoutMs?: number | null; delivery?: UiFilesystemActionDelivery['execute']; callerContext?: ActionExecutorContext }>,
): Promise<ActionExecuteResult> {
    const route = projectWorkspaceFileSystemRoute(target);
    const actionInput = target.kind === 'managed' && input !== null && typeof input === 'object'
        ? { ...input, workspace: target.workspace }
        : input;
    const lifetime = captureActiveServerAccountScopeLifetime();
    const serverId = route.serverId || lifetime?.scope.serverId;
    if (!serverId) return { ok: false, errorCode: 'action_home_not_found', error: 'action_home_not_found' };
    const activeTarget = lifetime && areServerProfileIdentifiersEquivalent(serverId, lifetime.scope.serverId);
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    if (activeTarget && !lifetime.isCurrent()) return {
        ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed',
    };
    // Filename scans return useful partial pages at their admitted native
    // budget. A competing reply cutoff must not discard that acknowledgement.
    const delivery = options?.delivery ?? (actionId !== FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles && typeof options?.timeoutMs === 'number' ? async (execution: Parameters<UiFilesystemActionDelivery['execute']>[0]) => {
        const { callAdmittedFilesystemActionRpc } = await import('@/sync/ops/actions/filesystemActionDeps');
        return callAdmittedFilesystemActionRpc({ actionId: execution.actionId, machineId: route.machineId,
            serverId, accountId: options.accountId, input: execution.input, context: execution.context,
            timeoutMs: options.timeoutMs, signal: execution.context.signal,
            requestId: execution.context.actionRequestId ?? undefined });
    } : undefined);
    const retirement = delivery ? new AbortController() : null;
    const subscription = retirement && activeTarget ? lifetime.onRetire(() => retirement.abort()) : null;
    const cancellation = retirement || options?.callerContext?.signal ? mergeAbortSignals([
        options?.signal ?? undefined, retirement?.signal, options?.callerContext?.signal,
    ]) : null;
    const signal = cancellation?.signal ?? options?.signal ?? undefined;
    const expectedAccountId = options?.callerContext?.expectedAccountId ?? options?.accountId
        ?? (activeTarget ? lifetime.scope.accountId : undefined);
    const execute = createFrontDoorActionExecute(createDefaultActionExecutor(delivery && signal ? {
        filesystemActionDelivery: { actionId, signal, execute: delivery },
    } : undefined));
    const context: ActionExecutorContext = {
        ...(options?.callerContext ?? { surface: 'ui', authority: 'present_user' }),
        serverId,
        ...(expectedAccountId ? { expectedAccountId } : {}),
        ...(signal ? { signal } : {}),
        externalActionTarget: { kind: 'machine', machineId: route.machineId },
    } as const;
    try {
        // Run-now present-user entry: `execute` alone offers the in-place default confirmation.
        const result = options?.callerContext?.executeOrdinaryChildAction
            ? await options.callerContext.executeOrdinaryChildAction(actionId, actionInput, {
                serverId, ...(expectedAccountId ? { expectedAccountId } : {}),
                ...(signal ? { signal } : {}), externalActionTarget: context.externalActionTarget,
            })
            : await execute(actionId, actionInput, context);
        // Cancellation stays a rejection for mounted byte-delivery callers; `execute` would
        // otherwise settle an aborted approval wait as a typed failure.
        if (!result.ok) signal?.throwIfAborted();
        return result;
    } finally {
        subscription?.dispose();
        cancellation?.dispose();
    }
}

/** Admission owns policy and approval; its existing terminal owns the Machine RPC. */
export async function invokeWorkspaceFileSystemMutation(
    target: WorkspaceFileSystemTarget,
    actionId: Exclude<FilesystemMutationActionId, 'daemon.filesystem.copy'>,
    input: unknown,
    options?: Readonly<{ signal?: AbortSignal; callerContext?: ActionExecutorContext }>,
): Promise<WorkspaceFileSystemMutationResponse> {
    const result = await invokeWorkspaceFileSystemAction(target, actionId, input, options);
    if (!result.ok) return projectWorkspaceFileSystemActionFailure(result);
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) return { success: false, errorCode: 'approval_required',
        error: 'The Action awaits approval.', approvalArtifactId: approval.data.artifactId };
    const parsed = FilesystemMutationOutputSchema.safeParse(result.result);
    return parsed.success ? parsed.data : { success: false, errorCode: 'invalid_action_output',
        error: 'The filesystem Action response could not be validated.' };
}
