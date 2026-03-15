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
    touchedPaths: readonly string[];
    operationLog: readonly ScmProjectOperationLogEntry[];
    projectSessionIds: readonly string[];
    searchQuery: string;
    showAllRepositoryFiles: boolean;
    /**
     * Optional performance knob for repository-only surfaces (e.g. SCM sidebar commit list)
     * that never need session attribution. When false, skip attribution work entirely.
     *
     * Defaults to true to preserve existing behavior.
     */
    computeAttribution?: boolean;
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
        computeAttribution = true,
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

    const { sessionAttributedFiles, repositoryOnlyFiles, suppressedInferredCount } = React.useMemo(() => {
        if (!computeAttribution) {
            return {
                sessionAttributedFiles: [],
                repositoryOnlyFiles: allRepositoryChangedFiles,
                suppressedInferredCount: 0,
            } satisfies Pick<UseChangedFilesDataResult, 'sessionAttributedFiles' | 'repositoryOnlyFiles' | 'suppressedInferredCount'>;
        }

        return buildChangedFilesAttribution({
            allChangedFiles: allRepositoryChangedFiles,
            touchedPaths,
            operationLog: sessionOperationLog,
            includeInferred: includeInferredAttribution,
        });
    }, [allRepositoryChangedFiles, computeAttribution, includeInferredAttribution, sessionOperationLog, touchedPaths]);

    const highConfidenceAttributionCount = React.useMemo(() => {
        if (!computeAttribution) return 0;
        return sessionAttributedFiles.filter((entry) => entry.confidence === 'high').length;
    }, [computeAttribution, sessionAttributedFiles]);

    const showSessionViewToggle = React.useMemo(() => {
        if (!computeAttribution) return false;
        return canOfferSessionChangedFilesView({
            reliability: attributionReliability,
            highConfidenceAttributionCount,
        });
    }, [attributionReliability, computeAttribution, highConfidenceAttributionCount]);

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
