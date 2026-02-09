import * as React from 'react';

import type { GitProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';
import type { GitWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    buildChangedFilesAttribution,
    canOfferSessionChangedFilesView,
    getSessionAttributionReliability,
    type SessionAttributionReliability,
} from '@/sync/git/gitAttribution';
import { snapshotToGitStatusFiles, type GitFileStatus, type GitStatusFiles } from '@/sync/git/gitStatusFiles';

import { buildAllRepositoryChangedFiles } from '../utils';

type UseChangedFilesDataInput = {
    sessionId: string;
    gitSnapshot: GitWorkingSnapshot | null;
    touchedPaths: string[];
    operationLog: GitProjectOperationLogEntry[];
    projectSessionIds: string[];
    searchQuery: string;
    showAllRepositoryFiles: boolean;
};

export type UseChangedFilesDataResult = {
    attributionReliability: SessionAttributionReliability;
    showSessionViewToggle: boolean;
    gitStatusFiles: GitStatusFiles | null;
    changedFilesCount: number;
    shouldShowAllFiles: boolean;
    allRepositoryChangedFiles: GitFileStatus[];
    sessionAttributedFiles: ReturnType<typeof buildChangedFilesAttribution>['sessionAttributedFiles'];
    repositoryOnlyFiles: GitFileStatus[];
    suppressedInferredCount: number;
};

export function useChangedFilesData(input: UseChangedFilesDataInput): UseChangedFilesDataResult {
    const {
        sessionId,
        gitSnapshot,
        touchedPaths,
        operationLog,
        projectSessionIds,
        searchQuery,
        showAllRepositoryFiles,
    } = input;

    const otherSessionCountInProject = React.useMemo(
        () => projectSessionIds.filter((value) => value !== sessionId).length,
        [projectSessionIds, sessionId]
    );

    const attributionReliability = React.useMemo(
        () =>
            getSessionAttributionReliability({
                otherSessionCountInProject,
            }),
        [otherSessionCountInProject]
    );

    const includeInferredAttribution = attributionReliability === 'high';

    const gitStatusFiles = React.useMemo(() => {
        if (!gitSnapshot?.repo.isGitRepo) {
            return null;
        }
        return snapshotToGitStatusFiles(gitSnapshot);
    }, [gitSnapshot]);

    const changedFilesCount = (gitStatusFiles?.totalStaged ?? 0) + (gitStatusFiles?.totalUnstaged ?? 0);
    const shouldShowAllFiles = Boolean(searchQuery) || showAllRepositoryFiles || changedFilesCount === 0;

    const allRepositoryChangedFiles = React.useMemo(
        () => buildAllRepositoryChangedFiles(gitStatusFiles),
        [gitStatusFiles]
    );

    const sessionOperationLog = React.useMemo(
        () => operationLog.filter((entry) => entry.sessionId === sessionId),
        [operationLog, sessionId]
    );

    const { sessionAttributedFiles, repositoryOnlyFiles, suppressedInferredCount } = React.useMemo(
        () =>
            buildChangedFilesAttribution({
                allChangedFiles: allRepositoryChangedFiles,
                touchedPaths,
                operationLog: sessionOperationLog,
                includeInferred: includeInferredAttribution,
            }),
        [allRepositoryChangedFiles, includeInferredAttribution, sessionOperationLog, touchedPaths]
    );
    const highConfidenceAttributionCount = React.useMemo(
        () => sessionAttributedFiles.filter((entry) => entry.confidence === 'high').length,
        [sessionAttributedFiles]
    );
    const showSessionViewToggle = React.useMemo(
        () =>
            canOfferSessionChangedFilesView({
                reliability: attributionReliability,
                highConfidenceAttributionCount,
            }),
        [attributionReliability, highConfidenceAttributionCount]
    );

    return {
        attributionReliability,
        showSessionViewToggle,
        gitStatusFiles,
        changedFilesCount,
        shouldShowAllFiles,
        allRepositoryChangedFiles,
        sessionAttributedFiles,
        repositoryOnlyFiles,
        suppressedInferredCount,
    };
}
