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
import { snapshotToScmStatusFiles, buildScmStatusFilesFromEntries, type ScmFileStatus, type ScmStatusFiles } from '@/scm/scmStatusFiles';
import { useScmStatusEntriesWindow } from '@/scm/entries/useScmStatusEntriesWindow';
import type { ScmStatusEntriesWindowState } from '@/scm/entries/scmStatusEntriesWindow';
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
    /**
     * The bounded entries window this owner already runs. Surfaces render rows
     * and drive paging through it; nothing else may open a second window.
     */
    entriesWindow: {
        state: ScmStatusEntriesWindowState;
        expandDirectory: (directoryPath: string) => void;
        collapseDirectory: (directoryPath: string) => void;
        loadMoreExpanded: (directoryPath: string) => void;
        loadMoreTopLevel: () => void;
    };
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

    // Bounded entries window (delivery split): when the poll delivered a
    // summary snapshot (entries omitted/truncated), the window loads entry rows
    // on demand (paged RPC, snapshot fallback). While it carries rows, they are
    // the row source through the SAME projection owner (scmStatusFiles); a
    // complete-entry snapshot keeps the historical path with zero extra RPCs.
    const entriesWindow = useScmStatusEntriesWindow({ sessionId, snapshot: scmSnapshot });
    // Continuity: rows serve whenever the window holds data — including while a
    // staleness refresh is in flight (status 'loading') — so a poll advance
    // never blanks the pane back to the snapshot's omitted entries.
    const windowRowsActive = entriesWindow.state.mode === 'window' && entriesWindow.state.entries.length > 0;
    const fallbackRowsActive = entriesWindow.state.mode === 'snapshot-fallback' && (entriesWindow.state.fallbackEntries?.length ?? 0) > 0;

    const scmStatusFiles = React.useMemo(() => {
        if (!scmSnapshot?.repo.isRepo) {
            return null;
        }
        if (windowRowsActive) {
            return buildScmStatusFilesFromEntries(entriesWindow.state.entries, scmSnapshot);
        }
        if (fallbackRowsActive) {
            return buildScmStatusFilesFromEntries(entriesWindow.state.fallbackEntries ?? [], scmSnapshot);
        }
        return snapshotToScmStatusFiles(scmSnapshot);
    }, [entriesWindow.state, fallbackRowsActive, scmSnapshot, windowRowsActive]);

    // Totals-first count: totals.changedFiles is the truthful server-derived
    // changed-FILE count in every delivery mode; the rows sum (today's
    // derivation) stays the fallback for legacy snapshots.
    const changedFilesCount = scmSnapshot?.totals.changedFiles
        ?? ((scmStatusFiles?.totalIncluded ?? 0) + (scmStatusFiles?.totalPending ?? 0));
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
        // The bounded entries window this owner already runs: consumers render
        // rows and drive paging through it instead of opening a second window.
        entriesWindow: {
            state: entriesWindow.state,
            expandDirectory: entriesWindow.expandDirectory,
            collapseDirectory: entriesWindow.collapseDirectory,
            loadMoreExpanded: entriesWindow.loadMoreExpanded,
            loadMoreTopLevel: entriesWindow.loadMoreTopLevel,
        },
    };
}
