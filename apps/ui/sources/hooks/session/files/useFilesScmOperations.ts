import * as React from 'react';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    useSessionProjectScmCommitSelectionPatches,
    useSessionProjectScmCommitSelectionPaths,
    storage,
} from '@/sync/domains/state/storage';
import { executeScmCommit } from './executeScmCommit';
import { Modal } from '@/modal';
import { t } from '@/text';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmPushRejectPolicy, ScmRemoteConfirmPolicy } from '@/scm/settings/preferences';
import { validateCommitMessage } from '@/scm/operations/commitMessage';
import { trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tracking } from '@/track';
import { showScmCommitMessageEditorModal } from '@/components/sessions/files/commit/showScmCommitMessageEditorModal';
import { useScmCommitMessageSuggestion } from '@/scm/operations/useScmCommitMessageSuggestion';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { buildCommitSelectionPathHints } from '@/scm/operations/commitSelectionHints';
import { useScmRemoteOperations } from '@/hooks/session/sourceControl/useScmRemoteOperations';

export function useFilesScmOperations(input: {
    sessionId: string;
    serverId?: string;
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
        sessionId, serverId,
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
        if (value) {
            const state = storage.getState();
            const operation = state.getSessionProjectScmInFlightOperation(sessionId, serverId);
            if (operation?.operation === 'commit' || operation?.operation === 'refresh') {
                state.updateSessionProjectScmOperationProgress(sessionId, operation.id, value, serverId);
            }
        }
    }, [mountedRef, sessionId, serverId]);
    const commitSelectionPaths = useSessionProjectScmCommitSelectionPaths(sessionId, serverId);
    const commitSelectionPatches = useSessionProjectScmCommitSelectionPatches(sessionId, serverId);
    const commitSelectionPathHints = React.useMemo(() => {
        return buildCommitSelectionPathHints({
            commitSelectionPaths,
            commitSelectionPatches,
        });
    }, [commitSelectionPatches, commitSelectionPaths]);

    const commitMessageHost = React.useMemo(() => sessionId
        ? { kind: 'session' as const, sessionId, serverId }
        : null, [serverId, sessionId]);
    const { enabled: commitMessageGeneratorEnabled, generate: generateCommitMessageSuggestion, cancel: cancelCommitMessageSuggestion, contextKey: commitMessageSuggestionContextKey }
        = useScmCommitMessageSuggestion(commitMessageHost, commitSelectionPathHints,
            JSON.stringify([sessionPath, scmSnapshot?.branch.headOid, commitSelectionPaths, commitSelectionPatches]));

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

    const {
        scmRemoteOperationBusy,
        scmRemoteOperationStatus,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
    } = useScmRemoteOperations({
        sessionId, serverId,
        sessionPath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        scmRemoteConfirmPolicy,
        scmPushRejectPolicy,
        refreshScmData,
        loadCommitHistory,
        surface: 'files',
    });

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
            sessionId, serverId,
            repoPath: sessionPath,
            commitMessage: validation.message,
            scmCommitStrategy,
            commitSelectionPaths,
            commitSelectionPatches,
            refreshScmData: async () => {
                if (!mountedRef.current) return;
                await refreshScmData();
            },
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
        refreshScmData,
        loadCommitHistory,
        sessionId, serverId,
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
            canGenerate: commitMessageGeneratorEnabled,
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
        commitMessageGeneratorEnabled,
        sessionId, serverId,
        sessionPath,
        tracking,
        generateCommitMessageSuggestion,
    ]);

    return {
        scmOperationBusy: scmOperationBusy || scmRemoteOperationBusy,
        scmOperationStatus: scmOperationStatus ?? scmRemoteOperationStatus,
        commitPreflight,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
        createCommit,
        createCommitFromMessage,
        commitMessageGeneratorEnabled,
        generateCommitMessageSuggestion,
        cancelCommitMessageSuggestion,
        commitMessageSuggestionContextKey,
    };
}
