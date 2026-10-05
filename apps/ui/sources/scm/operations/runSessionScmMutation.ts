import { SCM_OPERATION_ERROR_CODES, createScmOperationUnknownOutcome, normalizeScmOperationOutcome, ScmOperationErrorCodeSchema, type ScmOperationErrorCode, type ScmOperationOutcome } from '@happier-dev/protocol/scm';

import { runScmOperationWithGitIndexLockRecovery } from '@/scm/operations/gitIndexLockRecovery';
import { reportSessionScmOperation, reportWorkspaceScmOperation } from '@/scm/operations/reporting';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { withSessionProjectScmOperationLock, withWorkspaceScmOperationLock } from '@/scm/operations/withOperationLock';
import { sessionScmRepositoryRemoveIndexLock } from '@/sync/ops/sessionScm';
import { machineScmRepositoryRemoveIndexLock } from '@/sync/ops/scm/machineScm';
import type { ScmProjectOperationKind } from '@/sync/runtime/orchestration/projectManager';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type ScmMutationResponse = Readonly<{ success: boolean; error?: string; stderr?: string; errorCode?: ScmOperationErrorCode | string; outcome?: ScmOperationOutcome; commitSha?: string }>;
type ScmMutationFailureResponse = Readonly<{ success: false; error: string; errorCode: ScmOperationErrorCode; outcome: ScmOperationOutcome }>;

type ScmMutationState = Parameters<typeof withSessionProjectScmOperationLock>[0]['state']
    & Parameters<typeof reportSessionScmOperation>[0]['state'];
type WorkspaceScmMutationState = Parameters<typeof withWorkspaceScmOperationLock>[0]['state']
    & Parameters<typeof reportWorkspaceScmOperation>[0]['state'];

type ScmMutationInput<T extends ScmMutationResponse> = Readonly<{
    operation: ScmProjectOperationKind;
    cwd: string | null;
    run: () => Promise<T | 'cancelled'>;
    fallbackError: string;
    successDetail?: (response: T) => string | undefined;
    /** Reconcile changed or uncertain repository state without replaying the mutation. */
    refreshAfterMutation?: () => Promise<void>;
    setScmOperationBusy?: (busy: boolean) => void;
    setScmOperationStatus?: (status: string | null) => void;
}>;
type SessionScmMutationInput<T extends ScmMutationResponse> = ScmMutationInput<T> & Readonly<{
    state: ScmMutationState;
    sessionId: string;
    serverId?: string;
}>;
type WorkspaceScmMutationInput<T extends ScmMutationResponse> = ScmMutationInput<T> & Readonly<{
    state: WorkspaceScmMutationState;
    scope: WorkspaceScopeBase;
}>;

export type RunSessionScmMutationResult<T> =
    | Readonly<{ started: false; message: string }>
    | Readonly<{ started: true; response: T | ScmMutationFailureResponse | 'cancelled' }>;

/**
 * One session SCM write, run the way the Git pane shows it: under the project operation lock (queued/running
 * in the outcome line), with the stale `index.lock` recovery offer, and its result appended to the operation
 * log (success or a classified failure). It never raises a modal for a failure — the pane's outcome line reads
 * the log. A lock held by another operation returns `started: false` without logging anything.
 */
export async function runSessionScmMutation<T extends ScmMutationResponse>(input: SessionScmMutationInput<T>): Promise<RunSessionScmMutationResult<T>> {
    return runScmMutation(input);
}

export async function runWorkspaceScmMutation<T extends ScmMutationResponse>(input: WorkspaceScmMutationInput<T>): Promise<RunSessionScmMutationResult<T>> {
    return runScmMutation(input);
}

async function runScmMutation<T extends ScmMutationResponse>(input: SessionScmMutationInput<T> | WorkspaceScmMutationInput<T>): Promise<RunSessionScmMutationResult<T>> {
    const reportOperation = (report: Omit<Parameters<typeof reportSessionScmOperation>[0], 'state' | 'sessionId' | 'serverId'>) => {
        if ('scope' in input) reportWorkspaceScmOperation({ ...report, state: input.state, scope: input.scope });
        else reportSessionScmOperation({ ...report, state: input.state, sessionId: input.sessionId, serverId: input.serverId });
    };
    const executeMutation = async (): Promise<T | ScmMutationFailureResponse | 'cancelled'> => {
        let response: T | ScmMutationFailureResponse;
        try {
            const first = await input.run();
            if (first === 'cancelled') return first;
            response = first;
            const firstOutcome = normalizeScmOperationOutcome({ ...response, errorCode: ScmOperationErrorCodeSchema.safeParse(response.errorCode).data });
            if (firstOutcome.kind === 'failed' && input.cwd) {
                const cwd = input.cwd;
                const retried = await runScmOperationWithGitIndexLockRecovery({
                    cwd,
                    failedResponse: response,
                    removeIndexLock: (request) => 'scope' in input
                        ? machineScmRepositoryRemoveIndexLock(input.scope.machineId, request, { serverId: input.scope.serverId })
                        : sessionScmRepositoryRemoveIndexLock(input.sessionId, request, input.serverId),
                    retryOriginalOperation: async () => {
                        const again = await input.run();
                        return again === 'cancelled' ? response : again;
                    },
                });
                response = retried;
            }
        } catch (error) {
            response = {
                success: false,
                error: error instanceof Error ? error.message : String(error ?? ''),
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                outcome: createScmOperationUnknownOutcome({ kind: 'repository_status', ...(input.cwd ? { cwd: input.cwd } : {}) }),
            };
        }
        const outcome = normalizeScmOperationOutcome({ ...response, errorCode: ScmOperationErrorCodeSchema.safeParse(response.errorCode).data });
        response = { ...response, outcome };
        const errorCode = 'errorCode' in outcome ? outcome.errorCode : undefined;
        const requiresReconciliation = outcome.kind === 'succeeded'
            || outcome.kind === 'conflicted'
            || outcome.kind === 'effect_applied_with_warning'
            || outcome.kind === 'outcome_unknown'
            || outcome.repositoryState !== undefined;
        const refresh = requiresReconciliation ? input.refreshAfterMutation : undefined;
        if (refresh) {
            try {
                await refresh();
            } catch (error) {
                // A failed read cannot erase a known conflict, warning, or indeterminate write.
                // Its snapshot owner keeps the read error alongside the retained repository state.
                if (outcome.kind === 'succeeded') {
                    const refreshOutcome: ScmOperationOutcome = outcome.effect ? {
                        v: 1, kind: 'effect_applied_with_warning', effect: outcome.effect,
                        errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED, nextActions: [{ kind: 'refresh' }],
                    } : createScmOperationUnknownOutcome({ kind: 'repository_status', ...(input.cwd ? { cwd: input.cwd } : {}) });
                    reportOperation({
                        operation: input.operation, status: 'failed', outcome: refreshOutcome,
                        errorCode: refreshOutcome.errorCode,
                        detail: error instanceof Error ? error.message : String(error ?? ''),
                        surface: 'update', tracking: null,
                    });
                    return response;
                }
            }
        }
        if (outcome.kind !== 'succeeded') {
            reportOperation({
                operation: input.operation,
                status: 'failed',
                outcome,
                detail: getScmUserFacingError({ errorCode, error: response.error, fallback: response.error || input.fallbackError }),
                ...(response.error ? { rawError: response.error } : {}),
                ...(errorCode ? { errorCode } : {}),
                surface: 'update',
                tracking: null,
            });
            return response;
        }
        const detail = input.successDetail?.(response as T);
        reportOperation({
            operation: input.operation, status: 'success', outcome,
            ...(detail ? { detail } : {}), surface: 'update', tracking: null,
        });
        return response;
    };
    const run = async () => {
        input.setScmOperationBusy?.(true);
        try {
            return await executeMutation();
        } finally {
            input.setScmOperationBusy?.(false);
            input.setScmOperationStatus?.(null);
        }
    };
    const lock = 'scope' in input
        ? await withWorkspaceScmOperationLock({ state: input.state, scope: input.scope, operation: input.operation, run })
        : await withSessionProjectScmOperationLock({ state: input.state, sessionId: input.sessionId, serverId: input.serverId, operation: input.operation, run });
    if (!lock.started) return { started: false, message: lock.message };
    return { started: true, response: lock.value };
}
