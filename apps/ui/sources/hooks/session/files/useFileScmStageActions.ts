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

    const handleStage = React.useCallback(async (stage: boolean) => {
        if (!sessionId) return;
        if (isAtomicCommitStrategy(scmCommitStrategy)) {
            if (!stage) {
                storage.getState().unmarkSessionProjectScmCommitSelectionPaths(sessionId, [filePath]);
                storage.getState().removeSessionProjectScmCommitSelectionPatch(sessionId, filePath);
                reportSessionScmOperation({
                    state: storage.getState(),
                    sessionId,
                    operation: 'unstage',
                    status: 'success',
                    path: filePath,
                    detail: `${filePath} removed from commit selection`,
                    surface: 'file',
                    tracking,
                });
                return;
            }

            storage.getState().markSessionProjectScmCommitSelectionPaths(sessionId, [filePath]);
            storage.getState().removeSessionProjectScmCommitSelectionPatch(sessionId, filePath);
            reportSessionScmOperation({
                state: storage.getState(),
                sessionId,
                operation: 'stage',
                status: 'success',
                path: filePath,
                detail: `${filePath} selected for commit`,
                surface: 'file',
                tracking,
            });
            return;
        }

        const preflight = evaluateScmOperationPreflight({
            intent: stage ? 'stage' : 'unstage',
            scmWriteEnabled,
            sessionPath,
            snapshot: scmSnapshot,
            commitStrategy: scmCommitStrategy,
        });
        if (!preflight.allowed) {
            trackBlockedScmOperation({
                operation: stage ? 'stage' : 'unstage',
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
            operation: stage ? 'stage' : 'unstage',
            run: async () => {
                setIsApplyingStage(true);
                try {
                    const response = stage
                        ? await sessionScmChangeInclude(sessionId, { paths: [filePath] })
                        : await sessionScmChangeExclude(sessionId, { paths: [filePath] });

                    if (!response.success) {
                        const errorMessage = getScmUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || 'Source-control operation failed',
                        });
                        reportSessionScmOperation({
                            state: storage.getState(),
                            sessionId,
                            operation: stage ? 'stage' : 'unstage',
                            status: 'failed',
                            path: filePath,
                            detail: errorMessage,
                            errorCode: response.errorCode,
                            surface: 'file',
                            tracking,
                        });
                        Modal.alert(t('common.error'), errorMessage);
                        return;
                    }

                    reportSessionScmOperation({
                        state: storage.getState(),
                        sessionId,
                        operation: stage ? 'stage' : 'unstage',
                        status: 'success',
                        path: filePath,
                        detail: filePath,
                        surface: 'file',
                        tracking,
                    });
                    await scmStatusSync.invalidateFromMutationAndAwait(sessionId);
                    await refreshAll();
                } finally {
                    setIsApplyingStage(false);
                }
            },
        });
        if (!lockResult.started) {
            trackBlockedScmOperation({
                operation: stage ? 'stage' : 'unstage',
                reason: 'lock',
                message: lockResult.message,
                surface: 'file',
                tracking,
            });
            Modal.alert(t('common.error'), lockResult.message);
        }
    }, [filePath, scmCommitStrategy, scmSnapshot, scmWriteEnabled, refreshAll, sessionId, sessionPath]);

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
                setIsApplyingStage(true);
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
                        Modal.alert(t('common.error'), errorMessage);
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
                    setSelectedLineIndexes(new Set());
                    await scmStatusSync.invalidateFromMutationAndAwait(sessionId);
                    await refreshAll();
                } finally {
                    setIsApplyingStage(false);
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
    ]);

    return {
        isApplyingStage,
        handleStage,
        applySelectedLines,
    };
}
