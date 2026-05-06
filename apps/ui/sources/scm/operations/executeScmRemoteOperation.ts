import { Modal } from '@/modal';
import { t } from '@/text';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import {
    buildNonFastForwardFetchPromptDialog,
    buildRemoteConfirmDialog,
    buildRemoteOperationBusyLabel,
    buildRemoteOperationSuccessDetail,
    type RemoteOperationKind,
    type RemoteTargetDisplay,
} from '@/scm/operations/remoteFeedback';
import { inferRemoteTargetFromSnapshot } from '@/scm/operations/remoteTarget';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { trackBlockedScmOperation, type ScmOperationTracker } from '@/scm/operations/reporting';
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmPushRejectPolicy, ScmRemoteConfirmPolicy } from '@/scm/settings/preferences';
import { shouldConfirmRemoteOperation } from '@/scm/settings/remoteConfirmationPolicy';
import { runScmOperationWithGitIndexLockRecovery } from '@/scm/operations/gitIndexLockRecovery';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    SCM_OPERATION_ERROR_CODES,
    type ScmOperationErrorCode,
    type ScmRemoteResponse,
    type ScmRepositoryRemoveIndexLockRequest,
    type ScmRepositoryRemoveIndexLockResponse,
} from '@happier-dev/protocol';

export type ScmRemoteOperationKind = RemoteOperationKind;

type ScmOperationSurface = 'files' | 'file' | 'commit' | 'update';

type RemoteOperationReportInput = Readonly<{
    operation: ScmRemoteOperationKind;
    status: 'failed' | 'success';
    detail: string;
    rawError?: string;
    errorCode?: ScmOperationErrorCode;
}>;

type ScmRemoteOperationLockResult =
    | { started: false; message: string }
    | { started: true };

export async function executeScmRemoteOperation(input: Readonly<{
    kind: ScmRemoteOperationKind;
    repoPath: string | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    scmRemoteConfirmPolicy: ScmRemoteConfirmPolicy;
    scmPushRejectPolicy: ScmPushRejectPolicy;
    surface: ScmOperationSurface;
    tracking?: ScmOperationTracker | null;
    setScmOperationBusy: (busy: boolean) => void;
    setScmOperationStatus: (status: string | null) => void;
    runWithOperationLock: (
        kind: ScmRemoteOperationKind,
        run: () => Promise<void>,
    ) => Promise<ScmRemoteOperationLockResult>;
    executeRemoteOperation: (
        kind: ScmRemoteOperationKind,
        target: RemoteTargetDisplay,
    ) => Promise<ScmRemoteResponse>;
    removeIndexLock?: (
        request: ScmRepositoryRemoveIndexLockRequest,
    ) => Promise<ScmRepositoryRemoveIndexLockResponse>;
    reportOperation: (input: RemoteOperationReportInput) => void;
    refreshAfterSuccess: (kind: ScmRemoteOperationKind) => Promise<void>;
    shouldContinue?: (() => boolean) | null;
    skipConfirmation?: boolean;
    retrySkipConfirmation?: boolean;
}>): Promise<void> {
    const preflight = evaluateScmOperationPreflight({
        intent: input.kind,
        scmWriteEnabled: input.scmWriteEnabled,
        sessionPath: input.repoPath,
        snapshot: input.scmSnapshot,
        commitStrategy: input.scmCommitStrategy,
    });
    if (!preflight.allowed) {
        trackBlockedScmOperation({
            operation: input.kind,
            reason: 'preflight',
            message: preflight.message,
            surface: input.surface,
            tracking: input.tracking,
        });
        Modal.alert(t('common.error'), preflight.message);
        return;
    }
    if (!input.repoPath) return;
    const repoPath = input.repoPath;

    const remoteTarget = inferRemoteTargetFromSnapshot(input.scmSnapshot);
    let shouldOfferFetchAfterPushReject = false;
    const isPullOrPush = input.kind === 'pull' || input.kind === 'push';
    const shouldConfirmRemote = input.skipConfirmation === true
        ? false
        : shouldConfirmRemoteOperation(input.scmRemoteConfirmPolicy, input.kind);

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

    const lockResult = await input.runWithOperationLock(input.kind, async () => {
        input.setScmOperationBusy(true);
        input.setScmOperationStatus(buildRemoteOperationBusyLabel(input.kind, remoteTarget, t('files.detachedHead')));
        try {
            const runRemoteOperation = () => input.executeRemoteOperation(input.kind, remoteTarget);
            let response = await runRemoteOperation();
            if (!response.success && input.removeIndexLock) {
                response = await runScmOperationWithGitIndexLockRecovery({
                    cwd: repoPath,
                    failedResponse: response,
                    removeIndexLock: input.removeIndexLock,
                    retryOriginalOperation: runRemoteOperation,
                });
            }
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
                input.reportOperation({
                    operation: input.kind,
                    status: 'failed',
                    detail: message,
                    rawError: response.error,
                    errorCode: response.errorCode,
                });
                const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                    errorCode: response.errorCode,
                    onRetry: () => {
                        void executeScmRemoteOperation({
                            ...input,
                            skipConfirmation: input.retrySkipConfirmation,
                            kind: input.kind,
                        });
                    },
                    shouldContinue: input.shouldContinue ?? null,
                });
                if (!shownDaemonUnavailable) {
                    Modal.alert(t('common.error'), message);
                }
                return;
            }

            input.reportOperation({
                operation: input.kind,
                status: 'success',
                detail: buildRemoteOperationSuccessDetail(
                    input.kind,
                    remoteTarget,
                    response.stdout ?? '',
                    t('files.detachedHead'),
                ),
            });
            input.setScmOperationStatus('Refreshing repository status…');
            await input.refreshAfterSuccess(input.kind);
        } finally {
            input.setScmOperationBusy(false);
            input.setScmOperationStatus(null);
        }
    });

    if (!lockResult.started) {
        trackBlockedScmOperation({
            operation: input.kind,
            reason: 'lock',
            message: lockResult.message,
            surface: input.surface,
            tracking: input.tracking,
        });
        Modal.alert(t('common.error'), lockResult.message);
        return;
    }

    if (shouldOfferFetchAfterPushReject && input.scmPushRejectPolicy === 'auto_fetch') {
        await executeScmRemoteOperation({ ...input, kind: 'fetch' });
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
            await executeScmRemoteOperation({ ...input, kind: 'fetch' });
        }
    }
}
