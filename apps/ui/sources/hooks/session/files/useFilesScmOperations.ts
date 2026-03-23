import * as React from 'react';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
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
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { buildCommitSelectionPathHints } from '@/scm/operations/commitSelectionHints';

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
    const mountedRef = useMountedRef();

    const setScmOperationBusySafe = React.useCallback((value: boolean) => {
        if (!mountedRef.current) return;
        setScmOperationBusy(value);
    }, [mountedRef]);
    const setScmOperationStatusSafe = React.useCallback((value: string | null) => {
        if (!mountedRef.current) return;
        setScmOperationStatus(value);
    }, [mountedRef]);
    const commitSelectionPaths = useSessionProjectScmCommitSelectionPaths(sessionId);
    const commitSelectionPatches = useSessionProjectScmCommitSelectionPatches(sessionId);
    const scmCommitMessageGeneratorEnabled = useSetting('scmCommitMessageGeneratorEnabled');
    const scmCommitMessageGeneratorBackendId = useSetting('scmCommitMessageGeneratorBackendId');
    const scmCommitMessageGeneratorInstructions = useSetting('scmCommitMessageGeneratorInstructions');
    const commitSelectionPathHints = React.useMemo(() => {
        return buildCommitSelectionPathHints({
            commitSelectionPaths,
            commitSelectionPatches,
        });
    }, [commitSelectionPatches, commitSelectionPaths]);

    const commitMessageGeneratorBackendId = React.useMemo(() => {
        return typeof scmCommitMessageGeneratorBackendId === 'string' && scmCommitMessageGeneratorBackendId.trim().length > 0
            ? scmCommitMessageGeneratorBackendId.trim()
            : DEFAULT_AGENT_ID;
    }, [scmCommitMessageGeneratorBackendId]);

    const generateCommitMessageSuggestion = React.useCallback(async () => {
        if (!sessionId) return { ok: false as const, error: t('files.commitMessageEditor.generateFailed') };
        if (scmCommitMessageGeneratorEnabled !== true) {
            return { ok: false as const, error: t('files.commitMessageEditor.generatorDisabled') };
        }

        const res = await generateScmCommitMessage({
            sessionId,
            backendId: commitMessageGeneratorBackendId,
            instructions: typeof scmCommitMessageGeneratorInstructions === 'string'
                ? scmCommitMessageGeneratorInstructions
                : undefined,
            scopePaths: commitSelectionPathHints,
        });
        if (!res.ok) return { ok: false as const, error: res.error };
        return { ok: true as const, message: res.message };
    }, [
        commitMessageGeneratorBackendId,
        commitSelectionPathHints,
        scmCommitMessageGeneratorEnabled,
        scmCommitMessageGeneratorInstructions,
        sessionId,
    ]);

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
    const commitPreflightBlockedMessage = React.useMemo(
        () => (commitPreflight.allowed ? null : commitPreflight.message),
        [commitPreflight]
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
                setScmOperationBusySafe(true);
                setScmOperationStatusSafe(buildRemoteOperationBusyLabel(kind, remoteTarget, t('files.detachedHead')));
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
                        surface: 'files',
                        tracking,
                    });
                    setScmOperationStatusSafe('Refreshing repository status…');
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
                    setScmOperationBusySafe(false);
                    setScmOperationStatusSafe(null);
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

    const createCommitFromMessage = React.useCallback(async (commitMessage: string) => {
        if (!commitPreflight.allowed) {
            trackBlockedScmOperation({
                operation: 'commit',
                reason: 'preflight',
                message: commitPreflight.message,
                surface: 'files',
                tracking,
            });
            Modal.alert(t('common.error'), commitPreflight.message);
            return { ok: false } as const;
        }
        if (!sessionPath) return { ok: false } as const;

        const validation = validateCommitMessage(commitMessage ?? '');
        if (!validation.ok) {
            Modal.alert(t('common.error'), validation.message);
            return { ok: false } as const;
        }

        const result = await executeScmCommit({
            sessionId,
            commitMessage: validation.message,
            scmCommitStrategy,
            commitSelectionPaths,
            commitSelectionPatches,
            loadCommitHistory: async (opts?: { reset?: boolean }) => {
                if (!mountedRef.current) return;
                await loadCommitHistory(opts);
            },
            setScmOperationBusy: setScmOperationBusySafe,
            setScmOperationStatus: setScmOperationStatusSafe,
            tracking,
            shouldContinue: () => mountedRef.current,
        });
        return result;
    }, [
        commitPreflight.allowed,
        commitPreflightBlockedMessage,
        commitSelectionPatches,
        commitSelectionPaths,
        scmCommitStrategy,
        loadCommitHistory,
        sessionId,
        sessionPath,
        mountedRef,
        setScmOperationBusySafe,
        setScmOperationStatusSafe,
        tracking,
    ]);

    const createCommit = React.useCallback(async () => {
        if (!commitPreflight.allowed) {
            trackBlockedScmOperation({
                operation: 'commit',
                reason: 'preflight',
                message: commitPreflight.message,
                surface: 'files',
                tracking,
            });
            Modal.alert(t('common.error'), commitPreflight.message);
            return;
        }
        if (!sessionPath) return;

        const rawMessage = await showScmCommitMessageEditorModal({
            title: 'Create commit',
            canGenerate: scmCommitMessageGeneratorEnabled === true,
            onGenerate: async () => {
                const res = await generateCommitMessageSuggestion();
                if (!res.ok) return { ok: false, error: res.error };
                return { ok: true, message: res.message };
            },
        });

        await createCommitFromMessage(rawMessage ?? '');
    }, [
        commitPreflight.allowed,
        commitPreflightBlockedMessage,
        commitSelectionPathHints,
        createCommitFromMessage,
        scmCommitMessageGeneratorBackendId,
        scmCommitMessageGeneratorEnabled,
        scmCommitMessageGeneratorInstructions,
        sessionId,
        sessionPath,
        tracking,
        generateCommitMessageSuggestion,
    ]);

    return {
        scmOperationBusy,
        scmOperationStatus,
        commitPreflight,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
        createCommit,
        createCommitFromMessage,
        commitMessageGeneratorEnabled: scmCommitMessageGeneratorEnabled === true,
        generateCommitMessageSuggestion,
    };
}
