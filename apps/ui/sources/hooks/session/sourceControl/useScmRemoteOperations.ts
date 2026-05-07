import * as React from 'react';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    sessionScmRemoteFetch,
    sessionScmRemotePull,
    sessionScmRemotePush,
} from '@/sync/ops';
import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmPushRejectPolicy, ScmRemoteConfirmPolicy } from '@/scm/settings/preferences';
import { shouldConfirmRemoteOperation } from '@/scm/settings/remoteConfirmationPolicy';
import {
    buildNonFastForwardFetchPromptDialog,
    buildRemoteConfirmDialog,
    buildRemoteOperationBusyLabel,
    buildRemoteOperationSuccessDetail,
} from '@/scm/operations/remoteFeedback';
import { inferRemoteTargetFromSnapshot } from '@/scm/operations/remoteTarget';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tracking } from '@/track';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';
import { useMountedRef } from '@/hooks/ui/useMountedRef';

export type ScmRemoteOperationKind = 'fetch' | 'pull' | 'push';

export type RunScmRemoteOperationOptions = Readonly<{
    skipConfirmation?: boolean;
}>;

export function useScmRemoteOperations(input: {
    sessionId: string;
    sessionPath: string | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    scmRemoteConfirmPolicy: ScmRemoteConfirmPolicy;
    scmPushRejectPolicy: ScmPushRejectPolicy;
    refreshScmData: () => Promise<void>;
    loadCommitHistory: (opts?: { reset?: boolean }) => Promise<void>;
    surface?: 'files' | 'update';
}) {
    const {
        sessionId,
        sessionPath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        scmRemoteConfirmPolicy,
        scmPushRejectPolicy,
        refreshScmData,
        loadCommitHistory,
        surface = 'update',
    } = input;
    const [scmRemoteOperationBusy, setScmRemoteOperationBusy] = React.useState(false);
    const [scmRemoteOperationStatus, setScmRemoteOperationStatus] = React.useState<string | null>(null);
    const mountedRef = useMountedRef();

    const setScmRemoteOperationBusySafe = React.useCallback((value: boolean) => {
        if (!mountedRef.current) return;
        setScmRemoteOperationBusy(value);
    }, [mountedRef]);
    const setScmRemoteOperationStatusSafe = React.useCallback((value: string | null) => {
        if (!mountedRef.current) return;
        setScmRemoteOperationStatus(value);
    }, [mountedRef]);

    const pullPreflight = React.useMemo(
        () =>
            evaluateScmOperationPreflight({
                intent: 'pull',
                scmWriteEnabled,
                sessionPath,
                snapshot: scmSnapshot,
                commitStrategy: scmCommitStrategy,
            }),
        [scmCommitStrategy, scmSnapshot, scmWriteEnabled, sessionPath]
    );
    const pushPreflight = React.useMemo(
        () =>
            evaluateScmOperationPreflight({
                intent: 'push',
                scmWriteEnabled,
                sessionPath,
                snapshot: scmSnapshot,
                commitStrategy: scmCommitStrategy,
            }),
        [scmCommitStrategy, scmSnapshot, scmWriteEnabled, sessionPath]
    );

    const runRemoteOperation = React.useCallback(async (
        kind: ScmRemoteOperationKind,
        options?: RunScmRemoteOperationOptions,
    ) => {
        const preflight = evaluateScmOperationPreflight({
            intent: kind,
            scmWriteEnabled,
            sessionPath,
            snapshot: scmSnapshot,
            commitStrategy: scmCommitStrategy,
        });
        if (!preflight.allowed) {
            trackBlockedScmOperation({
                operation: kind,
                reason: 'preflight',
                message: preflight.message,
                surface,
                tracking,
            });
            Modal.alert(t('common.error'), preflight.message);
            return;
        }
        if (!sessionPath) return;
        const remoteTarget = inferRemoteTargetFromSnapshot(scmSnapshot);
        let shouldOfferFetchAfterPushReject = false;
        const isPullOrPush = kind === 'pull' || kind === 'push';
        const shouldConfirmRemote = isPullOrPush && options?.skipConfirmation !== true
            ? shouldConfirmRemoteOperation(scmRemoteConfirmPolicy, kind)
            : false;
        if (isPullOrPush && shouldConfirmRemote) {
            const dialog = buildRemoteConfirmDialog({
                kind,
                target: remoteTarget,
                detachedHeadLabel: t('files.detachedHead'),
            });
            const confirmed = await Modal.confirm(
                dialog.title,
                dialog.body,
                { confirmText: dialog.confirmText, cancelText: dialog.cancelText }
            );
            if (!confirmed) return;
        }
        const lockResult = await withSessionProjectScmOperationLock({
            state: storage.getState(),
            sessionId,
            operation: kind,
            run: async () => {
                setScmRemoteOperationBusySafe(true);
                setScmRemoteOperationStatusSafe(buildRemoteOperationBusyLabel(kind, remoteTarget, t('files.detachedHead')));
                try {
                    const response = kind === 'fetch'
                        ? await sessionScmRemoteFetch(sessionId, { remote: remoteTarget.remote })
                        : kind === 'pull'
                            ? await sessionScmRemotePull(sessionId, {
                                remote: remoteTarget.remote,
                                branch: remoteTarget.branch ?? undefined,
                            })
                            : await sessionScmRemotePush(sessionId, {
                                remote: remoteTarget.remote,
                                branch: remoteTarget.branch ?? undefined,
                            });

                    if (!response.success) {
                        const message = getScmUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || `Failed to ${kind}`,
                        });
                        if (
                            kind === 'push'
                            && response.errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD
                        ) {
                            shouldOfferFetchAfterPushReject = true;
                        }
                        reportSessionScmOperation({
                            state: storage.getState(),
                            sessionId,
                            operation: kind,
                            status: 'failed',
                            detail: message,
                            rawError: response.error,
                            errorCode: response.errorCode,
                            surface,
                            tracking,
                        });
                        const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                            errorCode: response.errorCode,
                            onRetry: () => {
                                void runRemoteOperation(kind);
                            },
                            shouldContinue: () => mountedRef.current,
                        });
                        if (!shownDaemonUnavailable) {
                            Modal.alert(t('common.error'), message);
                        }
                        return;
                    }

                    reportSessionScmOperation({
                        state: storage.getState(),
                        sessionId,
                        operation: kind,
                        status: 'success',
                        detail: buildRemoteOperationSuccessDetail(
                            kind,
                            remoteTarget,
                            response.stdout ?? '',
                            t('files.detachedHead')
                        ),
                        surface,
                        tracking,
                    });
                    setScmRemoteOperationStatusSafe('Refreshing repository status…');
                    if (kind === 'pull' || kind === 'push') {
                        await scmStatusSync.invalidateFromMutationAndAwait(sessionId);
                        if (mountedRef.current) {
                            await loadCommitHistory({ reset: true });
                        }
                    } else {
                        if (mountedRef.current) {
                            await refreshScmData();
                        }
                    }
                } finally {
                    setScmRemoteOperationBusySafe(false);
                    setScmRemoteOperationStatusSafe(null);
                }
            },
        });
        if (!lockResult.started) {
            trackBlockedScmOperation({
                operation: kind,
                reason: 'lock',
                message: lockResult.message,
                surface,
                tracking,
            });
            Modal.alert(t('common.error'), lockResult.message);
            return;
        }

        if (shouldOfferFetchAfterPushReject && scmPushRejectPolicy === 'auto_fetch') {
            await runRemoteOperation('fetch');
            return;
        }

        if (shouldOfferFetchAfterPushReject && scmPushRejectPolicy === 'prompt_fetch') {
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
                await runRemoteOperation('fetch');
            }
        }
    }, [
        scmCommitStrategy,
        scmPushRejectPolicy,
        scmRemoteConfirmPolicy,
        scmSnapshot,
        scmWriteEnabled,
        loadCommitHistory,
        refreshScmData,
        sessionId,
        sessionPath,
        surface,
        mountedRef,
        setScmRemoteOperationBusySafe,
        setScmRemoteOperationStatusSafe,
    ]);

    return {
        scmRemoteOperationBusy,
        scmRemoteOperationStatus,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
    };
}
