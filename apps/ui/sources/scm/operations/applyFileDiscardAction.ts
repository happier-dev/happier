import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { sessionScmChangeDiscard } from '@/sync/ops';
import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tracking } from '@/track';
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';

export async function applyFileDiscardAction(input: Readonly<{
    sessionId: string;
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

    const confirmed = await Modal.confirm(
        t('common.discardChanges'),
        file.fullPath,
        {
            cancelText: t('common.cancel'),
            confirmText: t('common.discard'),
            destructive: true,
        }
    );
    if (!confirmed) {
        return;
    }

    const lockResult = await withSessionProjectScmOperationLock({
        state: storage.getState(),
        sessionId,
        operation: 'discard',
        run: async () => {
            const response = await sessionScmChangeDiscard(sessionId, {
                entries: [{ path: file.fullPath, kind: file.status }],
            });

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
                    errorCode: response.errorCode,
                    error: response.error,
                    fallback: response.error || 'Source-control operation failed',
                });
                reportSessionScmOperation({
                    state: storage.getState(),
                    sessionId,
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
                operation: 'discard',
                status: 'success',
                path: file.fullPath,
                detail: file.fullPath,
                surface,
                tracking,
            });
            await scmStatusSync.invalidateFromMutationAndAwait(sessionId);
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
