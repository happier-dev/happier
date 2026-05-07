import * as React from 'react';
import type { SessionChangeSet } from '@happier-dev/protocol';

import type { ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    buildChangedFilesAttribution,
    canOfferSessionChangedFilesView,
    getSessionAttributionReliability,
    type SessionAttributedFile,
    type SessionAttributionReliability,
} from '@/scm/scmAttribution';
import { snapshotToScmStatusFiles, type ScmFileStatus, type ScmStatusFiles } from '@/scm/scmStatusFiles';
import { deriveSessionWorkingTreeProjection } from '@/sync/domains/session/changes/derivation/deriveSessionWorkingTreeProjection';

import { buildAllRepositoryChangedFiles } from '@/components/sessions/files/filesUtils';

type UseChangedFilesDataInput = {
    sessionId: string;
    scmSnapshot: ScmWorkingSnapshot | null;
    touchedPaths: readonly string[];
    operationLog: readonly ScmProjectOperationLogEntry[];
    projectSessionIds: readonly string[];
    searchQuery: string;
    showAllRepositoryFiles: boolean;
    latestTurnChangeSet?: SessionChangeSet | null;
    sessionChangeSet?: SessionChangeSet | null;
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
    showTurnViewToggle: boolean;
    showSessionViewToggle: boolean;
    scmStatusFiles: ScmStatusFiles | null;
    changedFilesCount: number;
    shouldShowAllFiles: boolean;
    allRepositoryChangedFiles: ScmFileStatus[];
    turnAttributedFiles: SessionAttributedFile[];
    turnRepositoryOnlyFiles: ScmFileStatus[];
    sessionAttributedFiles: ReturnType<typeof buildChangedFilesAttribution>['sessionAttributedFiles'];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
};

type ScopedProjectionResult = Readonly<{
    attributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
    hasProviderProjection: boolean;
}>;

function buildProviderBackedScope(params: Readonly<{
    allRepositoryChangedFiles: readonly ScmFileStatus[];
    projection: NonNullable<ReturnType<typeof deriveSessionWorkingTreeProjection>>;
}>): ScopedProjectionResult {
    const filesByPath = new Map(params.allRepositoryChangedFiles.map((file) => [file.fullPath, file] as const));
    const attributedFiles = params.projection.matchedFiles
        .map((match) => filesByPath.get(match.repositoryPath))
        .filter((file): file is ScmFileStatus => Boolean(file))
        .map((file) => ({ file, confidence: 'high' as const }));
    const attributedPaths = new Set(attributedFiles.map((entry) => entry.file.fullPath));
    return {
        attributedFiles,
        repositoryOnlyFiles: params.allRepositoryChangedFiles.filter((file) => !attributedPaths.has(file.fullPath)),
        suppressedInferredCount: 0,
        hasProviderProjection: true,
    };
}

export function useChangedFilesData(input: UseChangedFilesDataInput): UseChangedFilesDataResult {
    const {
        sessionId,
        scmSnapshot,
        touchedPaths,
        operationLog,
        projectSessionIds,
        searchQuery,
        showAllRepositoryFiles,
        latestTurnChangeSet = null,
        sessionChangeSet = null,
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

    const latestTurnProjection = React.useMemo(() => {
        return deriveSessionWorkingTreeProjection({
            sessionChangeSet: latestTurnChangeSet,
            snapshot: scmSnapshot,
        });
    }, [latestTurnChangeSet, scmSnapshot]);

    const sessionProjection = React.useMemo(() => {
        return deriveSessionWorkingTreeProjection({
            sessionChangeSet,
            snapshot: scmSnapshot,
        });
    }, [scmSnapshot, sessionChangeSet]);

    const turnScope = React.useMemo<ScopedProjectionResult>(() => {
        if (!computeAttribution) {
            return {
                attributedFiles: [],
                repositoryOnlyFiles: allRepositoryChangedFiles,
                suppressedInferredCount: 0,
                hasProviderProjection: false,
            };
        }

        if (latestTurnProjection) {
            return buildProviderBackedScope({
                allRepositoryChangedFiles,
                projection: latestTurnProjection,
            });
        }

        return {
            attributedFiles: [],
            repositoryOnlyFiles: allRepositoryChangedFiles,
            suppressedInferredCount: 0,
            hasProviderProjection: false,
        };
    }, [allRepositoryChangedFiles, computeAttribution, latestTurnProjection]);

    const sessionScope = React.useMemo<ScopedProjectionResult>(() => {
        if (!computeAttribution) {
            return {
                attributedFiles: [],
                repositoryOnlyFiles: allRepositoryChangedFiles,
                suppressedInferredCount: 0,
                hasProviderProjection: false,
            };
        }

        if (sessionProjection) {
            return buildProviderBackedScope({
                allRepositoryChangedFiles,
                projection: sessionProjection,
            });
        }

        const inferred = buildChangedFilesAttribution({
            allChangedFiles: allRepositoryChangedFiles,
            touchedPaths,
            operationLog: sessionOperationLog,
            includeInferred: includeInferredAttribution,
        });
        return {
            attributedFiles: inferred.sessionAttributedFiles,
            repositoryOnlyFiles: inferred.repositoryOnlyFiles,
            suppressedInferredCount: inferred.suppressedInferredCount,
            hasProviderProjection: false,
        };
    }, [allRepositoryChangedFiles, computeAttribution, includeInferredAttribution, sessionOperationLog, sessionProjection, touchedPaths]);

    const highConfidenceAttributionCount = React.useMemo(() => {
        if (!computeAttribution) return 0;
        return sessionScope.attributedFiles.filter((entry) => entry.confidence === 'high').length;
    }, [computeAttribution, sessionScope.attributedFiles]);

    const showTurnViewToggle = React.useMemo(() => {
        if (!computeAttribution) return false;
        return turnScope.attributedFiles.length > 0;
    }, [computeAttribution, turnScope.attributedFiles.length]);

    const showSessionViewToggle = React.useMemo(() => {
        if (!computeAttribution) return false;
        if (sessionScope.attributedFiles.length === 0) return false;
        if (sessionScope.hasProviderProjection) return true;
        return canOfferSessionChangedFilesView({
            reliability: attributionReliability,
            highConfidenceAttributionCount,
        });
    }, [attributionReliability, computeAttribution, highConfidenceAttributionCount, sessionScope.attributedFiles.length, sessionScope.hasProviderProjection]);

    return {
        attributionReliability: sessionScope.hasProviderProjection ? 'high' : attributionReliability,
        showTurnViewToggle,
        showSessionViewToggle,
        scmStatusFiles,
        changedFilesCount,
        shouldShowAllFiles,
        allRepositoryChangedFiles,
        turnAttributedFiles: turnScope.attributedFiles,
        turnRepositoryOnlyFiles: turnScope.repositoryOnlyFiles,
        sessionAttributedFiles: sessionScope.attributedFiles,
        repositoryOnlyFiles: sessionScope.repositoryOnlyFiles,
        suppressedInferredCount: sessionScope.suppressedInferredCount,
    };
}
