import * as React from 'react';
import {
    mergeTurnChangeSets,
    type ChangeEvidenceSource,
    type FileChangeEvidence,
    type RepositoryCheckpointTurnMetadata,
    type SessionChangeSet,
    type SessionChangeSetFile,
    type TurnChangeSet,
} from '@happier-dev/protocol';

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
    latestTurnEvidence?: TurnChangeSet | null;
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
    showTurnAgentReportedViewToggle: boolean;
    showTurnCheckpointViewToggle: boolean;
    turnCheckpointMetadata: RepositoryCheckpointTurnMetadata | null;
    showSessionViewToggle: boolean;
    scmStatusFiles: ScmStatusFiles | null;
    changedFilesCount: number;
    shouldShowAllFiles: boolean;
    allRepositoryChangedFiles: ScmFileStatus[];
    turnAttributedFiles: SessionAttributedFile[];
    turnAgentReportedFiles: SessionAttributedFile[];
    turnCheckpointFiles: SessionAttributedFile[];
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

const AGENT_REPORTED_TURN_SOURCES = new Set<ChangeEvidenceSource>([
    'provider_native',
    'provider_tool',
    'canonical_diff_tool',
    'canonical_patch_tool',
]);

function filterTurnEvidence(params: Readonly<{
    sessionId: string;
    turn: TurnChangeSet | null;
    acceptSource: (source: ChangeEvidenceSource) => boolean;
}>): SessionChangeSet | null {
    if (!params.turn) return null;
    const files = params.turn.files.filter((file) => params.acceptSource(file.source));
    if (files.length === 0) return null;
    return mergeTurnChangeSets({
        sessionId: params.sessionId,
        turns: [{
            ...params.turn,
            files,
        }],
        rolledBackTurnIds: [],
    });
}

function buildTurnEvidenceChangeSet(params: Readonly<{
    sessionId: string;
    turn: TurnChangeSet | null;
}>): SessionChangeSet | null {
    if (!params.turn || params.turn.files.length === 0) return null;
    return mergeTurnChangeSets({
        sessionId: params.sessionId,
        turns: [params.turn],
        rolledBackTurnIds: [],
    });
}

function mapEvidenceChangeKindToStatus(kind: FileChangeEvidence['changeKind']): ScmFileStatus['status'] {
    if (kind === 'added') return 'added';
    if (kind === 'deleted') return 'deleted';
    if (kind === 'renamed') return 'renamed';
    if (kind === 'copied') return 'copied';
    return 'modified';
}

function countUnifiedDiffStats(diff: string | null | undefined): Pick<ScmFileStatus, 'linesAdded' | 'linesRemoved'> {
    if (!diff) return { linesAdded: 0, linesRemoved: 0 };
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) {
            linesAdded += 1;
            continue;
        }
        if (line.startsWith('-')) {
            linesRemoved += 1;
        }
    }
    return { linesAdded, linesRemoved };
}

function buildEvidenceFileStatus(file: SessionChangeSetFile): ScmFileStatus {
    const fullPath = file.filePath;
    const segments = fullPath.split('/');
    const fileName = segments[segments.length - 1] || fullPath;
    const filePath = segments.slice(0, -1).join('/');
    const stats = countUnifiedDiffStats(file.unifiedDiff);
    return {
        fileName,
        filePath,
        fullPath,
        status: mapEvidenceChangeKindToStatus(file.changeKind),
        isIncluded: false,
        linesAdded: stats.linesAdded,
        linesRemoved: stats.linesRemoved,
        oldPath: file.previousFilePath ?? undefined,
        isBinary: file.binary,
    };
}

function buildProviderBackedScope(params: Readonly<{
    allRepositoryChangedFiles: readonly ScmFileStatus[];
    projection: NonNullable<ReturnType<typeof deriveSessionWorkingTreeProjection>>;
    includeUnmatchedEvidence?: boolean;
}>): ScopedProjectionResult {
    const filesByPath = new Map(params.allRepositoryChangedFiles.map((file) => [file.fullPath, file] as const));
    const matchedAttributedFiles = params.projection.matchedFiles
        .map((match) => filesByPath.get(match.repositoryPath))
        .filter((file): file is ScmFileStatus => Boolean(file))
        .map((file) => ({ file, confidence: 'high' as const }));
    const matchedPaths = new Set(matchedAttributedFiles.map((entry) => entry.file.fullPath));
    const unmatchedAttributedFiles = params.includeUnmatchedEvidence === true
        ? params.projection.unmatchedSessionFiles
            .map((file) => ({ file: buildEvidenceFileStatus(file), confidence: 'high' as const }))
            .filter((entry) => !matchedPaths.has(entry.file.fullPath))
        : [];
    const attributedFiles = [...matchedAttributedFiles, ...unmatchedAttributedFiles];
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
        latestTurnEvidence = null,
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

    const latestTurnEvidenceChangeSet = React.useMemo(() => {
        return buildTurnEvidenceChangeSet({
            sessionId,
            turn: latestTurnEvidence,
        });
    }, [latestTurnEvidence, sessionId]);

    const latestTurnProjection = React.useMemo(() => {
        const sourceChangeSet = latestTurnChangeSet ?? latestTurnEvidenceChangeSet;
        return deriveSessionWorkingTreeProjection({
            sessionChangeSet: sourceChangeSet,
            snapshot: scmSnapshot,
        });
    }, [latestTurnChangeSet, latestTurnEvidenceChangeSet, scmSnapshot]);

    const latestTurnAgentReportedChangeSet = React.useMemo(() => {
        return filterTurnEvidence({
            sessionId,
            turn: latestTurnEvidence,
            acceptSource: (source) => AGENT_REPORTED_TURN_SOURCES.has(source),
        });
    }, [latestTurnEvidence, sessionId]);

    const latestTurnCheckpointChangeSet = React.useMemo(() => {
        return filterTurnEvidence({
            sessionId,
            turn: latestTurnEvidence,
            acceptSource: (source) => source === 'scm_checkpoint',
        });
    }, [latestTurnEvidence, sessionId]);

    const latestTurnAgentReportedProjection = React.useMemo(() => {
        return deriveSessionWorkingTreeProjection({
            sessionChangeSet: latestTurnAgentReportedChangeSet,
            snapshot: scmSnapshot,
        });
    }, [latestTurnAgentReportedChangeSet, scmSnapshot]);

    const latestTurnCheckpointProjection = React.useMemo(() => {
        return deriveSessionWorkingTreeProjection({
            sessionChangeSet: latestTurnCheckpointChangeSet,
            snapshot: scmSnapshot,
        });
    }, [latestTurnCheckpointChangeSet, scmSnapshot]);

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
                includeUnmatchedEvidence: latestTurnEvidenceChangeSet !== null,
            });
        }

        return {
            attributedFiles: [],
            repositoryOnlyFiles: allRepositoryChangedFiles,
            suppressedInferredCount: 0,
            hasProviderProjection: false,
        };
    }, [allRepositoryChangedFiles, computeAttribution, latestTurnChangeSet, latestTurnEvidenceChangeSet, latestTurnProjection]);

    const turnAgentReportedScope = React.useMemo<ScopedProjectionResult>(() => {
        if (!computeAttribution) {
            return {
                attributedFiles: [],
                repositoryOnlyFiles: allRepositoryChangedFiles,
                suppressedInferredCount: 0,
                hasProviderProjection: false,
            };
        }

        if (latestTurnAgentReportedProjection) {
            return buildProviderBackedScope({
                allRepositoryChangedFiles,
                projection: latestTurnAgentReportedProjection,
                includeUnmatchedEvidence: true,
            });
        }

        return {
            attributedFiles: [],
            repositoryOnlyFiles: allRepositoryChangedFiles,
            suppressedInferredCount: 0,
            hasProviderProjection: false,
        };
    }, [allRepositoryChangedFiles, computeAttribution, latestTurnAgentReportedProjection]);

    const turnCheckpointScope = React.useMemo<ScopedProjectionResult>(() => {
        if (!computeAttribution) {
            return {
                attributedFiles: [],
                repositoryOnlyFiles: allRepositoryChangedFiles,
                suppressedInferredCount: 0,
                hasProviderProjection: false,
            };
        }

        if (latestTurnCheckpointProjection) {
            return buildProviderBackedScope({
                allRepositoryChangedFiles,
                projection: latestTurnCheckpointProjection,
                includeUnmatchedEvidence: true,
            });
        }

        return {
            attributedFiles: [],
            repositoryOnlyFiles: allRepositoryChangedFiles,
            suppressedInferredCount: 0,
            hasProviderProjection: false,
        };
    }, [allRepositoryChangedFiles, computeAttribution, latestTurnCheckpointProjection]);

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
        if (latestTurnEvidence?.files.length) return true;
        return turnScope.attributedFiles.length > 0;
    }, [computeAttribution, latestTurnEvidence?.files.length, turnScope.attributedFiles.length]);

    const showTurnAgentReportedViewToggle = React.useMemo(() => {
        if (!computeAttribution) return false;
        if (latestTurnAgentReportedChangeSet?.files.length) return true;
        return turnAgentReportedScope.attributedFiles.length > 0;
    }, [computeAttribution, latestTurnAgentReportedChangeSet?.files.length, turnAgentReportedScope.attributedFiles.length]);

    const showTurnCheckpointViewToggle = React.useMemo(() => {
        if (!computeAttribution) return false;
        return Boolean(latestTurnEvidence?.repositoryCheckpoint)
            || Boolean(latestTurnCheckpointChangeSet?.files.length)
            || turnCheckpointScope.attributedFiles.length > 0;
    }, [
        computeAttribution,
        latestTurnCheckpointChangeSet?.files.length,
        latestTurnEvidence?.repositoryCheckpoint,
        turnCheckpointScope.attributedFiles.length,
    ]);

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
        showTurnAgentReportedViewToggle,
        showTurnCheckpointViewToggle,
        turnCheckpointMetadata: latestTurnEvidence?.repositoryCheckpoint ?? null,
        showSessionViewToggle,
        scmStatusFiles,
        changedFilesCount,
        shouldShowAllFiles,
        allRepositoryChangedFiles,
        turnAttributedFiles: turnScope.attributedFiles,
        turnAgentReportedFiles: turnAgentReportedScope.attributedFiles,
        turnCheckpointFiles: turnCheckpointScope.attributedFiles,
        turnRepositoryOnlyFiles: turnScope.repositoryOnlyFiles,
        sessionAttributedFiles: sessionScope.attributedFiles,
        repositoryOnlyFiles: sessionScope.repositoryOnlyFiles,
        suppressedInferredCount: sessionScope.suppressedInferredCount,
    };
}
