import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { sessionScmChangeExclude, sessionScmChangeInclude } from '@/sync/ops';
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
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';

function normalizePaths(paths: readonly string[]): string[] {
    const unique = new Set<string>();
    for (const raw of paths) {
        const normalized = typeof raw === 'string' ? raw.trim() : '';
        if (!normalized) continue;
        unique.add(normalized);
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
}

export async function applyBulkFileStageAction(input: Readonly<{
    sessionId: string;
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
    const paths = normalizePaths(input.paths);
    if (paths.length === 0) return;

    const {
        sessionId,
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
            storage.getState().markSessionProjectScmCommitSelectionPaths(sessionId, paths);
        } else {
            storage.getState().unmarkSessionProjectScmCommitSelectionPaths(sessionId, paths);
        }
        for (const path of paths) {
            storage.getState().removeSessionProjectScmCommitSelectionPatch(sessionId, path);
        }
        reportSessionScmOperation({
            state: storage.getState(),
            sessionId,
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
        operation: stage ? 'stage' : 'unstage',
        run: async () => {
            const response = stage
                ? await sessionScmChangeInclude(sessionId, { paths })
                : await sessionScmChangeExclude(sessionId, { paths });

            if (!response.success) {
                const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                    errorCode: response.errorCode,
                    onRetry: () => {
                        void applyBulkFileStageAction(input);
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
                    operation: stage ? 'stage' : 'unstage',
                    status: 'failed',
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
                detail: `${paths.length} file(s)`,
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
