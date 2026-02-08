import * as React from 'react';

import type { GitWorkingSnapshot } from '@/sync/storageTypes';
import {
    sessionGitCommitCreate,
    sessionGitRemoteFetch,
    sessionGitRemotePull,
    sessionGitRemotePush,
} from '@/sync/ops';
import { storage } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { gitStatusSync } from '@/sync/git/gitStatusSync';
import { evaluateGitOperationPreflight } from '@/sync/git/operations/policy';
import { validateCommitMessage } from '@/sync/git/operations/commitMessage';
import {
    buildNonFastForwardFetchPromptDialog,
    buildRemoteConfirmDialog,
    buildRemoteOperationBusyLabel,
    buildRemoteOperationSuccessDetail,
} from '@/sync/git/operations/remoteFeedback';
import { inferRemoteTargetFromSnapshot } from '@/sync/git/operations/remoteTarget';
import { getGitUserFacingError } from '@/sync/git/operations/userFacingErrors';
import { withSessionProjectGitOperationLock } from '@/sync/git/operations/withOperationLock';
import { reportSessionGitOperation, trackBlockedGitOperation } from '@/sync/git/operations/reporting';
import { tracking } from '@/track';
import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

export function useFilesGitOperations(input: {
    sessionId: string;
    sessionPath: string | null;
    gitSnapshot: GitWorkingSnapshot | null;
    gitWriteEnabled: boolean;
    refreshGitData: () => Promise<void>;
    loadCommitHistory: (opts?: { reset?: boolean }) => Promise<void>;
}) {
    const {
        sessionId,
        sessionPath,
        gitSnapshot,
        gitWriteEnabled,
        refreshGitData,
        loadCommitHistory,
    } = input;

    const [gitOperationBusy, setGitOperationBusy] = React.useState(false);
    const [gitOperationStatus, setGitOperationStatus] = React.useState<string | null>(null);

    const commitPreflight = React.useMemo(
        () =>
            evaluateGitOperationPreflight({
                intent: 'commit',
                gitWriteEnabled,
                sessionPath,
                snapshot: gitSnapshot,
            }),
        [gitSnapshot, gitWriteEnabled, sessionPath]
    );
    const pullPreflight = React.useMemo(
        () =>
            evaluateGitOperationPreflight({
                intent: 'pull',
                gitWriteEnabled,
                sessionPath,
                snapshot: gitSnapshot,
            }),
        [gitSnapshot, gitWriteEnabled, sessionPath]
    );
    const pushPreflight = React.useMemo(
        () =>
            evaluateGitOperationPreflight({
                intent: 'push',
                gitWriteEnabled,
                sessionPath,
                snapshot: gitSnapshot,
            }),
        [gitSnapshot, gitWriteEnabled, sessionPath]
    );

    const runRemoteOperation = React.useCallback(async (kind: 'fetch' | 'pull' | 'push') => {
        const preflight = evaluateGitOperationPreflight({
            intent: kind,
            gitWriteEnabled,
            sessionPath,
            snapshot: gitSnapshot,
        });
        if (!preflight.allowed) {
            trackBlockedGitOperation({
                operation: kind,
                reason: 'preflight',
                message: preflight.message,
                surface: 'files',
                tracking,
            });
            Modal.alert(t('common.error'), preflight.message);
            return;
        }
        const cwd = sessionPath;
        if (!cwd) return;
        const remoteTarget = inferRemoteTargetFromSnapshot(gitSnapshot);
        let shouldOfferFetchAfterPushReject = false;
        if (kind === 'pull' || kind === 'push') {
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
        const lockResult = await withSessionProjectGitOperationLock({
            state: storage.getState(),
            sessionId,
            operation: kind,
            run: async () => {
                setGitOperationBusy(true);
                setGitOperationStatus(buildRemoteOperationBusyLabel(kind, remoteTarget, t('files.detachedHead')));
                try {
                    const response = kind === 'fetch'
                        ? await sessionGitRemoteFetch(sessionId, { cwd, remote: remoteTarget.remote })
                        : kind === 'pull'
                            ? await sessionGitRemotePull(sessionId, {
                                cwd,
                                remote: remoteTarget.remote,
                                branch: remoteTarget.branch ?? undefined,
                            })
                            : await sessionGitRemotePush(sessionId, {
                                cwd,
                                remote: remoteTarget.remote,
                                branch: remoteTarget.branch ?? undefined,
                            });

                    if (!response.success) {
                        const message = getGitUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || `Failed to ${kind}`,
                        });
                        if (
                            kind === 'push'
                            && response.errorCode === GIT_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD
                        ) {
                            shouldOfferFetchAfterPushReject = true;
                        }
                        reportSessionGitOperation({
                            state: storage.getState(),
                            sessionId,
                            operation: kind,
                            status: 'failed',
                            detail: message,
                            errorCode: response.errorCode,
                            surface: 'files',
                            tracking,
                        });
                        Modal.alert(t('common.error'), message);
                        return;
                    }

                    reportSessionGitOperation({
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
                        surface: 'files',
                        tracking,
                    });
                    setGitOperationStatus('Refreshing repository status…');
                    if (kind === 'pull' || kind === 'push') {
                        await gitStatusSync.invalidateFromMutationAndAwait(sessionId);
                        await loadCommitHistory({ reset: true });
                    } else {
                        await refreshGitData();
                    }
                } finally {
                    setGitOperationBusy(false);
                    setGitOperationStatus(null);
                }
            },
            });
        if (!lockResult.started) {
            trackBlockedGitOperation({
                operation: kind,
                reason: 'lock',
                message: lockResult.message,
                surface: 'files',
                tracking,
            });
            Modal.alert(t('common.error'), lockResult.message);
            return;
        }

        if (shouldOfferFetchAfterPushReject) {
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
    }, [gitSnapshot, gitWriteEnabled, loadCommitHistory, refreshGitData, sessionId, sessionPath]);

    const createCommit = React.useCallback(async () => {
        const preflight = evaluateGitOperationPreflight({
            intent: 'commit',
            gitWriteEnabled,
            sessionPath,
            snapshot: gitSnapshot,
        });
        if (!preflight.allowed) {
            trackBlockedGitOperation({
                operation: 'commit',
                reason: 'preflight',
                message: preflight.message,
                surface: 'files',
                tracking,
            });
            Modal.alert(t('common.error'), preflight.message);
            return;
        }
        const cwd = sessionPath;
        if (!cwd) return;
        const rawMessage = await Modal.prompt('Create commit', 'Enter commit message');
        const validation = validateCommitMessage(rawMessage ?? '');
        if (!validation.ok) {
            Modal.alert(t('common.error'), validation.message);
            return;
        }

        const lockResult = await withSessionProjectGitOperationLock({
            state: storage.getState(),
            sessionId,
            operation: 'commit',
            run: async () => {
                setGitOperationBusy(true);
                try {
                    const response = await sessionGitCommitCreate(sessionId, {
                        cwd,
                        message: validation.message,
                    });
                    if (!response.success) {
                        const errorMessage = getGitUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || 'Failed to create commit',
                        });
                        reportSessionGitOperation({
                            state: storage.getState(),
                            sessionId,
                            operation: 'commit',
                            status: 'failed',
                            detail: errorMessage,
                            errorCode: response.errorCode,
                            surface: 'files',
                            tracking,
                        });
                        Modal.alert(t('common.error'), errorMessage);
                        return;
                    }
                    reportSessionGitOperation({
                        state: storage.getState(),
                        sessionId,
                        operation: 'commit',
                        status: 'success',
                        detail: response.commitSha || undefined,
                        surface: 'files',
                        tracking,
                    });
                    await gitStatusSync.invalidateFromMutationAndAwait(sessionId);
                    await loadCommitHistory({ reset: true });
                } finally {
                    setGitOperationBusy(false);
                }
            },
        });
        if (!lockResult.started) {
            trackBlockedGitOperation({
                operation: 'commit',
                reason: 'lock',
                message: lockResult.message,
                surface: 'files',
                tracking,
            });
            Modal.alert(t('common.error'), lockResult.message);
        }
    }, [gitSnapshot, gitWriteEnabled, loadCommitHistory, sessionId, sessionPath]);

    return {
        gitOperationBusy,
        gitOperationStatus,
        commitPreflight,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
        createCommit,
    };
}
