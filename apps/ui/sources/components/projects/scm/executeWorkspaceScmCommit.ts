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
import { machineScmCommitCreate, machineScmCommitUndoLast } from '@/sync/ops/scm/machineScm';
import { runWorkspaceScmMutation } from '@/scm/operations/runSessionScmMutation';
import { SCM_OPERATION_ERROR_CODES, createScmOperationUnknownOutcome, normalizeScmOperationOutcome } from '@happier-dev/protocol/scm';

export async function executeWorkspaceScmCommitUndoLast(input: Readonly<{
    scope: WorkspaceScopeBase;
    expectedHeadOid: string;
    refreshScmData: () => Promise<void>;
}>) {
    return runWorkspaceScmMutation({
        state: storage.getState(),
        scope: input.scope,
        cwd: input.scope.rootPath,
        operation: 'commit_undo',
        fallbackError: t('sessionGitPane.flow.undo.failed'),
        run: () => machineScmCommitUndoLast(input.scope.machineId, {
            cwd: input.scope.rootPath,
            expectedHeadOid: input.expectedHeadOid,
        }, { serverId: input.scope.serverId }),
        refreshAfterMutation: async () => {
            await input.refreshScmData();
            // Snapshot controllers retain failure state and resolve their refresh promise.
            const refreshError = storage.getState().getWorkspaceScmSnapshotError(input.scope);
            if (refreshError) throw new Error(refreshError.message);
        },
    });
}

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
                const outcome = normalizeScmOperationOutcome(response);
                const effect = 'effect' in outcome ? outcome.effect : undefined;
                const createdCommitSha = effect?.kind === 'commit' ? effect.commitSha : undefined;
                if (createdCommitSha) {
                    storage.getState().clearWorkspaceScmCommitSelectionPaths(input.scope);
                    storage.getState().clearWorkspaceScmCommitSelectionPatches(input.scope);
                }
                if (outcome.kind !== 'succeeded') {
                    tryShowDaemonUnavailableAlertForScmOperationFailure({
                        errorCode: outcome.kind === 'failed' ? response.errorCode : undefined,
                        onRetry: () => {
                            void executeWorkspaceScmCommit(input);
                        },
                        shouldContinue: input.shouldContinue ?? null,
                    });
                    const errorMessage = buildScmCommitFailureMessage({
                        errorCode: response.errorCode,
                        error: response.error,
                        commitSha: createdCommitSha,
                    });
                    reportWorkspaceScmOperation({
                        state: storage.getState(),
                        scope: input.scope,
                        operation: 'commit',
                        status: 'failed',
                        outcome,
                        detail: errorMessage,
                        rawError: response.error,
                        errorCode: response.errorCode,
                        surface: 'files',
                        tracking: input.tracking,
                    });
                    if (!createdCommitSha && outcome.kind !== 'outcome_unknown') return;
                } else {
                    didSucceed = true;
                    reportWorkspaceScmOperation({
                        state: storage.getState(), scope: input.scope, operation: 'commit', status: 'success',
                        outcome, detail: createdCommitSha || undefined, surface: 'files', tracking: input.tracking,
                    });
                }

                input.setScmOperationStatus(t('files.refreshingRepository'));
                try {
                    await input.refreshScmData();
                } catch (refreshError) {
                    const refreshMessage = getScmUserFacingError({
                        error: refreshError instanceof Error ? refreshError.message : String(refreshError ?? ''),
                        fallback: createdCommitSha ? t('files.commitRefreshFailed', { sha: createdCommitSha }) : outcome.message ?? t('common.error'),
                    });
                    reportWorkspaceScmOperation({
                        state: storage.getState(),
                        scope: input.scope,
                        operation: 'refresh',
                        status: 'failed',
                        detail: refreshMessage,
                        rawError: refreshError instanceof Error ? refreshError.message : String(refreshError ?? ''),
                        errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED,
                        outcome: createdCommitSha ? {
                            v: 1, kind: 'effect_applied_with_warning', errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED,
                            effect: { kind: 'commit', commitSha: createdCommitSha }, nextActions: [{ kind: 'refresh' }],
                        } : outcome.kind === 'outcome_unknown' ? outcome : undefined,
                        surface: 'files',
                        tracking: input.tracking,
                    });
                    return;
                }

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
                    outcome: createScmOperationUnknownOutcome({ kind: 'repository_status', cwd: input.scope.rootPath }),
                    surface: 'files',
                    tracking: input.tracking,
                });
                tryShowDaemonUnavailableAlertForRpcError({
                    error,
                    shouldContinue: input.shouldContinue ?? null,
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

    return { ok: didSucceed };
}
