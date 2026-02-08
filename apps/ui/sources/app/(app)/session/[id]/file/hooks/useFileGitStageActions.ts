import * as React from 'react';

import {
    sessionGitStageApply,
    sessionGitUnstageApply,
} from '@/sync/ops';
import { storage } from '@/sync/storage';
import type { GitWorkingSnapshot } from '@/sync/storageTypes';
import { Modal } from '@/modal';
import { t } from '@/text';
import { gitStatusSync } from '@/sync/git/gitStatusSync';
import { buildPatchFromSelectedDiffLines } from '@/sync/git/gitPatchSelection';
import { evaluateGitOperationPreflight } from '@/sync/git/operations/policy';
import { getGitUserFacingError } from '@/sync/git/operations/userFacingErrors';
import { withSessionProjectGitOperationLock } from '@/sync/git/operations/withOperationLock';
import { reportSessionGitOperation, trackBlockedGitOperation } from '@/sync/git/operations/reporting';
import { tracking } from '@/track';

type DiffMode = 'staged' | 'unstaged' | 'both';

export function useFileGitStageActions(input: {
    sessionId: string;
    sessionPath: string | null;
    filePath: string;
    gitSnapshot: GitWorkingSnapshot | null;
    gitWriteEnabled: boolean;
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
        gitSnapshot,
        gitWriteEnabled,
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
        const preflight = evaluateGitOperationPreflight({
            intent: stage ? 'stage' : 'unstage',
            gitWriteEnabled,
            sessionPath,
            snapshot: gitSnapshot,
        });
        if (!preflight.allowed) {
            trackBlockedGitOperation({
                operation: stage ? 'stage' : 'unstage',
                reason: 'preflight',
                message: preflight.message,
                surface: 'file',
                tracking,
            });
            Modal.alert(t('common.error'), preflight.message);
            return;
        }
        const cwd = sessionPath;
        if (!cwd) return;

        const lockResult = await withSessionProjectGitOperationLock({
            state: storage.getState(),
            sessionId,
            operation: stage ? 'stage' : 'unstage',
            run: async () => {
                setIsApplyingStage(true);
                try {
                    const response = stage
                        ? await sessionGitStageApply(sessionId, { cwd, paths: [filePath] })
                        : await sessionGitUnstageApply(sessionId, { cwd, paths: [filePath] });

                    if (!response.success) {
                        const errorMessage = getGitUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || 'Git operation failed',
                        });
                        reportSessionGitOperation({
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

                    reportSessionGitOperation({
                        state: storage.getState(),
                        sessionId,
                        operation: stage ? 'stage' : 'unstage',
                        status: 'success',
                        path: filePath,
                        detail: filePath,
                        surface: 'file',
                        tracking,
                    });
                    await gitStatusSync.invalidateFromMutationAndAwait(sessionId);
                    await refreshAll();
                } finally {
                    setIsApplyingStage(false);
                }
            },
        });
        if (!lockResult.started) {
            trackBlockedGitOperation({
                operation: stage ? 'stage' : 'unstage',
                reason: 'lock',
                message: lockResult.message,
                surface: 'file',
                tracking,
            });
            Modal.alert(t('common.error'), lockResult.message);
        }
    }, [filePath, gitSnapshot, gitWriteEnabled, refreshAll, sessionId, sessionPath]);

    const applySelectedLines = React.useCallback(async () => {
        if (!sessionId || !sessionPath || !diffContent) return;
        if (selectedLineIndexes.size === 0) return;
        if (!lineSelectionEnabled) return;

        const stageSelected = diffMode !== 'staged';
        const preflight = evaluateGitOperationPreflight({
            intent: stageSelected ? 'stage' : 'unstage',
            gitWriteEnabled,
            sessionPath,
            snapshot: gitSnapshot,
        });
        if (!preflight.allowed) {
            trackBlockedGitOperation({
                operation: stageSelected ? 'stage' : 'unstage',
                reason: 'preflight',
                message: preflight.message,
                surface: 'file',
                tracking,
            });
            Modal.alert(t('common.error'), preflight.message);
            return;
        }
        const cwd = sessionPath;
        if (!cwd) return;

        const patch = buildPatchFromSelectedDiffLines(diffContent, selectedLineIndexes);
        if (!patch) {
            Modal.alert(t('common.error'), 'Unable to build patch from selected lines.');
            return;
        }

        const lockResult = await withSessionProjectGitOperationLock({
            state: storage.getState(),
            sessionId,
            operation: stageSelected ? 'stage' : 'unstage',
            run: async () => {
                setIsApplyingStage(true);
                try {
                    const response = stageSelected
                        ? await sessionGitStageApply(sessionId, { cwd, patch })
                        : await sessionGitUnstageApply(sessionId, { cwd, patch });

                    if (!response.success) {
                        const errorMessage = getGitUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || 'Diff changed, refresh and reselect lines.',
                        });
                        reportSessionGitOperation({
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

                    reportSessionGitOperation({
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
                    await gitStatusSync.invalidateFromMutationAndAwait(sessionId);
                    await refreshAll();
                } finally {
                    setIsApplyingStage(false);
                }
            },
        });
        if (!lockResult.started) {
            trackBlockedGitOperation({
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
        gitSnapshot,
        gitWriteEnabled,
        lineSelectionEnabled,
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
