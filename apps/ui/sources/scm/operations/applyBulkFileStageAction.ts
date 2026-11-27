import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    sessionScmChangeExclude,
    sessionScmChangeInclude,
    sessionScmRepositoryRemoveIndexLock,
} from '@/sync/ops';
import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { isAtomicCommitStrategy, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { runScmOperationWithGitIndexLockRecovery } from '@/scm/operations/gitIndexLockRecovery';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tracking } from '@/track';
import { alertScmOperationFailure, tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';
import { buildCommitSelectionPathHints } from './commitSelectionHints';
import { isScmActionNotRun, readUiScmActionFailure } from '@/sync/ops/scm/scmActionInvocation';

export async function applyBulkFileStageAction(input: Readonly<{
    sessionId: string;
    serverId?: string;
    sessionPath: string | null;
    paths: readonly string[];
    snapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    commitStrategy: ScmCommitStrategy;
    stage: boolean;
    surface: 'file' | 'files';
    refreshAll?: () => Promise<void>;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const paths = buildCommitSelectionPathHints({ commitSelectionPaths: input.paths, commitSelectionPatches: [] });
    if (paths.length === 0) return;

    const {
        sessionId,
        serverId,
        sessionPath,
        snapshot,
        scmWriteEnabled,
        commitStrategy,
        stage,
        surface,
        refreshAll,
    } = input;

    if (isAtomicCommitStrategy(commitStrategy)) {
        if (stage) {
            storage.getState().markSessionProjectScmCommitSelectionPaths(sessionId, paths, serverId);
        } else {
            storage.getState().unmarkSessionProjectScmCommitSelectionPaths(sessionId, paths, serverId);
        }
        for (const path of paths) {
            storage.getState().removeSessionProjectScmCommitSelectionPatch(sessionId, path, serverId);
        }
        reportSessionScmOperation({
            state: storage.getState(),
            sessionId,
            ...(serverId ? { serverId } : {}),
            operation: stage ? 'stage' : 'unstage',
            status: 'success',
            detail: stage
                ? `Selected ${paths.length} file(s) for commit`
                : `Removed ${paths.length} file(s) from commit selection`,
            surface,
            tracking,
        });
        return;
    }

    const preflight = evaluateScmOperationPreflight({
        intent: stage ? 'stage' : 'unstage',
        scmWriteEnabled,
        sessionPath,
        snapshot,
        commitStrategy,
    });
    if (!preflight.allowed) {
        trackBlockedScmOperation({
            operation: stage ? 'stage' : 'unstage',
            reason: 'preflight',
            message: preflight.message,
            surface,
            tracking,
        });
        Modal.alert(t('common.error'), preflight.message);
        return;
    }

    const lockResult = await withSessionProjectScmOperationLock({
        state: storage.getState(),
        sessionId,
        serverId,
        operation: stage ? 'stage' : 'unstage',
        run: async () => {
            const runScmOperation = async () => stage
                ? await sessionScmChangeInclude(sessionId, { paths }, ...(serverId === undefined ? [] : [serverId]))
                : await sessionScmChangeExclude(sessionId, { paths }, ...(serverId === undefined ? [] : [serverId]));
            let response = await runScmOperation();

            if (!response.success) {
                if (sessionPath) {
                    response = await runScmOperationWithGitIndexLockRecovery({
                        cwd: sessionPath,
                        failedResponse: response,
                        removeIndexLock: (request) => sessionScmRepositoryRemoveIndexLock(
                            sessionId,
                            request,
                            ...(serverId === undefined ? [] : [serverId]),
                        ),
                        retryOriginalOperation: runScmOperation,
                    });
                }
            }

            if (isScmActionNotRun(response)) return;

            if (!response.success) {
                const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                    failure: readUiScmActionFailure(response),
                    errorCode: response.errorCode,
                    onRetry: () => {
                        void applyBulkFileStageAction(input);
                    },
                    shouldContinue: input.shouldContinue ?? null,
                });
                if (shownDaemonUnavailable) return;

                const errorMessage = getScmUserFacingError({
                    ...response,
                    errorCode: response.errorCode,
                    error: response.error,
                    fallback: response.error || 'Source-control operation failed',
                });
                reportSessionScmOperation({
                    failure: readUiScmActionFailure(response) ?? undefined,
                    state: storage.getState(),
                    sessionId,
                    ...(serverId ? { serverId } : {}),
                    operation: stage ? 'stage' : 'unstage',
                    status: 'failed',
                    detail: errorMessage,
                    rawError: response.error,
                    errorCode: response.errorCode,
                    surface,
                    tracking,
                });
                alertScmOperationFailure({ failure: readUiScmActionFailure(response), message: errorMessage });
                return;
            }

            reportSessionScmOperation({
                state: storage.getState(),
                sessionId,
                ...(serverId ? { serverId } : {}),
                operation: stage ? 'stage' : 'unstage',
                status: 'success',
                detail: `${paths.length} file(s)`,
                surface,
                tracking,
            });
            await scmStatusSync.invalidateFromMutationAndAwait(
                sessionId,
                ...(serverId === undefined ? [] : [serverId]),
            );
            if (refreshAll) {
                await refreshAll();
            }
        },
    });

    if (!lockResult.started) {
        trackBlockedScmOperation({
            operation: stage ? 'stage' : 'unstage',
            reason: 'lock',
            message: lockResult.message,
            surface,
            tracking,
        });
        Modal.alert(t('common.error'), lockResult.message);
    }
}
