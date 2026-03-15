import * as React from 'react';

import { fireAndForget } from '@/utils/system/fireAndForget';
import { storage } from '@/sync/domains/state/storage';
import { applyBulkFileStageAction } from '@/scm/operations/applyBulkFileStageAction';
import { applyFileStageAction } from '@/scm/operations/applyFileStageAction';
import { countCommitSelectionItems } from '@/scm/operations/commitSelectionHints';
import { isAtomicCommitStrategy, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmCommitSelectionPatch, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export type SessionFilesCommitSelectionState = Readonly<{
    commitSelectionCount: number;
    repositorySelectedCount: number;
    disableSelectAll: boolean;
    disableSelectNone: boolean;
    bulkSelectAll: () => void;
    bulkSelectNone: () => void;
    toggleCommitSelectionForFile: (file: ScmFileStatus) => void;
    isSelectedForCommit: (file: ScmFileStatus) => boolean;
}>;

export function useSessionFilesCommitSelectionState(input: Readonly<{
    sessionId: string;
    sessionPath: string | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    allRepositoryChangedFiles: readonly ScmFileStatus[];
    commitSelectionPaths: readonly string[];
    commitSelectionPatches: readonly ScmCommitSelectionPatch[];
}>): SessionFilesCommitSelectionState {
    const commitSelectionCount = React.useMemo(() => {
        return countCommitSelectionItems({
            commitSelectionPaths: input.commitSelectionPaths,
            commitSelectionPatches: input.commitSelectionPatches,
        });
    }, [input.commitSelectionPatches, input.commitSelectionPaths]);

    const commitSelectionSet = React.useMemo(() => {
        const out = new Set<string>();
        for (const path of input.commitSelectionPaths) {
            const normalized = path.trim();
            if (normalized) out.add(normalized);
        }
        for (const patchSelection of input.commitSelectionPatches) {
            const normalized = patchSelection.path.trim();
            if (normalized) out.add(normalized);
        }
        return out;
    }, [input.commitSelectionPatches, input.commitSelectionPaths]);

    const isSelectedForCommit = React.useCallback((file: ScmFileStatus) => {
        const atomic = isAtomicCommitStrategy(input.scmCommitStrategy);
        return atomic ? commitSelectionSet.has(file.fullPath) : file.isIncluded === true;
    }, [commitSelectionSet, input.scmCommitStrategy]);

    const repositorySelectedCount = React.useMemo(() => {
        if (isAtomicCommitStrategy(input.scmCommitStrategy)) {
            return commitSelectionCount;
        }
        return input.allRepositoryChangedFiles.filter((file) => isSelectedForCommit(file)).length;
    }, [commitSelectionCount, input.allRepositoryChangedFiles, input.scmCommitStrategy, isSelectedForCommit]);

    const allChangedPaths = React.useMemo(
        () => input.allRepositoryChangedFiles.map((file) => file.fullPath),
        [input.allRepositoryChangedFiles]
    );

    const bulkSelectAll = React.useCallback(() => {
        if (!input.scmWriteEnabled) return;
        fireAndForget(
            applyBulkFileStageAction({
                sessionId: input.sessionId,
                sessionPath: input.sessionPath,
                snapshot: input.scmSnapshot,
                scmWriteEnabled: input.scmWriteEnabled,
                commitStrategy: input.scmCommitStrategy,
                stage: true,
                paths: allChangedPaths,
                surface: 'files',
            }),
            { tag: 'SessionFilesScreenView.bulkSelectAll' }
        );
    }, [allChangedPaths, input.scmCommitStrategy, input.scmSnapshot, input.scmWriteEnabled, input.sessionId, input.sessionPath]);

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
            { tag: 'SessionFilesScreenView.bulkSelectNone' }
        );
    }, [allChangedPaths, input.scmCommitStrategy, input.scmSnapshot, input.scmWriteEnabled, input.sessionId, input.sessionPath]);

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
            { tag: 'SessionFilesScreenView.toggleCommitSelectionForFile' }
        );
    }, [input.scmWriteEnabled, input.sessionId, input.sessionPath, input.scmSnapshot, input.scmCommitStrategy, isSelectedForCommit]);

    const disableSelectAll = !input.scmWriteEnabled
        || !input.sessionPath
        || input.allRepositoryChangedFiles.length === 0
        || (!isAtomicCommitStrategy(input.scmCommitStrategy) && input.scmSnapshot?.capabilities?.writeInclude !== true);
    const disableSelectNone = !input.scmWriteEnabled
        || input.allRepositoryChangedFiles.length === 0
        || (!input.sessionPath && !isAtomicCommitStrategy(input.scmCommitStrategy))
        || (!isAtomicCommitStrategy(input.scmCommitStrategy) && input.scmSnapshot?.capabilities?.writeExclude !== true);

    return {
        commitSelectionCount,
        repositorySelectedCount,
        disableSelectAll,
        disableSelectNone,
        bulkSelectAll,
        bulkSelectNone,
        toggleCommitSelectionForFile,
        isSelectedForCommit,
    };
}
