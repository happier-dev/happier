import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { machineScmChangeDiscard } from '@/sync/ops/scm/machineScm';
import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { withWorkspaceScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportWorkspaceScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';

export async function applyWorkspaceFileDiscardAction(input: Readonly<{
    scope: WorkspaceScopeBase;
    machineId: string;
    rootPath: string;
    file: Pick<ScmFileStatus, 'fullPath' | 'status'>;
    snapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    commitStrategy: ScmCommitStrategy;
    surface: 'file' | 'files';
    refreshAll?: () => Promise<void>;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const preflight = evaluateScmOperationPreflight({
        intent: 'discard',
        scmWriteEnabled: input.scmWriteEnabled,
        sessionPath: input.rootPath,
        snapshot: input.snapshot,
        commitStrategy: input.commitStrategy,
    });
    if (!preflight.allowed) {
        trackBlockedScmOperation({
            operation: 'discard',
            reason: 'preflight',
            message: preflight.message,
            surface: input.surface,
            tracking: null,
        });
        Modal.alert(t('common.error'), preflight.message);
        return;
    }

    const confirmed = await Modal.confirm(
        t('common.discardChanges'),
        input.file.fullPath,
        {
            cancelText: t('common.cancel'),
            confirmText: t('common.discard'),
            destructive: true,
        }
    );
    if (!confirmed) return;

    const lockResult = await withWorkspaceScmOperationLock({
        state: storage.getState(),
        scope: input.scope,
        operation: 'discard',
        run: async () => {
            const response = await machineScmChangeDiscard(input.machineId, {
                cwd: input.rootPath,
                entries: [{ path: input.file.fullPath, kind: input.file.status }],
            }, {
                serverId: input.scope.serverId,
            });

            if (!response.success) {
                const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                    errorCode: response.errorCode,
                    onRetry: () => {
                        void applyWorkspaceFileDiscardAction(input);
                    },
                    shouldContinue: input.shouldContinue ?? null,
                });
                if (shownDaemonUnavailable) return;

                const errorMessage = getScmUserFacingError({
                    errorCode: response.errorCode,
                    error: response.error,
                    fallback: response.error || 'Source-control operation failed',
                });
                reportWorkspaceScmOperation({
                    state: storage.getState(),
                    scope: input.scope,
                    operation: 'discard',
                    status: 'failed',
                    path: input.file.fullPath,
                    detail: errorMessage,
                    rawError: response.error,
                    errorCode: response.errorCode,
                    surface: input.surface,
                    tracking: null,
                });
                Modal.alert(t('common.error'), errorMessage);
                return;
            }

            reportWorkspaceScmOperation({
                state: storage.getState(),
                scope: input.scope,
                operation: 'discard',
                status: 'success',
                path: input.file.fullPath,
                detail: input.file.fullPath,
                surface: input.surface,
                tracking: null,
            });
            if (input.refreshAll) {
                await input.refreshAll();
            }
        },
    });

    if (!lockResult.started) {
        trackBlockedScmOperation({
            operation: 'discard',
            reason: 'lock',
            message: lockResult.message,
            surface: input.surface,
            tracking: null,
        });
        Modal.alert(t('common.error'), lockResult.message);
    }
}
