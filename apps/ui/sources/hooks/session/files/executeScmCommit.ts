import { Modal } from '@/modal';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import {
    isAtomicCommitStrategy,
    resolveCommitScopeForStrategy,
    type ScmCommitStrategy,
} from '@/scm/settings/commitStrategy';
import { buildScmCommitFailureMessage } from '@/scm/operations/commitFailureMessage';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation, type ScmOperationTracker, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { storage } from '@/sync/domains/state/storage';
import { sessionScmCommitCreate } from '@/sync/ops';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { tryShowDaemonUnavailableAlertForRpcError } from '@/utils/errors/daemonUnavailableAlert';
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';

export async function executeScmCommit(input: {
    sessionId: string;
    commitMessage: string;
    scmCommitStrategy: ScmCommitStrategy;
    commitSelectionPaths: string[];
    commitSelectionPatches: Array<{ path: string; patch: string }>;
    loadCommitHistory: (opts?: { reset?: boolean }) => Promise<void>;
    setScmOperationBusy: (busy: boolean) => void;
    setScmOperationStatus: (status: string | null) => void;
    tracking: ScmOperationTracker | null;
    shouldContinue?: () => boolean;
}): Promise<void> {
    const lockResult = await withSessionProjectScmOperationLock({
        state: storage.getState(),
        sessionId: input.sessionId,
        operation: 'commit',
        run: async () => {
            input.setScmOperationBusy(true);
            try {
                const scope = resolveCommitScopeForStrategy(input.scmCommitStrategy, {
                    selectedPaths: input.commitSelectionPaths,
                });
                const includePatches = isAtomicCommitStrategy(input.scmCommitStrategy)
                    && input.commitSelectionPatches.length > 0;
                const requestScope = includePatches && input.commitSelectionPaths.length === 0
                    ? undefined
                    : scope;
                const response = await sessionScmCommitCreate(input.sessionId, {
                    message: input.commitMessage,
                    ...(requestScope ? { scope: requestScope } : {}),
                    ...(includePatches ? { patches: input.commitSelectionPatches } : {}),
                });

                if (!response.success) {
                    const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                        errorCode: response.errorCode,
                        onRetry: () => {
                            void executeScmCommit(input);
                        },
                        shouldContinue: input.shouldContinue ?? null,
                    });
                    if (shownDaemonUnavailable) return;

                    const errorMessage = buildScmCommitFailureMessage({
                        errorCode: response.errorCode,
                        error: response.error,
                        commitSha: response.commitSha,
                    });
                    reportSessionScmOperation({
                        state: storage.getState(),
                        sessionId: input.sessionId,
                        operation: 'commit',
                        status: 'failed',
                        detail: errorMessage,
                        rawError: response.error,
                        errorCode: response.errorCode,
                        surface: 'files',
                        tracking: input.tracking,
                    });
                    Modal.alert(t('common.error'), errorMessage);
                    return;
                }

                input.setScmOperationStatus('Refreshing repository status…');
                try {
                    await scmStatusSync.invalidateFromMutationAndAwait(input.sessionId);
                    await input.loadCommitHistory({ reset: true });
                } catch (refreshError) {
                    const refreshMessage = getScmUserFacingError({
                        error: refreshError instanceof Error ? refreshError.message : String(refreshError ?? ''),
                        fallback: 'Commit was created, but repository refresh failed. Resolve the issue and try refreshing source control status.',
                    });
                    reportSessionScmOperation({
                        state: storage.getState(),
                        sessionId: input.sessionId,
                        operation: 'commit',
                        status: 'failed',
                        detail: refreshMessage,
                        rawError: refreshError instanceof Error ? refreshError.message : String(refreshError ?? ''),
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        surface: 'files',
                        tracking: input.tracking,
                    });
                    Modal.alert(t('common.error'), refreshMessage);
                    return;
                }

                storage.getState().clearSessionProjectScmCommitSelectionPaths(input.sessionId);
                storage.getState().clearSessionProjectScmCommitSelectionPatches(input.sessionId);
                reportSessionScmOperation({
                    state: storage.getState(),
                    sessionId: input.sessionId,
                    operation: 'commit',
                    status: 'success',
                    detail: response.commitSha || undefined,
                    surface: 'files',
                    tracking: input.tracking,
                });
            } catch (error) {
                const fallbackMessage = getScmUserFacingError({
                    error: error instanceof Error ? error.message : String(error ?? ''),
                    fallback: 'Failed to create commit',
                });
                reportSessionScmOperation({
                    state: storage.getState(),
                    sessionId: input.sessionId,
                    operation: 'commit',
                    status: 'failed',
                    detail: fallbackMessage,
                    rawError: error instanceof Error ? error.message : String(error ?? ''),
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    surface: 'files',
                    tracking: input.tracking,
                });
                const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForRpcError({
                    error,
                    onRetry: () => {
                        void executeScmCommit(input);
                    },
                    shouldContinue: input.shouldContinue ?? null,
                });
                if (!shownDaemonUnavailable) {
                    Modal.alert(t('common.error'), fallbackMessage);
                }
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
    }
}
