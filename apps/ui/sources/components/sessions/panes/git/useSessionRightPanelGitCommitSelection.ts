import * as React from 'react';

import { applyBulkFileStageAction } from '@/scm/operations/applyBulkFileStageAction';
import { applyFileStageAction } from '@/scm/operations/applyFileStageAction';
import { isAtomicCommitStrategy, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { storage } from '@/sync/domains/state/storage';
import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type UseSessionRightPanelGitCommitSelectionInput = Readonly<{
    sessionId: string;
    sessionPath: string | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    commitSelectionPaths: readonly string[];
    commitSelectionPatches: readonly ScmCommitSelectionPatch[];
    changedFiles: readonly ScmFileStatus[];
}>;

export type UseSessionRightPanelGitCommitSelectionResult = Readonly<{
    repositorySelectedCount: number;
    isSelectedForCommit: (file: ScmFileStatus) => boolean;
    toggleCommitSelectionForFile: (file: ScmFileStatus) => void;
    bulkSelectAll: () => void;
    bulkSelectFiles: (files: readonly ScmFileStatus[]) => void;
    bulkSelectNone: () => void;
    disableSelectAll: boolean;
    disableSelectNone: boolean;
}>;

export function useSessionRightPanelGitCommitSelection(
    input: UseSessionRightPanelGitCommitSelectionInput
): UseSessionRightPanelGitCommitSelectionResult {
    const commitSelectionSet = React.useMemo(() => {
        const set = new Set<string>();
        for (const p of input.commitSelectionPaths) set.add(p);
        for (const patch of input.commitSelectionPatches) set.add(patch.path);
        return set;
    }, [input.commitSelectionPatches, input.commitSelectionPaths]);

    const isSelectedForCommit = React.useCallback((file: ScmFileStatus) => {
        const atomic = isAtomicCommitStrategy(input.scmCommitStrategy);
        return atomic ? commitSelectionSet.has(file.fullPath) : file.isIncluded === true;
    }, [commitSelectionSet, input.scmCommitStrategy]);

    const repositorySelectedCount = React.useMemo(() => {
        return input.changedFiles.filter((file) => isSelectedForCommit(file)).length;
    }, [input.changedFiles, isSelectedForCommit]);

    const toggleCommitSelectionForFile = React.useCallback((file: ScmFileStatus) => {
        if (!input.scmWriteEnabled) return;
        fireAndForget(
            applyFileStageAction({
                sessionId: input.sessionId,
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
    }, [input.scmCommitStrategy, input.scmSnapshot, input.scmWriteEnabled, input.sessionId, input.sessionPath, isSelectedForCommit]);

    const allChangedPaths = React.useMemo(
        () => input.changedFiles.map((file) => file.fullPath),
        [input.changedFiles]
    );

    const bulkSelectPaths = React.useCallback((paths: readonly string[], tag: string) => {
        if (!input.scmWriteEnabled) return;
        fireAndForget(
            applyBulkFileStageAction({
                sessionId: input.sessionId,
                sessionPath: input.sessionPath,
                snapshot: input.scmSnapshot,
                scmWriteEnabled: input.scmWriteEnabled,
                commitStrategy: input.scmCommitStrategy,
                stage: true,
                paths,
                surface: 'files',
            }),
            { tag }
        );
    }, [input.scmCommitStrategy, input.scmSnapshot, input.scmWriteEnabled, input.sessionId, input.sessionPath]);

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
        if (!input.scmWriteEnabled) return;
        if (isAtomicCommitStrategy(input.scmCommitStrategy)) {
            storage.getState().clearSessionProjectScmCommitSelectionPaths(input.sessionId);
            storage.getState().clearSessionProjectScmCommitSelectionPatches(input.sessionId);
            return;
        }

        fireAndForget(
            applyBulkFileStageAction({
                sessionId: input.sessionId,
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
    }, [allChangedPaths, input.scmCommitStrategy, input.scmSnapshot, input.scmWriteEnabled, input.sessionId, input.sessionPath]);

    const disableSelectAll = !input.scmWriteEnabled
        || !input.sessionPath
        || input.changedFiles.length === 0
        || (!isAtomicCommitStrategy(input.scmCommitStrategy) && input.scmSnapshot?.capabilities?.writeInclude !== true);

    const disableSelectNone = !input.scmWriteEnabled
        || input.changedFiles.length === 0
        || (!input.sessionPath && !isAtomicCommitStrategy(input.scmCommitStrategy))
        || (!isAtomicCommitStrategy(input.scmCommitStrategy) && input.scmSnapshot?.capabilities?.writeExclude !== true);

    return {
        repositorySelectedCount,
        isSelectedForCommit,
        toggleCommitSelectionForFile,
        bulkSelectAll,
        bulkSelectFiles,
        bulkSelectNone,
        disableSelectAll,
        disableSelectNone,
    };
}
