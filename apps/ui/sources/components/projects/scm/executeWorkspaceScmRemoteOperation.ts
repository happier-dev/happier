import { Modal } from '@/modal';
import { t } from '@/text';

import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import {
    buildNonFastForwardFetchPromptDialog,
    buildRemoteConfirmDialog,
    buildRemoteOperationBusyLabel,
    buildRemoteOperationSuccessDetail,
} from '@/scm/operations/remoteFeedback';
import { inferRemoteTargetFromSnapshot } from '@/scm/operations/remoteTarget';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { withWorkspaceScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportWorkspaceScmOperation, type ScmOperationTracker, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmPushRejectPolicy, ScmRemoteConfirmPolicy } from '@/scm/settings/preferences';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { machineScmRemoteFetch, machineScmRemotePull, machineScmRemotePush } from '@/sync/ops/scm/machineScm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

type WorkspaceRemoteOperationKind = 'fetch' | 'pull' | 'push';

export async function executeWorkspaceScmRemoteOperation(input: Readonly<{
    kind: WorkspaceRemoteOperationKind;
    scope: WorkspaceScopeBase;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    scmRemoteConfirmPolicy: ScmRemoteConfirmPolicy;
    scmPushRejectPolicy: ScmPushRejectPolicy;
    refreshScmData: () => Promise<void>;
    setScmOperationBusy: (busy: boolean) => void;
    setScmOperationStatus: (status: string | null) => void;
    tracking: ScmOperationTracker | null;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const preflight = evaluateScmOperationPreflight({
        intent: input.kind,
        scmWriteEnabled: input.scmWriteEnabled,
        sessionPath: input.scope.rootPath,
        snapshot: input.scmSnapshot,
        commitStrategy: input.scmCommitStrategy,
    });
    if (!preflight.allowed) {
        trackBlockedScmOperation({
            operation: input.kind,
            reason: 'preflight',
            message: preflight.message,
            surface: 'files',
            tracking: input.tracking,
        });
        Modal.alert(t('common.error'), preflight.message);
        return;
    }

    const remoteTarget = inferRemoteTargetFromSnapshot(input.scmSnapshot);
    let shouldOfferFetchAfterPushReject = false;
    const isPullOrPush = input.kind === 'pull' || input.kind === 'push';
    const shouldConfirmRemote = isPullOrPush
        ? input.scmRemoteConfirmPolicy === 'always'
            || (input.scmRemoteConfirmPolicy === 'push_only' && input.kind === 'push')
        : false;

    if (isPullOrPush && shouldConfirmRemote) {
        const dialog = buildRemoteConfirmDialog({
            kind: input.kind,
            target: remoteTarget,
            detachedHeadLabel: t('files.detachedHead'),
        });
        const confirmed = await Modal.confirm(
            dialog.title,
            dialog.body,
            { confirmText: dialog.confirmText, cancelText: dialog.cancelText },
        );
        if (!confirmed) return;
    }

    const lockResult = await withWorkspaceScmOperationLock({
        state: storage.getState(),
        scope: input.scope,
        operation: input.kind,
        run: async () => {
            input.setScmOperationBusy(true);
            input.setScmOperationStatus(buildRemoteOperationBusyLabel(input.kind, remoteTarget, t('files.detachedHead')));
            try {
                const response = input.kind === 'fetch'
                    ? await machineScmRemoteFetch(input.scope.machineId, {
                        cwd: input.scope.rootPath,
                        remote: remoteTarget.remote,
                    })
                    : input.kind === 'pull'
                        ? await machineScmRemotePull(input.scope.machineId, {
                            cwd: input.scope.rootPath,
                            remote: remoteTarget.remote,
                            branch: remoteTarget.branch ?? undefined,
                        })
                        : await machineScmRemotePush(input.scope.machineId, {
                            cwd: input.scope.rootPath,
                            remote: remoteTarget.remote,
                            branch: remoteTarget.branch ?? undefined,
                        });

                if (!response.success) {
                    const message = getScmUserFacingError({
                        errorCode: response.errorCode,
                        error: response.error,
                        fallback: response.error || `Failed to ${input.kind}`,
                    });
                    if (
                        input.kind === 'push'
                        && response.errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD
                    ) {
                        shouldOfferFetchAfterPushReject = true;
                    }
                    reportWorkspaceScmOperation({
                        state: storage.getState(),
                        scope: input.scope,
                        operation: input.kind,
                        status: 'failed',
                        detail: message,
                        rawError: response.error,
                        errorCode: response.errorCode,
                        surface: 'files',
                        tracking: input.tracking,
                    });
                    const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                        errorCode: response.errorCode,
                        onRetry: () => {
                            void executeWorkspaceScmRemoteOperation(input);
                        },
                        shouldContinue: input.shouldContinue ?? null,
                    });
                    if (!shownDaemonUnavailable) {
                        Modal.alert(t('common.error'), message);
                    }
                    return;
                }

                reportWorkspaceScmOperation({
                    state: storage.getState(),
                    scope: input.scope,
                    operation: input.kind,
                    status: 'success',
                    detail: buildRemoteOperationSuccessDetail(
                        input.kind,
                        remoteTarget,
                        response.stdout ?? '',
                        t('files.detachedHead'),
                    ),
                    surface: 'files',
                    tracking: input.tracking,
                });
                input.setScmOperationStatus('Refreshing repository status…');
                await input.refreshScmData();
            } finally {
                input.setScmOperationBusy(false);
                input.setScmOperationStatus(null);
            }
        },
    });

    if (!lockResult.started) {
        trackBlockedScmOperation({
            operation: input.kind,
            reason: 'lock',
            message: lockResult.message,
            surface: 'files',
            tracking: input.tracking,
        });
        Modal.alert(t('common.error'), lockResult.message);
        return;
    }

    if (shouldOfferFetchAfterPushReject && input.scmPushRejectPolicy === 'auto_fetch') {
        await executeWorkspaceScmRemoteOperation({ ...input, kind: 'fetch' });
        return;
    }

    if (shouldOfferFetchAfterPushReject && input.scmPushRejectPolicy === 'prompt_fetch') {
        const fetchDialog = buildNonFastForwardFetchPromptDialog({
            target: remoteTarget,
            detachedHeadLabel: t('files.detachedHead'),
        });
        const confirmed = await Modal.confirm(
            fetchDialog.title,
            fetchDialog.body,
            { confirmText: fetchDialog.confirmText, cancelText: fetchDialog.cancelText },
        );
        if (confirmed) {
            await executeWorkspaceScmRemoteOperation({ ...input, kind: 'fetch' });
        }
    }
}
