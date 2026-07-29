import * as React from 'react';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { Modal } from '@/modal';
import { t } from '@/text';
import { scmRepositoryService, snapshotToScmStatus } from '@/scm/scmRepositoryService';
import { buildPatchFromSelectedDiffLines } from '@/scm/scmPatchSelection';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { isAtomicCommitStrategy, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { withWorkspaceScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportWorkspaceScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tracking } from '@/track';
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { machineScmChangeExclude, machineScmChangeInclude } from '@/sync/ops/scm/machineScm';

type DiffMode = 'included' | 'pending' | 'both';

async function refreshWorkspaceScmSnapshot(scope: WorkspaceScopeBase): Promise<void> {
    const next = await scmRepositoryService.fetchSnapshotForMachinePath({
        serverId: scope.serverId,
        machineId: scope.machineId,
        path: scope.rootPath,
    });
    const state = storage.getState();
    state.updateWorkspaceScmSnapshot(scope, next);
    state.updateWorkspaceScmSnapshotError(scope, null);
    state.updateWorkspaceScmStatus(scope, next ? snapshotToScmStatus(next) : null);

    const activePaths = new Set<string>(
        next?.entries?.map((entry) => String(entry?.path ?? '')).filter(Boolean) ?? [],
    );
    state.pruneWorkspaceScmTouchedPaths(scope, activePaths);
    state.pruneWorkspaceScmCommitSelectionPaths(scope, activePaths);
    state.pruneWorkspaceScmCommitSelectionPatches(scope, activePaths);
}

export function useWorkspaceFileScmStageActions(input: {
    scope: WorkspaceScopeBase | null;
    filePath: string;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    includeExcludeEnabled: boolean;
    diffMode: DiffMode;
    diffContent: string | null;
    lineSelectionEnabled: boolean;
    selectedLineKeys: Set<string>;
    refreshAll: () => Promise<void>;
    setSelectedLineKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
    const {
        scope,
        filePath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        includeExcludeEnabled,
        diffMode,
        diffContent,
        lineSelectionEnabled,
        selectedLineKeys,
        refreshAll,
        setSelectedLineKeys,
    } = input;

    const [isApplyingStage, setIsApplyingStage] = React.useState(false);
    const mountedRef = useMountedRef();

    const setIsApplyingStageSafe = React.useCallback((value: boolean) => {
        if (!mountedRef.current) return;
        setIsApplyingStage(value);
    }, [mountedRef]);

    const handleStage = React.useCallback(async (stage: boolean) => {
        if (!scope) return;
        if (isAtomicCommitStrategy(scmCommitStrategy)) {
            if (!stage) {
                storage.getState().unmarkWorkspaceScmCommitSelectionPaths(scope, [filePath]);
                storage.getState().removeWorkspaceScmCommitSelectionPatch(scope, filePath);
                reportWorkspaceScmOperation({
                    state: storage.getState(),
                    scope,
                    operation: 'unstage',
                    status: 'success',
                    path: filePath,
                    detail: `${filePath} removed from commit selection`,
                    surface: 'file',
                    tracking,
                });
                return;
            }

            storage.getState().markWorkspaceScmCommitSelectionPaths(scope, [filePath]);
            storage.getState().removeWorkspaceScmCommitSelectionPatch(scope, filePath);
            reportWorkspaceScmOperation({
                state: storage.getState(),
                scope,
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
            sessionPath: scope.rootPath,
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

        const lockResult = await withWorkspaceScmOperationLock({
            state: storage.getState(),
            scope,
            operation: stage ? 'stage' : 'unstage',
            run: async () => {
                setIsApplyingStageSafe(true);
                try {
                    const response = stage
                        ? await machineScmChangeInclude(scope.machineId, { cwd: scope.rootPath, paths: [filePath] }, { serverId: scope.serverId })
                        : await machineScmChangeExclude(scope.machineId, { cwd: scope.rootPath, paths: [filePath] }, { serverId: scope.serverId });

                    if (!response.success) {
                        const errorMessage = getScmUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || t('errors.tryAgain'),
                        });
                        reportWorkspaceScmOperation({
                            state: storage.getState(),
                            scope,
                            operation: stage ? 'stage' : 'unstage',
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
                                void handleStage(stage);
                            },
                            shouldContinue: () => mountedRef.current,
                        });
                        if (!shownDaemonUnavailable) {
                            Modal.alert(t('common.error'), errorMessage);
                        }
                        return;
                    }

                    reportWorkspaceScmOperation({
                        state: storage.getState(),
                        scope,
                        operation: stage ? 'stage' : 'unstage',
                        status: 'success',
                        path: filePath,
                        detail: filePath,
                        surface: 'file',
                        tracking,
                    });

                    await refreshWorkspaceScmSnapshot(scope);
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
                operation: stage ? 'stage' : 'unstage',
                reason: 'lock',
                message: lockResult.message,
                surface: 'file',
                tracking,
            });
            Modal.alert(t('common.error'), lockResult.message);
        }
    }, [filePath, mountedRef, refreshAll, scmCommitStrategy, scmSnapshot, scmWriteEnabled, scope, setIsApplyingStageSafe]);

    const applySelectedLines = React.useCallback(async (): Promise<boolean> => {
        if (!scope) return false;
        if (!diffContent) return false;
        if (selectedLineKeys.size === 0) return false;
        if (!lineSelectionEnabled) return false;

        const atomicVirtualLineSelectionEnabled = isAtomicCommitStrategy(scmCommitStrategy)
            && scmSnapshot?.capabilities?.writeCommitLineSelection === true;
        if (!includeExcludeEnabled && !atomicVirtualLineSelectionEnabled) return false;

        const stageSelected = diffMode !== 'included';
        if (atomicVirtualLineSelectionEnabled && diffMode !== 'pending') {
            Modal.alert(t('common.error'), t('files.stageActions.selectPendingDiffMode'));
            return false;
        }

        const patch = buildPatchFromSelectedDiffLines(diffContent, selectedLineKeys, {
            mode: stageSelected ? 'stage' : 'unstage',
        });
        if (!patch) {
            Modal.alert(t('common.error'), t('files.stageActions.unableToBuildPatchFromSelection'));
            return false;
        }

        if (atomicVirtualLineSelectionEnabled) {
            try {
                storage.getState().unmarkWorkspaceScmCommitSelectionPaths(scope, [filePath]);
                storage.getState().upsertWorkspaceScmCommitSelectionPatch(scope, {
                    path: filePath,
                    patch,
                });
                reportWorkspaceScmOperation({
                    state: storage.getState(),
                    scope,
                    operation: 'stage',
                    status: 'success',
                    path: filePath,
                    detail: `${filePath} (${selectedLineKeys.size} selected lines)`,
                    surface: 'file',
                    tracking,
                });
                setSelectedLineKeys(new Set());
                return true;
            } catch (error) {
                const message = error instanceof Error ? error.message : t('files.stageActions.diffChangedRefreshAndReselect');
                Modal.alert(t('common.error'), message);
                return false;
            }
        }

        const preflight = evaluateScmOperationPreflight({
            intent: stageSelected ? 'stage' : 'unstage',
            scmWriteEnabled,
            sessionPath: scope.rootPath,
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
            return false;
        }

        let applied = false;
        const lockResult = await withWorkspaceScmOperationLock({
            state: storage.getState(),
            scope,
            operation: stageSelected ? 'stage' : 'unstage',
            run: async () => {
                setIsApplyingStageSafe(true);
                try {
                    const response = stageSelected
                        ? await machineScmChangeInclude(scope.machineId, { cwd: scope.rootPath, patch }, { serverId: scope.serverId })
                        : await machineScmChangeExclude(scope.machineId, { cwd: scope.rootPath, patch }, { serverId: scope.serverId });

                    if (!response.success) {
                        const errorMessage = getScmUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || t('files.stageActions.diffChangedRefreshAndReselect'),
                        });
                        reportWorkspaceScmOperation({
                            state: storage.getState(),
                            scope,
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

                    reportWorkspaceScmOperation({
                        state: storage.getState(),
                        scope,
                        operation: stageSelected ? 'stage' : 'unstage',
                        status: 'success',
                        path: filePath,
                        detail: `${filePath} (${selectedLineKeys.size} selected lines)`,
                        surface: 'file',
                        tracking,
                    });
                    if (mountedRef.current) {
                        setSelectedLineKeys(new Set());
                    }
                    applied = true;
                    await refreshWorkspaceScmSnapshot(scope);
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
            return false;
        }
        return applied;
    }, [
        diffContent,
        diffMode,
        filePath,
        includeExcludeEnabled,
        lineSelectionEnabled,
        mountedRef,
        refreshAll,
        scmCommitStrategy,
        scmSnapshot,
        scmWriteEnabled,
        scope,
        selectedLineKeys,
        setIsApplyingStageSafe,
        setSelectedLineKeys,
    ]);

    return {
        isApplyingStage,
        handleStage,
        applySelectedLines,
    };
}
