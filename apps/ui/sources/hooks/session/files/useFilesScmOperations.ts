import * as React from 'react';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    useSessionProjectScmCommitSelectionPatches,
    useSessionProjectScmCommitSelectionPaths,
    useSetting,
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
import { generateScmCommitMessage } from '@/scm/operations/commitMessageGenerator';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { buildCommitSelectionPathHints } from '@/scm/operations/commitSelectionHints';
import { useScmRemoteOperations } from '@/hooks/session/sourceControl/useScmRemoteOperations';

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
    const {
        scmRemoteOperationBusy,
        scmRemoteOperationStatus,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
    } = useScmRemoteOperations({
        sessionId,
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
            sessionId,
            commitMessage: validation.message,
            scmCommitStrategy,
            commitSelectionPaths,
            commitSelectionPatches,
            loadCommitHistory: async (opts?: { reset?: boolean }) => {
                if (!mountedRef.current) return;
                await loadCommitHistory(opts);
            },
            refreshScmData: async () => {
                if (!mountedRef.current) return;
                await refreshScmData();
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
        refreshScmData,
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
        scmOperationBusy: scmOperationBusy || scmRemoteOperationBusy,
        scmOperationStatus: scmOperationStatus ?? scmRemoteOperationStatus,
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
