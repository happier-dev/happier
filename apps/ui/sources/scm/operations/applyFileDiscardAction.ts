import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    sessionScmChangeDiscard,
    sessionScmRepositoryRemoveIndexLock,
} from '@/sync/ops';
import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { runScmOperationWithGitIndexLockRecovery } from '@/scm/operations/gitIndexLockRecovery';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { isScmActionNotRun } from '@/sync/ops/scm/scmActionInvocation';
import { tracking } from '@/track';
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';

export async function applyFileDiscardAction(input: Readonly<{
    sessionId: string;
    serverId?: string;
    sessionPath: string | null;
    file: Pick<ScmFileStatus, 'fullPath' | 'status'>;
    snapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    commitStrategy: ScmCommitStrategy;
    surface: 'file' | 'files';
    refreshAll?: () => Promise<void>;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const {
        sessionId,
        serverId,
        sessionPath,
        file,
        snapshot,
        scmWriteEnabled,
        commitStrategy,
        surface,
        refreshAll,
    } = input;

    const preflight = evaluateScmOperationPreflight({
        intent: 'discard',
        scmWriteEnabled,
        sessionPath,
        snapshot,
        commitStrategy,
    });
    if (!preflight.allowed) {
        trackBlockedScmOperation({
            operation: 'discard',
            reason: 'preflight',
            message: preflight.message,
            surface,
            tracking,
        });
        Modal.alert(t('common.error'), preflight.message);
        return;
    }

    // The Action policy owns the discard confirmation (and Settings → Actions can require approval).
    const lockResult = await withSessionProjectScmOperationLock({
        state: storage.getState(),
        sessionId,
        ...(serverId ? { serverId } : {}),
        operation: 'discard',
        // The pane shows the discard as work in progress once the confirmed Action is dispatched, not behind its dialog.
        deferRunning: true,
        run: async (markRunning) => {
            const runScmOperation = async () => sessionScmChangeDiscard(sessionId, {
                entries: [{ path: file.fullPath, kind: file.status }],
            }, serverId, { onDispatched: markRunning });
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
                        void applyFileDiscardAction(input);
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
                    operation: 'discard',
                    status: 'failed',
                    path: file.fullPath,
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
                operation: 'discard',
                status: 'success',
                path: file.fullPath,
                detail: file.fullPath,
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
            operation: 'discard',
            reason: 'lock',
            message: lockResult.message,
            surface,
            tracking,
        });
        Modal.alert(t('common.error'), lockResult.message);
    }
}
