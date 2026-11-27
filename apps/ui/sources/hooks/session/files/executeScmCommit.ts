import { Modal } from '@/modal';
import { t } from '@/text';
import {
    isAtomicCommitStrategy,
    resolveCommitScopeForStrategy,
    type ScmCommitStrategy,
} from '@/scm/settings/commitStrategy';
import { buildScmCommitFailureMessage } from '@/scm/operations/commitFailureMessage';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation, type ScmOperationTracker, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { storage } from '@/sync/domains/state/storageStore';
import { sessionScmCommitCreate, sessionScmRepositoryRemoveIndexLock } from '@/sync/ops/sessionScm';
import { SCM_OPERATION_ERROR_CODES, createScmOperationUnknownOutcome, normalizeScmOperationOutcome, type ScmOperationOutcome } from '@happier-dev/protocol/scm';
import { runScmOperationWithGitIndexLockRecovery } from '@/scm/operations/gitIndexLockRecovery';
import { isScmActionNotRun, readUiScmActionFailure } from '@/sync/ops/scm/scmActionInvocation';

export async function executeScmCommit(input: {
    sessionId: string;
    serverId?: string;
    repoPath: string;
    commitMessage: string;
    scmCommitStrategy: ScmCommitStrategy;
    commitSelectionPaths: string[];
    commitSelectionPatches: Array<{ path: string; patch: string }>;
    refreshScmData: () => Promise<void>;
    loadCommitHistory: (opts?: { reset?: boolean }) => Promise<void>;
    setScmOperationBusy: (busy: boolean) => void;
    setScmOperationStatus: (status: string | null) => void;
    tracking: ScmOperationTracker | null;
    shouldContinue?: () => boolean;
}): Promise<{ ok: boolean; errorCode?: string }> {
    let didSucceed = false;
    let failureErrorCode: string | undefined;
    let createdCommitSha: string | undefined;
    let operationFailure: ReturnType<typeof readUiScmActionFailure> = null;
    const showRefreshFailure = (error: unknown, preservedOutcome?: ScmOperationOutcome) => {
        const refreshMessage = createdCommitSha ? t('files.commitRefreshFailed', { sha: createdCommitSha }) : preservedOutcome?.message;
        reportSessionScmOperation({
            failure: operationFailure ?? readUiScmActionFailure(error) ?? undefined,
            state: storage.getState(),
            sessionId: input.sessionId, serverId: input.serverId,
            operation: 'refresh',
            status: 'failed',
            detail: refreshMessage,
            rawError: error instanceof Error ? error.message : String(error ?? ''),
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            ...(createdCommitSha ? { outcome: {
                v: 1, kind: 'effect_applied_with_warning', errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED,
                effect: { kind: 'commit', commitSha: createdCommitSha }, nextActions: [{ kind: 'refresh' }], message: refreshMessage,
            } satisfies ScmOperationOutcome } : preservedOutcome ? { outcome: preservedOutcome } : {}),
            surface: 'files',
            tracking: input.tracking,
        });
        // The Git pane's outcome line shows this failed refresh with Try again; the commit itself stands.
    };
    const refreshRepository = async (preservedOutcome?: ScmOperationOutcome): Promise<void> => {
        try {
            input.setScmOperationStatus(t('files.refreshingRepository'));
            await input.refreshScmData();
            await input.loadCommitHistory({ reset: true });
            reportSessionScmOperation({
                state: storage.getState(),
                sessionId: input.sessionId, serverId: input.serverId,
                operation: 'refresh',
                status: 'success',
                surface: 'files',
                tracking: input.tracking,
            });
        } catch (error) {
            showRefreshFailure(error, preservedOutcome);
        }
    };
    const lockResult = await withSessionProjectScmOperationLock({
        state: storage.getState(),
        sessionId: input.sessionId, serverId: input.serverId,
        operation: 'commit',
        run: async () => {
            input.setScmOperationBusy(true);
            try {
                const scope = resolveCommitScopeForStrategy(input.scmCommitStrategy, {
                    selectedPaths: input.commitSelectionPaths,
                });
                const includePatches = isAtomicCommitStrategy(input.scmCommitStrategy)
                    && input.commitSelectionPatches.length > 0;
                const requestScope = includePatches ? undefined : scope;
                const createCommit = () => sessionScmCommitCreate(input.sessionId, {
                    message: input.commitMessage,
                    ...(requestScope ? { scope: requestScope } : {}),
                    ...(includePatches ? { patches: input.commitSelectionPatches } : {}),
                }, input.serverId);
                let response = await createCommit();
                if (normalizeScmOperationOutcome(response).kind === 'failed' && !('commitSha' in response && response.commitSha)) {
                    response = await runScmOperationWithGitIndexLockRecovery({
                        cwd: input.repoPath,
                        failedResponse: response,
                        removeIndexLock: (request) => sessionScmRepositoryRemoveIndexLock(input.sessionId, request, input.serverId),
                        retryOriginalOperation: createCommit,
                    });
                }

                // Declined, or waiting on an approval: nothing ran and nothing failed.
                if (isScmActionNotRun(response)) return;

                const outcome = normalizeScmOperationOutcome(response);
                const effect = 'effect' in outcome ? outcome.effect : undefined;
                createdCommitSha = effect?.kind === 'commit' ? effect.commitSha : undefined;
                if (createdCommitSha) {
                    storage.getState().clearSessionProjectScmCommitSelectionPaths(input.sessionId, input.serverId);
                    storage.getState().clearSessionProjectScmCommitSelectionPatches(input.sessionId, input.serverId);
                }
                if (outcome.kind !== 'succeeded') {
                    operationFailure = readUiScmActionFailure(response);
                    failureErrorCode = response.errorCode;
                    // The composer repairs this prerequisite beside the message and selection.
                    if (failureErrorCode === SCM_OPERATION_ERROR_CODES.COMMIT_IDENTITY_REQUIRED) return;
                    const errorMessage = buildScmCommitFailureMessage({
                        ...response,
                        errorCode: response.errorCode,
                        error: response.error,
                        commitSha: createdCommitSha,
                    });
                    reportSessionScmOperation({
                        failure: operationFailure ?? undefined,
                        state: storage.getState(),
                        sessionId: input.sessionId, serverId: input.serverId,
                        operation: 'commit',
                        status: 'failed',
                        outcome,
                        detail: errorMessage,
                        rawError: response.error,
                        errorCode: response.errorCode,
                        surface: 'files',
                        tracking: input.tracking,
                    });
                    if (createdCommitSha || outcome.kind === 'outcome_unknown') await refreshRepository(outcome);
                    return;
                }

                didSucceed = true;
                reportSessionScmOperation({
                    state: storage.getState(),
                    sessionId: input.sessionId, serverId: input.serverId,
                    operation: 'commit',
                    status: 'success',
                    outcome,
                    detail: createdCommitSha || undefined,
                    surface: 'files',
                    tracking: input.tracking,
                });

                await refreshRepository();
            } catch (error) {
                if (didSucceed || createdCommitSha) {
                    showRefreshFailure(error);
                    return;
                }
                const fallbackMessage = getScmUserFacingError({
                    error: error instanceof Error ? error.message : String(error ?? ''),
                    fallback: 'Failed to create commit',
                });
                reportSessionScmOperation({
                    failure: readUiScmActionFailure(error) ?? undefined,
                    state: storage.getState(),
                    sessionId: input.sessionId, serverId: input.serverId,
                    operation: 'commit',
                    status: 'failed',
                    detail: fallbackMessage,
                    rawError: error instanceof Error ? error.message : String(error ?? ''),
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    outcome: createScmOperationUnknownOutcome({ kind: 'repository_status', cwd: input.repoPath }),
                    surface: 'files',
                    tracking: input.tracking,
                });
            } finally {
                input.setScmOperationBusy(false);
                input.setScmOperationStatus(null);
            }
        },
    });

    if (!lockResult.started) {
        trackBlockedScmOperation({
            operation: 'commit',
            reason: 'lock',
            message: lockResult.message,
            surface: 'files',
            tracking: input.tracking,
        });
        Modal.alert(t('common.error'), lockResult.message);
        return { ok: false };
    }

    return { ok: didSucceed, ...(failureErrorCode ? { errorCode: failureErrorCode } : {}) };
}
