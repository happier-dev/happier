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
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';
import { isScmActionNotRun } from '@/sync/ops/scm/scmActionInvocation';

export async function applyFileStageAction(input: Readonly<{
    sessionId: string;
    serverId?: string;
    sessionPath: string | null;
    filePath: string;
    snapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    commitStrategy: ScmCommitStrategy;
    stage: boolean;
    surface: 'file' | 'files';
    refreshAll?: () => Promise<void>;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const {
        sessionId,
        serverId,
        sessionPath,
        filePath,
        snapshot,
        scmWriteEnabled,
        commitStrategy,
        stage,
        surface,
        refreshAll,
    } = input;

    if (isAtomicCommitStrategy(commitStrategy)) {
        if (!stage) {
            storage.getState().unmarkSessionProjectScmCommitSelectionPaths(sessionId, [filePath], serverId);
            storage.getState().removeSessionProjectScmCommitSelectionPatch(sessionId, filePath, serverId);
            reportSessionScmOperation({
                state: storage.getState(),
                sessionId,
                ...(serverId ? { serverId } : {}),
                operation: 'unstage',
                status: 'success',
                path: filePath,
                detail: `${filePath} removed from commit selection`,
                surface,
                tracking,
            });
            return;
        }

        storage.getState().markSessionProjectScmCommitSelectionPaths(sessionId, [filePath], serverId);
        storage.getState().removeSessionProjectScmCommitSelectionPatch(sessionId, filePath, serverId);
        reportSessionScmOperation({
            state: storage.getState(),
            sessionId,
            ...(serverId ? { serverId } : {}),
            operation: 'stage',
            status: 'success',
            path: filePath,
            detail: `${filePath} selected for commit`,
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
        ...(serverId ? { serverId } : {}),
        operation: stage ? 'stage' : 'unstage',
        run: async () => {
            const runScmOperation = async () => stage
                ? await sessionScmChangeInclude(sessionId, { paths: [filePath] }, serverId)
                : await sessionScmChangeExclude(sessionId, { paths: [filePath] }, serverId);
            let response = await runScmOperation();

            if (!response.success) {
                if (sessionPath) {
                    response = await runScmOperationWithGitIndexLockRecovery({
                        cwd: sessionPath,
                        failedResponse: response,
                        removeIndexLock: (request) => sessionScmRepositoryRemoveIndexLock(sessionId, request, serverId),
                        retryOriginalOperation: runScmOperation,
                    });
                }
            }

            if (isScmActionNotRun(response)) return;

            if (!response.success) {
                const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                    errorCode: response.errorCode,
                    onRetry: () => {
                        void applyFileStageAction(input);
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
                    state: storage.getState(),
                    sessionId,
                    ...(serverId ? { serverId } : {}),
                    operation: stage ? 'stage' : 'unstage',
                    status: 'failed',
                    path: filePath,
                    detail: errorMessage,
                    rawError: response.error,
                    errorCode: response.errorCode,
                    surface,
                    tracking,
                });
                Modal.alert(t('common.error'), errorMessage);
                return;
            }

            reportSessionScmOperation({
                state: storage.getState(),
                sessionId,
                ...(serverId ? { serverId } : {}),
                operation: stage ? 'stage' : 'unstage',
                status: 'success',
                path: filePath,
                detail: filePath,
                surface,
                tracking,
            });
            await scmStatusSync.invalidateFromMutationAndAwait(sessionId, serverId);
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
