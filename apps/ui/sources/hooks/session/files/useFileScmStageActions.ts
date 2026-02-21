import * as React from 'react';

import {
    sessionScmChangeInclude,
    sessionScmChangeExclude,
} from '@/sync/ops';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { Modal } from '@/modal';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { buildPatchFromSelectedDiffLines } from '@/scm/scmPatchSelection';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { isAtomicCommitStrategy, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tracking } from '@/track';
import { applyFileStageAction } from '@/scm/operations/applyFileStageAction';
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';
import { useMountedRef } from '@/hooks/ui/useMountedRef';

type DiffMode = 'included' | 'pending' | 'both';

export function useFileScmStageActions(input: {
    sessionId: string;
    sessionPath: string | null;
    filePath: string;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    includeExcludeEnabled: boolean;
    diffMode: DiffMode;
    diffContent: string | null;
    lineSelectionEnabled: boolean;
    selectedLineIndexes: Set<number>;
    refreshAll: () => Promise<void>;
    setSelectedLineIndexes: React.Dispatch<React.SetStateAction<Set<number>>>;
}) {
    const {
        sessionId,
        sessionPath,
        filePath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        includeExcludeEnabled,
        diffMode,
        diffContent,
        lineSelectionEnabled,
        selectedLineIndexes,
        refreshAll,
        setSelectedLineIndexes,
    } = input;

    const [isApplyingStage, setIsApplyingStage] = React.useState(false);
    const mountedRef = useMountedRef();

    const setIsApplyingStageSafe = React.useCallback((value: boolean) => {
        if (!mountedRef.current) return;
        setIsApplyingStage(value);
    }, [mountedRef]);

    const handleStage = React.useCallback(async (stage: boolean) => {
        if (!sessionId) return;
        if (isAtomicCommitStrategy(scmCommitStrategy)) {
            await applyFileStageAction({
                sessionId,
                sessionPath,
                filePath,
                snapshot: scmSnapshot,
                scmWriteEnabled,
                commitStrategy: scmCommitStrategy,
                stage,
                surface: 'file',
                shouldContinue: () => mountedRef.current,
            });
            return;
        }

        setIsApplyingStageSafe(true);
        try {
            await applyFileStageAction({
                sessionId,
                sessionPath,
                filePath,
                snapshot: scmSnapshot,
                scmWriteEnabled,
                commitStrategy: scmCommitStrategy,
                stage,
                surface: 'file',
                refreshAll: async () => {
                    if (!mountedRef.current) return;
                    await refreshAll();
                },
                shouldContinue: () => mountedRef.current,
            });
        } finally {
            setIsApplyingStageSafe(false);
        }
    }, [filePath, scmCommitStrategy, scmSnapshot, scmWriteEnabled, refreshAll, sessionId, sessionPath, mountedRef, setIsApplyingStageSafe]);

    const applySelectedLines = React.useCallback(async () => {
        if (!sessionId || !sessionPath || !diffContent) return;
        if (selectedLineIndexes.size === 0) return;
        if (!lineSelectionEnabled) return;
        const atomicVirtualLineSelectionEnabled = isAtomicCommitStrategy(scmCommitStrategy)
            && scmSnapshot?.capabilities?.writeCommitLineSelection === true;
        if (!includeExcludeEnabled && !atomicVirtualLineSelectionEnabled) return;

        const stageSelected = diffMode !== 'included';
        if (atomicVirtualLineSelectionEnabled && diffMode !== 'pending') {
            Modal.alert(t('common.error'), 'Select Pending diff mode to pick lines for commit.');
            return;
        }

        const patch = buildPatchFromSelectedDiffLines(diffContent, selectedLineIndexes, {
            mode: stageSelected ? 'stage' : 'unstage',
        });
        if (!patch) {
            Modal.alert(t('common.error'), 'Unable to build patch from selected lines.');
            return;
        }

        if (atomicVirtualLineSelectionEnabled) {
            storage.getState().unmarkSessionProjectScmCommitSelectionPaths(sessionId, [filePath]);
            storage.getState().upsertSessionProjectScmCommitSelectionPatch(sessionId, {
                path: filePath,
                patch,
            });
            reportSessionScmOperation({
                state: storage.getState(),
                sessionId,
                operation: 'stage',
                status: 'success',
                path: filePath,
                detail: `${filePath} (${selectedLineIndexes.size} selected lines)`,
                surface: 'file',
                tracking,
            });
            setSelectedLineIndexes(new Set());
            return;
        }

        const preflight = evaluateScmOperationPreflight({
            intent: stageSelected ? 'stage' : 'unstage',
            scmWriteEnabled,
            sessionPath,
            snapshot: scmSnapshot,
            commitStrategy: scmCommitStrategy,
        });
        if (!preflight.allowed) {
            trackBlockedScmOperation({
                operation: stageSelected ? 'stage' : 'unstage',
                reason: 'preflight',
                message: preflight.message,
                surface: 'file',
                tracking,
            });
            Modal.alert(t('common.error'), preflight.message);
            return;
        }

        const lockResult = await withSessionProjectScmOperationLock({
            state: storage.getState(),
            sessionId,
            operation: stageSelected ? 'stage' : 'unstage',
            run: async () => {
                setIsApplyingStageSafe(true);
                try {
                    const response = stageSelected
                        ? await sessionScmChangeInclude(sessionId, { patch })
                        : await sessionScmChangeExclude(sessionId, { patch });

                    if (!response.success) {
                        const errorMessage = getScmUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || 'Diff changed, refresh and reselect lines.',
                        });
                        reportSessionScmOperation({
                            state: storage.getState(),
                            sessionId,
                            operation: stageSelected ? 'stage' : 'unstage',
                            status: 'failed',
                            path: filePath,
                            detail: errorMessage,
                            errorCode: response.errorCode,
                            surface: 'file',
                            tracking,
                        });
                        const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                            errorCode: response.errorCode,
                            onRetry: () => {
                                void applySelectedLines();
                            },
                            shouldContinue: () => mountedRef.current,
                        });
                        if (!shownDaemonUnavailable) {
                            Modal.alert(t('common.error'), errorMessage);
                        }
                        return;
                    }

                    reportSessionScmOperation({
                        state: storage.getState(),
                        sessionId,
                        operation: stageSelected ? 'stage' : 'unstage',
                        status: 'success',
                        path: filePath,
                        detail: `${filePath} (${selectedLineIndexes.size} selected lines)`,
                        surface: 'file',
                        tracking,
                    });
                    if (mountedRef.current) {
                        setSelectedLineIndexes(new Set());
                    }
                    await scmStatusSync.invalidateFromMutationAndAwait(sessionId);
                    if (mountedRef.current) {
                        await refreshAll();
                    }
                } finally {
                    setIsApplyingStageSafe(false);
                }
            },
        });
        if (!lockResult.started) {
            trackBlockedScmOperation({
                operation: stageSelected ? 'stage' : 'unstage',
                reason: 'lock',
                message: lockResult.message,
                surface: 'file',
                tracking,
            });
            Modal.alert(t('common.error'), lockResult.message);
        }
    }, [
        diffContent,
        diffMode,
        filePath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        lineSelectionEnabled,
        includeExcludeEnabled,
        refreshAll,
        selectedLineIndexes,
        sessionId,
        sessionPath,
        setSelectedLineIndexes,
        mountedRef,
        setIsApplyingStageSafe,
    ]);

    return {
        isApplyingStage,
        handleStage,
        applySelectedLines,
    };
}
