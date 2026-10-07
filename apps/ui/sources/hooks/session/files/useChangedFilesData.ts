import * as React from 'react';
import { projectChangedFilesAttribution } from '@happier-dev/protocol/sessions/changes/mergeTurnChangeSets';
import type { CheckpointOverlapObservation, FileChangeEvidence, RepositoryCheckpointTurnMetadata, SessionChangeAttribution, SessionChangeSet, SessionChangeSetFile, TurnChangeSet, WorkspaceTouchedFileEvidence } from '@happier-dev/protocol/sessions/changes/types';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { SessionAttributedFile } from '@/scm/scmAttribution';
import { selectScmChangedFiles, snapshotToScmStatusFiles, type ScmFileStatus, type ScmStatusFiles } from '@/scm/scmStatusFiles';
import { deriveSessionWorkingTreeProjection } from '@/sync/domains/session/changes/derivation/deriveSessionWorkingTreeProjection';
import { buildScmFileStatusFromChangeEvidence } from '@/scm/scmEvidenceFileStatus';


type UseChangedFilesDataInput = {
    sessionId: string;
    scmSnapshot: ScmWorkingSnapshot | null;
    /** Workspace-wide touched paths; a low-confidence fallback, never Session authorship proof. */
    workspaceTouchedPaths: readonly string[];
    searchQuery: string;
    showAllRepositoryFiles: boolean;
    /** Canonical Session lifecycle identity, even when no Diff row was published. */
    latestTurnId?: string | null;
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
    sessionAttribution: SessionChangeAttribution;
    sessionCheckpointOverlap: CheckpointOverlapObservation;
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
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
};

type ScopedProjectionResult = Readonly<{
    attributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
}>;

const EMPTY_SCOPE_RESULT = (allRepositoryChangedFiles: ScmFileStatus[]): ScopedProjectionResult => ({
    attributedFiles: [],
    repositoryOnlyFiles: allRepositoryChangedFiles,
});

function mapScmStatusToChangeKind(file: ScmFileStatus): WorkspaceTouchedFileEvidence['changeKind'] {
    if (file.status === 'added' || file.status === 'untracked') return 'added';
    if (file.status === 'deleted' || file.status === 'renamed' || file.status === 'copied') return file.status;
    return 'modified';
}

function adaptWorkspaceTouchedFiles(
    allRepositoryChangedFiles: readonly ScmFileStatus[],
    workspaceTouchedPaths: readonly string[],
): WorkspaceTouchedFileEvidence[] {
    const touchedPaths = new Set(workspaceTouchedPaths);
    return allRepositoryChangedFiles
        .filter((file) => touchedPaths.has(file.fullPath))
        .map((file) => ({
            filePath: file.fullPath,
            changeKind: mapScmStatusToChangeKind(file),
            ...(file.isBinary === undefined ? {} : { binary: file.isBinary }),
        }));
}

function buildAttributedScope(params: Readonly<{
    allRepositoryChangedFiles: readonly ScmFileStatus[];
    projection: NonNullable<ReturnType<typeof deriveSessionWorkingTreeProjection>>;
    includeUnmatchedEvidence?: boolean;
    evidenceByFilePath: ReadonlyMap<string, readonly FileChangeEvidence[]>;
}>): ScopedProjectionResult {
    const qualify = (change: SessionChangeSetFile): Omit<SessionAttributedFile, 'file'> => ({
        turns: change.turns,
        content: { source: change.source, confidence: change.confidence },
        attribution: change.attribution,
        checkpointOverlap: change.checkpointOverlap,
        evidence: params.evidenceByFilePath.get(change.filePath) ?? [],
    });
    const filesByPath = new Map(params.allRepositoryChangedFiles.map((file) => [file.fullPath, file] as const));
    const matchedAttributedFiles = params.projection.matchedFiles
        .map((match) => {
            const file = filesByPath.get(match.repositoryPath);
            if (!file) return null;
            return { file, ...qualify(match.sessionChange) };
        })
        .filter((entry): entry is SessionAttributedFile => entry !== null);
    const matchedPaths = new Set(matchedAttributedFiles.map((entry) => entry.file.fullPath));
    const unmatchedAttributedFiles = params.includeUnmatchedEvidence === true
        ? params.projection.unmatchedSessionFiles
            .map((file) => ({
                file: buildScmFileStatusFromChangeEvidence(file),
                ...qualify(file),
            }))
            .filter((entry) => !matchedPaths.has(entry.file.fullPath))
        : [];
    const attributedFiles = [...matchedAttributedFiles, ...unmatchedAttributedFiles];
    const attributedPaths = new Set(attributedFiles.map((entry) => entry.file.fullPath));
    return {
        attributedFiles,
        repositoryOnlyFiles: params.allRepositoryChangedFiles.filter((file) => !attributedPaths.has(file.fullPath)),
    };
}

export function useChangedFilesData(input: UseChangedFilesDataInput): UseChangedFilesDataResult {
    const {
        sessionId,
        scmSnapshot,
        workspaceTouchedPaths,
        searchQuery,
        showAllRepositoryFiles,
        latestTurnId = null,
        latestTurnChangeSet = null,
        latestTurnEvidence = null,
        sessionChangeSet = null,
        computeAttribution = true,
    } = input;

    const scmStatusFiles = React.useMemo(() => {
        if (!scmSnapshot?.repo.isRepo) {
            return null;
        }
        return snapshotToScmStatusFiles(scmSnapshot);
    }, [scmSnapshot]);

    // The one changed-file list (and so the one count) every surface shows.
    const allRepositoryChangedFiles = React.useMemo<ScmFileStatus[]>(
        () => (scmStatusFiles && scmSnapshot ? [...selectScmChangedFiles(scmSnapshot)] : []),
        [scmSnapshot, scmStatusFiles]
    );
    const changedFilesCount = allRepositoryChangedFiles.length;
    const shouldShowAllFiles = Boolean(searchQuery) || showAllRepositoryFiles || changedFilesCount === 0;

    const repoRootPath = scmSnapshot?.repo.rootPath;
    const latestTurnAttribution = React.useMemo(() => projectChangedFilesAttribution({
        sessionId,
        turns: latestTurnEvidence ? [latestTurnEvidence] : [],
        canonicalChangeSet: latestTurnChangeSet,
        repoRootPath,
    }), [latestTurnChangeSet, latestTurnEvidence, repoRootPath, sessionId]);
    const latestTurnEvidenceChangeSet = latestTurnAttribution.changeSet;

    const latestTurnProjection = React.useMemo(() => {
        return deriveSessionWorkingTreeProjection({
            sessionChangeSet: latestTurnEvidenceChangeSet.files.length > 0 ? latestTurnEvidenceChangeSet : null,
            snapshot: scmSnapshot,
        });
    }, [latestTurnEvidenceChangeSet, scmSnapshot]);

    const latestTurnAgentReportedAttribution = React.useMemo(() => {
        if (!latestTurnEvidence) return null;
        return projectChangedFilesAttribution({
            sessionId,
            turns: [latestTurnEvidence],
            evidenceScope: 'agent_reported',
            repoRootPath,
        });
    }, [latestTurnEvidence, repoRootPath, sessionId]);
    const latestTurnAgentReportedChangeSet = latestTurnAgentReportedAttribution?.changeSet ?? null;

    const latestTurnCheckpointAttribution = React.useMemo(() => {
        if (!latestTurnEvidence) return null;
        return projectChangedFilesAttribution({
            sessionId,
            turns: [latestTurnEvidence],
            evidenceScope: 'checkpoint',
            repoRootPath,
        });
    }, [latestTurnEvidence, repoRootPath, sessionId]);
    const latestTurnCheckpointChangeSet = latestTurnCheckpointAttribution?.changeSet ?? null;

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

    const workspaceTouchedFiles = React.useMemo(
        () => adaptWorkspaceTouchedFiles(allRepositoryChangedFiles, workspaceTouchedPaths),
        [allRepositoryChangedFiles, workspaceTouchedPaths],
    );

    const sessionAttributionProjection = React.useMemo(() => projectChangedFilesAttribution({
        sessionId,
        canonicalChangeSet: sessionChangeSet,
        workspaceTouchedFiles,
        repoRootPath,
    }), [repoRootPath, sessionChangeSet, sessionId, workspaceTouchedFiles]);
    const sessionAttributionChangeSet = sessionAttributionProjection.changeSet;

    const sessionProjection = React.useMemo(() => {
        return deriveSessionWorkingTreeProjection({
            sessionChangeSet: sessionAttributionChangeSet.files.length > 0 ? sessionAttributionChangeSet : null,
            snapshot: scmSnapshot,
        });
    }, [scmSnapshot, sessionAttributionChangeSet]);

    const turnScope = React.useMemo<ScopedProjectionResult>(() => {
        if (!computeAttribution) {
            return EMPTY_SCOPE_RESULT(allRepositoryChangedFiles);
        }

        if (latestTurnProjection) {
            return buildAttributedScope({
                allRepositoryChangedFiles,
                projection: latestTurnProjection,
                evidenceByFilePath: latestTurnAttribution.evidenceByFilePath,
                includeUnmatchedEvidence: latestTurnEvidence !== null,
            });
        }

        return EMPTY_SCOPE_RESULT(allRepositoryChangedFiles);
    }, [allRepositoryChangedFiles, computeAttribution, latestTurnEvidence, latestTurnAttribution, latestTurnProjection]);

    const turnAgentReportedScope = React.useMemo<ScopedProjectionResult>(() => {
        if (!computeAttribution) {
            return EMPTY_SCOPE_RESULT(allRepositoryChangedFiles);
        }

        if (latestTurnAgentReportedProjection && latestTurnAgentReportedAttribution) {
            return buildAttributedScope({
                allRepositoryChangedFiles,
                projection: latestTurnAgentReportedProjection,
                evidenceByFilePath: latestTurnAgentReportedAttribution.evidenceByFilePath,
                includeUnmatchedEvidence: true,
            });
        }

        return EMPTY_SCOPE_RESULT(allRepositoryChangedFiles);
    }, [allRepositoryChangedFiles, computeAttribution, latestTurnAgentReportedAttribution, latestTurnAgentReportedProjection]);

    const turnCheckpointScope = React.useMemo<ScopedProjectionResult>(() => {
        if (!computeAttribution) {
            return EMPTY_SCOPE_RESULT(allRepositoryChangedFiles);
        }

        if (latestTurnCheckpointProjection && latestTurnCheckpointAttribution) {
            return buildAttributedScope({
                allRepositoryChangedFiles,
                projection: latestTurnCheckpointProjection,
                evidenceByFilePath: latestTurnCheckpointAttribution.evidenceByFilePath,
                includeUnmatchedEvidence: true,
            });
        }

        return EMPTY_SCOPE_RESULT(allRepositoryChangedFiles);
    }, [allRepositoryChangedFiles, computeAttribution, latestTurnCheckpointAttribution, latestTurnCheckpointProjection]);

    const sessionScope = React.useMemo<ScopedProjectionResult>(() => {
        if (!computeAttribution) {
            return EMPTY_SCOPE_RESULT(allRepositoryChangedFiles);
        }

        if (sessionProjection) {
            return buildAttributedScope({
                allRepositoryChangedFiles,
                projection: sessionProjection,
                evidenceByFilePath: sessionAttributionProjection.evidenceByFilePath,
                includeUnmatchedEvidence: true,
            });
        }

        return EMPTY_SCOPE_RESULT(allRepositoryChangedFiles);
    }, [allRepositoryChangedFiles, computeAttribution, sessionAttributionProjection, sessionProjection]);

    const showTurnViewToggle = React.useMemo(() => {
        if (!computeAttribution) return false;
        // A real latest-turn identity is useful even when the turn produced no
        // file evidence: the Turn view must be able to explain that empty result.
        if (typeof latestTurnId === 'string' && latestTurnId.trim().length > 0) return true;
        if (latestTurnEvidence) return true;
        return turnScope.attributedFiles.length > 0;
    }, [computeAttribution, latestTurnEvidence, latestTurnId, turnScope.attributedFiles.length]);

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

    const showSessionViewToggle = computeAttribution && sessionScope.attributedFiles.length > 0;
    const sessionAttribution = sessionAttributionChangeSet.confidenceSummary.attribution;
    const sessionCheckpointOverlap = sessionAttributionChangeSet.confidenceSummary.checkpointOverlap;

    return {
        sessionAttribution,
        sessionCheckpointOverlap,
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
    };
}
