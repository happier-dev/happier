import * as React from 'react';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    sessionScmRemoteFetch,
    sessionScmRemotePull,
    sessionScmRemotePush,
} from '@/sync/ops';
import {
    storage,
    useSessionProjectScmCommitSelectionPatches,
    useSessionProjectScmCommitSelectionPaths,
    useSetting,
} from '@/sync/domains/state/storage';
import { executeScmCommit } from './executeScmCommit';
import { Modal } from '@/modal';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmPushRejectPolicy, ScmRemoteConfirmPolicy } from '@/scm/settings/preferences';
import { validateCommitMessage } from '@/scm/operations/commitMessage';
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
import { showScmCommitMessageEditorModal } from '@/components/sessions/files/commit/showScmCommitMessageEditorModal';
import { generateScmCommitMessage } from '@/scm/operations/commitMessageGenerator';

export function useFilesScmOperations(input: {
    sessionId: string;
    sessionPath: string | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    scmRemoteConfirmPolicy: ScmRemoteConfirmPolicy;
    scmPushRejectPolicy: ScmPushRejectPolicy;
    refreshScmData: () => Promise<void>;
    loadCommitHistory: (opts?: { reset?: boolean }) => Promise<void>;
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
    } = input;

    const [scmOperationBusy, setScmOperationBusy] = React.useState(false);
    const [scmOperationStatus, setScmOperationStatus] = React.useState<string | null>(null);
    const commitSelectionPaths = useSessionProjectScmCommitSelectionPaths(sessionId);
    const commitSelectionPatches = useSessionProjectScmCommitSelectionPatches(sessionId);
    const scmCommitMessageGeneratorEnabled = useSetting('scmCommitMessageGeneratorEnabled');
    const scmCommitMessageGeneratorBackendId = useSetting('scmCommitMessageGeneratorBackendId');
    const scmCommitMessageGeneratorInstructions = useSetting('scmCommitMessageGeneratorInstructions');
    const commitSelectionPathHints = React.useMemo(() => {
        const selected = new Set<string>();
        for (const path of commitSelectionPaths) {
            const normalized = path.trim();
            if (normalized) selected.add(normalized);
        }
        for (const patch of commitSelectionPatches) {
            const normalized = patch.path.trim();
            if (normalized) selected.add(normalized);
        }
        return Array.from(selected).sort((a, b) => a.localeCompare(b));
    }, [commitSelectionPatches, commitSelectionPaths]);

    const commitPreflight = React.useMemo(
        () =>
            evaluateScmOperationPreflight({
                intent: 'commit',
                scmWriteEnabled,
                sessionPath,
                snapshot: scmSnapshot,
                commitStrategy: scmCommitStrategy,
                commitSelectionPaths: commitSelectionPathHints,
            }),
        [commitSelectionPathHints, scmCommitStrategy, scmSnapshot, scmWriteEnabled, sessionPath]
    );
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

    const runRemoteOperation = React.useCallback(async (kind: 'fetch' | 'pull' | 'push') => {
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
                surface: 'files',
                tracking,
            });
            Modal.alert(t('common.error'), preflight.message);
            return;
        }
        if (!sessionPath) return;
        const remoteTarget = inferRemoteTargetFromSnapshot(scmSnapshot);
        let shouldOfferFetchAfterPushReject = false;
        const isPullOrPush = kind === 'pull' || kind === 'push';
        const shouldConfirmRemote = isPullOrPush
            ? scmRemoteConfirmPolicy === 'always'
                || (scmRemoteConfirmPolicy === 'push_only' && kind === 'push')
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
                setScmOperationBusy(true);
                setScmOperationStatus(buildRemoteOperationBusyLabel(kind, remoteTarget, t('files.detachedHead')));
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
                            surface: 'files',
                            tracking,
                        });
                        Modal.alert(t('common.error'), message);
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
                        surface: 'files',
                        tracking,
                    });
                    setScmOperationStatus('Refreshing repository status…');
                    if (kind === 'pull' || kind === 'push') {
                        await scmStatusSync.invalidateFromMutationAndAwait(sessionId);
                        await loadCommitHistory({ reset: true });
                    } else {
                        await refreshScmData();
                    }
                } finally {
                    setScmOperationBusy(false);
                    setScmOperationStatus(null);
                }
            },
            });
        if (!lockResult.started) {
            trackBlockedScmOperation({
                operation: kind,
                reason: 'lock',
                message: lockResult.message,
                surface: 'files',
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
    ]);

    const createCommit = React.useCallback(async () => {
        const preflight = evaluateScmOperationPreflight({
            intent: 'commit',
            scmWriteEnabled,
            sessionPath,
            snapshot: scmSnapshot,
            commitStrategy: scmCommitStrategy,
            commitSelectionPaths: commitSelectionPathHints,
        });
        if (!preflight.allowed) {
            trackBlockedScmOperation({
                operation: 'commit',
                reason: 'preflight',
                message: preflight.message,
                surface: 'files',
                tracking,
            });
            Modal.alert(t('common.error'), preflight.message);
            return;
        }
        if (!sessionPath) return;

        const backendId =
            typeof scmCommitMessageGeneratorBackendId === 'string' && scmCommitMessageGeneratorBackendId.trim().length > 0
                ? scmCommitMessageGeneratorBackendId.trim()
                : 'claude';

        const rawMessage = await showScmCommitMessageEditorModal({
            title: 'Create commit',
            canGenerate: scmCommitMessageGeneratorEnabled === true,
            onGenerate: async () => {
                const res = await generateScmCommitMessage({
                    sessionId,
                    backendId,
                    instructions: typeof scmCommitMessageGeneratorInstructions === 'string'
                        ? scmCommitMessageGeneratorInstructions
                        : undefined,
                    scopePaths: commitSelectionPathHints,
                });
                if (!res.ok) return { ok: false, error: res.error };
                return { ok: true, message: res.message };
            },
        });
        const validation = validateCommitMessage(rawMessage ?? '');
        if (!validation.ok) {
            Modal.alert(t('common.error'), validation.message);
            return;
        }

        await executeScmCommit({
            sessionId,
            commitMessage: validation.message,
            scmCommitStrategy,
            commitSelectionPaths,
            commitSelectionPatches,
            loadCommitHistory,
            setScmOperationBusy,
            setScmOperationStatus,
            tracking,
        });
    }, [
        scmCommitMessageGeneratorBackendId,
        scmCommitMessageGeneratorEnabled,
        scmCommitMessageGeneratorInstructions,
        commitSelectionPathHints,
        commitSelectionPatches,
        commitSelectionPaths,
        scmCommitStrategy,
        scmSnapshot,
        scmWriteEnabled,
        loadCommitHistory,
        sessionId,
        sessionPath,
    ]);

    return {
        scmOperationBusy,
        scmOperationStatus,
        commitPreflight,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
        createCommit,
    };
}
