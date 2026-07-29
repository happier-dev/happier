import { Modal } from '@/modal';
import { t } from '@/text';

import { buildScmCommitFailureMessage } from '@/scm/operations/commitFailureMessage';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { withWorkspaceScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportWorkspaceScmOperation, type ScmOperationTracker, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tryShowDaemonUnavailableAlertForRpcError } from '@/utils/errors/daemonUnavailableAlert';
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';

import { resolveCommitScopeForStrategy, isAtomicCommitStrategy, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { storage } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';
import { machineScmCommitCreate } from '@/sync/ops/scm/machineScm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

export async function executeWorkspaceScmCommit(input: Readonly<{
    scope: WorkspaceScopeBase;
    commitMessage: string;
    scmCommitStrategy: ScmCommitStrategy;
    commitSelectionPaths: string[];
    commitSelectionPatches: ScmCommitSelectionPatch[];
    refreshScmData: () => Promise<void>;
    setScmOperationBusy: (busy: boolean) => void;
    setScmOperationStatus: (status: string | null) => void;
    tracking: ScmOperationTracker | null;
    shouldContinue?: () => boolean;
}>): Promise<{ ok: boolean }> {
    let didSucceed = false;
    const lockResult = await withWorkspaceScmOperationLock({
        state: storage.getState(),
        scope: input.scope,
        operation: 'commit',
        run: async () => {
            input.setScmOperationBusy(true);
            try {
                const scopeRequest = resolveCommitScopeForStrategy(input.scmCommitStrategy, {
                    selectedPaths: input.commitSelectionPaths,
                });
                const includePatches = isAtomicCommitStrategy(input.scmCommitStrategy) && input.commitSelectionPatches.length > 0;
                const requestScope = includePatches ? undefined : scopeRequest;

                const response = await machineScmCommitCreate(input.scope.machineId, {
                    cwd: input.scope.rootPath,
                    message: input.commitMessage,
                    ...(requestScope ? { scope: requestScope } : {}),
                    ...(includePatches ? { patches: input.commitSelectionPatches } : {}),
                }, {
                    serverId: input.scope.serverId,
                });
                if (!response.success) {
                    const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                        errorCode: response.errorCode,
                        onRetry: () => {
                            void executeWorkspaceScmCommit(input);
                        },
                        shouldContinue: input.shouldContinue ?? null,
                    });
                    if (shownDaemonUnavailable) return;

                    const errorMessage = buildScmCommitFailureMessage({
                        errorCode: response.errorCode,
                        error: response.error,
                        commitSha: response.commitSha,
                    });
                    reportWorkspaceScmOperation({
                        state: storage.getState(),
                        scope: input.scope,
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
                    await input.refreshScmData();
                } catch (refreshError) {
                    const refreshMessage = getScmUserFacingError({
                        error: refreshError instanceof Error ? refreshError.message : String(refreshError ?? ''),
                        fallback: 'Commit was created, but repository refresh failed. Resolve the issue and try refreshing source control status.',
                    });
                    reportWorkspaceScmOperation({
                        state: storage.getState(),
                        scope: input.scope,
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

                storage.getState().clearWorkspaceScmCommitSelectionPaths(input.scope);
                storage.getState().clearWorkspaceScmCommitSelectionPatches(input.scope);
                reportWorkspaceScmOperation({
                    state: storage.getState(),
                    scope: input.scope,
                    operation: 'commit',
                    status: 'success',
                    detail: response.commitSha || undefined,
                    surface: 'files',
                    tracking: input.tracking,
                });
                didSucceed = true;
            } catch (error) {
                const fallbackMessage = getScmUserFacingError({
                    error: error instanceof Error ? error.message : String(error ?? ''),
                    fallback: 'Failed to create commit',
                });
                reportWorkspaceScmOperation({
                    state: storage.getState(),
                    scope: input.scope,
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
                        void executeWorkspaceScmCommit(input);
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
        return { ok: false };
    }

    return { ok: didSucceed };
}
