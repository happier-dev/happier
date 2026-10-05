import * as React from 'react';

import { applyBulkFileStageAction } from '@/scm/operations/applyBulkFileStageAction';
import { applyFileStageAction } from '@/scm/operations/applyFileStageAction';
import { isAtomicCommitStrategy, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { storage } from '@/sync/domains/state/storage';
import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isFileSelectedForCommit as resolveFileSelectedForCommit } from '@/scm/operations/commitSelectionHints';
import type { ScmCommitPlanGroupSelection } from '@/sync/domains/scm/diffSummary/commitPlanSelection';

export type UseSessionRightPanelGitCommitSelectionInput = Readonly<{
    sessionId: string;
    serverId?: string;
    sessionPath: string | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    commitSelectionPaths: readonly string[];
    commitSelectionPatches: readonly ScmCommitSelectionPatch[];
    changedFiles: readonly ScmFileStatus[];
    /**
     * A selected proposal is a view state (lab WT4-C2): selection writes pause while it is shown, but the
     * checkboxes keep meaning what will be committed; the proposal's own rows are highlighted by the list.
     */
    proposedGroupSelection?: ScmCommitPlanGroupSelection | null;
}>;

export type UseSessionRightPanelGitCommitSelectionResult = Readonly<{
    repositorySelectedCount: number;
    isSelectedForCommit: (file: ScmFileStatus) => boolean;
    toggleCommitSelectionForFile: (file: ScmFileStatus) => void;
    bulkSelectAll: () => void;
    bulkSelectFiles: (files: readonly ScmFileStatus[]) => void;
    /** Clears just these files from the commit selection (a change group's header checkbox). */
    bulkDeselectFiles: (files: readonly ScmFileStatus[]) => void;
    bulkSelectNone: () => void;
    disableSelectAll: boolean;
    disableSelectNone: boolean;
}>;

export function useSessionRightPanelGitCommitSelection(
    input: UseSessionRightPanelGitCommitSelectionInput
): UseSessionRightPanelGitCommitSelectionResult {
    const selectionWriteEnabled = input.scmWriteEnabled && !input.proposedGroupSelection;
    const commitSelectionSet = React.useMemo(() => {
        const set = new Set<string>();
        for (const p of input.commitSelectionPaths) set.add(p);
        for (const patch of input.commitSelectionPatches) set.add(patch.path);
        return set;
    }, [input.commitSelectionPatches, input.commitSelectionPaths]);

    const isSelectedForCommit = React.useCallback((file: ScmFileStatus) => {
        return resolveFileSelectedForCommit({
            commitStrategy: input.scmCommitStrategy,
            file,
            atomicSelectionPaths: commitSelectionSet,
        });
    }, [commitSelectionSet, input.scmCommitStrategy]);

    const repositorySelectedCount = React.useMemo(() => {
        return input.changedFiles.filter((file) => isSelectedForCommit(file)).length;
    }, [input.changedFiles, isSelectedForCommit]);

    const toggleCommitSelectionForFile = React.useCallback((file: ScmFileStatus) => {
        if (!selectionWriteEnabled) return;
        fireAndForget(
            applyFileStageAction({
                sessionId: input.sessionId, serverId: input.serverId,
                sessionPath: input.sessionPath,
                filePath: file.fullPath,
                snapshot: input.scmSnapshot,
                scmWriteEnabled: input.scmWriteEnabled,
                commitStrategy: input.scmCommitStrategy,
                stage: !isSelectedForCommit(file),
                surface: 'files',
            }),
            { tag: 'useSessionRightPanelGitCommitSelection.toggleCommitSelectionForFile' }
        );
    }, [input.scmCommitStrategy, input.scmSnapshot, input.scmWriteEnabled, input.sessionId, input.serverId, input.sessionPath, isSelectedForCommit, selectionWriteEnabled]);

    const allChangedPaths = React.useMemo(
        () => input.changedFiles.map((file) => file.fullPath),
        [input.changedFiles]
    );

    const bulkSetPaths = React.useCallback((paths: readonly string[], stage: boolean, tag: string) => {
        if (!selectionWriteEnabled) return;
        fireAndForget(
            applyBulkFileStageAction({
                sessionId: input.sessionId, serverId: input.serverId,
                sessionPath: input.sessionPath,
                snapshot: input.scmSnapshot,
                scmWriteEnabled: input.scmWriteEnabled,
                commitStrategy: input.scmCommitStrategy,
                stage,
                paths,
                surface: 'files',
            }),
            { tag }
        );
    }, [input.scmCommitStrategy, input.scmSnapshot, input.scmWriteEnabled, input.sessionId, input.serverId, input.sessionPath, selectionWriteEnabled]);
    const bulkSelectPaths = React.useCallback(
        (paths: readonly string[], tag: string) => bulkSetPaths(paths, true, tag),
        [bulkSetPaths],
    );

    const bulkDeselectFiles = React.useCallback((files: readonly ScmFileStatus[]) => {
        bulkSetPaths(files.map((file) => file.fullPath), false, 'useSessionRightPanelGitCommitSelection.bulkDeselectFiles');
    }, [bulkSetPaths]);

    const bulkSelectAll = React.useCallback(() => {
        bulkSelectPaths(allChangedPaths, 'useSessionRightPanelGitCommitSelection.bulkSelectAll');
    }, [allChangedPaths, bulkSelectPaths]);

    const bulkSelectFiles = React.useCallback((files: readonly ScmFileStatus[]) => {
        bulkSelectPaths(
            files.map((file) => file.fullPath),
            'useSessionRightPanelGitCommitSelection.bulkSelectFiles',
        );
    }, [bulkSelectPaths]);

    const bulkSelectNone = React.useCallback(() => {
        if (!selectionWriteEnabled) return;
        if (isAtomicCommitStrategy(input.scmCommitStrategy)) {
            storage.getState().clearSessionProjectScmCommitSelectionPaths(input.sessionId, input.serverId);
            storage.getState().clearSessionProjectScmCommitSelectionPatches(input.sessionId, input.serverId);
            return;
        }

        fireAndForget(
            applyBulkFileStageAction({
                sessionId: input.sessionId, serverId: input.serverId,
                sessionPath: input.sessionPath,
                snapshot: input.scmSnapshot,
                scmWriteEnabled: input.scmWriteEnabled,
                commitStrategy: input.scmCommitStrategy,
                stage: false,
                paths: allChangedPaths,
                surface: 'files',
            }),
            { tag: 'useSessionRightPanelGitCommitSelection.bulkSelectNone' }
        );
    }, [allChangedPaths, input.scmCommitStrategy, input.scmSnapshot, input.scmWriteEnabled, input.sessionId, input.serverId, input.sessionPath, selectionWriteEnabled]);

    const disableSelectAll = !selectionWriteEnabled
        || !input.sessionPath
        || input.changedFiles.length === 0
        || (!isAtomicCommitStrategy(input.scmCommitStrategy) && input.scmSnapshot?.capabilities?.writeInclude !== true);

    const disableSelectNone = !selectionWriteEnabled
        || input.changedFiles.length === 0
        || (!input.sessionPath && !isAtomicCommitStrategy(input.scmCommitStrategy))
        || (!isAtomicCommitStrategy(input.scmCommitStrategy) && input.scmSnapshot?.capabilities?.writeExclude !== true);

    return {
        repositorySelectedCount,
        isSelectedForCommit,
        toggleCommitSelectionForFile,
        bulkSelectAll,
        bulkSelectFiles,
        bulkDeselectFiles,
        bulkSelectNone,
        disableSelectAll,
        disableSelectNone,
    };
}
