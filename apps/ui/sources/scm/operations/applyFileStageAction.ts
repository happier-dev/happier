import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    sessionScmChangeExclude,
    sessionScmChangeInclude,
} from '@/sync/ops';
import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { isAtomicCommitStrategy, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tracking } from '@/track';

export async function applyFileStageAction(input: Readonly<{
    sessionId: string;
    sessionPath: string | null;
    filePath: string;
    snapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    commitStrategy: ScmCommitStrategy;
    stage: boolean;
    surface: 'file' | 'files';
    refreshAll?: () => Promise<void>;
}>): Promise<void> {
    const {
        sessionId,
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
            storage.getState().unmarkSessionProjectScmCommitSelectionPaths(sessionId, [filePath]);
            storage.getState().removeSessionProjectScmCommitSelectionPatch(sessionId, filePath);
            reportSessionScmOperation({
                state: storage.getState(),
                sessionId,
                operation: 'unstage',
                status: 'success',
                path: filePath,
                detail: `${filePath} removed from commit selection`,
                surface,
                tracking,
            });
            return;
        }

        storage.getState().markSessionProjectScmCommitSelectionPaths(sessionId, [filePath]);
        storage.getState().removeSessionProjectScmCommitSelectionPatch(sessionId, filePath);
        reportSessionScmOperation({
            state: storage.getState(),
            sessionId,
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
        operation: stage ? 'stage' : 'unstage',
        run: async () => {
            const response = stage
                ? await sessionScmChangeInclude(sessionId, { paths: [filePath] })
                : await sessionScmChangeExclude(sessionId, { paths: [filePath] });

            if (!response.success) {
                const errorMessage = getScmUserFacingError({
                    errorCode: response.errorCode,
                    error: response.error,
                    fallback: response.error || 'Source-control operation failed',
                });
                reportSessionScmOperation({
                    state: storage.getState(),
                    sessionId,
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
                operation: stage ? 'stage' : 'unstage',
                status: 'success',
                path: filePath,
                detail: filePath,
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
            operation: stage ? 'stage' : 'unstage',
            reason: 'lock',
            message: lockResult.message,
            surface,
            tracking,
        });
        Modal.alert(t('common.error'), lockResult.message);
    }
}

