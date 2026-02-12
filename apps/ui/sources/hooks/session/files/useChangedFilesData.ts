import * as React from 'react';

import type { ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    buildChangedFilesAttribution,
    canOfferSessionChangedFilesView,
    getSessionAttributionReliability,
    type SessionAttributionReliability,
} from '@/scm/scmAttribution';
import { snapshotToScmStatusFiles, type ScmFileStatus, type ScmStatusFiles } from '@/scm/scmStatusFiles';

import { buildAllRepositoryChangedFiles } from '@/components/sessions/files/filesUtils';

type UseChangedFilesDataInput = {
    sessionId: string;
    scmSnapshot: ScmWorkingSnapshot | null;
    touchedPaths: string[];
    operationLog: ScmProjectOperationLogEntry[];
    projectSessionIds: string[];
    searchQuery: string;
    showAllRepositoryFiles: boolean;
};

export type UseChangedFilesDataResult = {
    attributionReliability: SessionAttributionReliability;
    showSessionViewToggle: boolean;
    scmStatusFiles: ScmStatusFiles | null;
    changedFilesCount: number;
    shouldShowAllFiles: boolean;
    allRepositoryChangedFiles: ScmFileStatus[];
    sessionAttributedFiles: ReturnType<typeof buildChangedFilesAttribution>['sessionAttributedFiles'];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
};

export function useChangedFilesData(input: UseChangedFilesDataInput): UseChangedFilesDataResult {
    const {
        sessionId,
        scmSnapshot,
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

    const scmStatusFiles = React.useMemo(() => {
        if (!scmSnapshot?.repo.isRepo) {
            return null;
        }
        return snapshotToScmStatusFiles(scmSnapshot);
    }, [scmSnapshot]);

    const changedFilesCount = (scmStatusFiles?.totalIncluded ?? 0) + (scmStatusFiles?.totalPending ?? 0);
    const shouldShowAllFiles = Boolean(searchQuery) || showAllRepositoryFiles || changedFilesCount === 0;

    const allRepositoryChangedFiles = React.useMemo(
        () => buildAllRepositoryChangedFiles(scmStatusFiles),
        [scmStatusFiles]
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
        scmStatusFiles,
        changedFilesCount,
        shouldShowAllFiles,
        allRepositoryChangedFiles,
        sessionAttributedFiles,
        repositoryOnlyFiles,
        suppressedInferredCount,
    };
}
