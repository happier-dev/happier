import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ChangedFilesList } from '@/components/sessions/files/content/ChangedFilesList';
import { ChangedFilesReview } from '@/components/sessions/files/content/ChangedFilesReview';
import { FilesToolbar } from '@/components/sessions/files/FilesToolbar';
import { useChangedFilesData } from '@/hooks/session/files/useChangedFilesData';
import {
    getDefaultChangedFilesViewMode,
    resolveChangedFilesViewMode,
    type ChangedFilesPresentation,
    type ChangedFilesViewMode,
    type SessionAttributedFile,
} from '@/scm/scmAttribution';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useProjectForSession, useProjectSessions, useSessionProjectScmOperationLog, useSessionProjectScmTouchedPaths, useSetting } from '@/sync/domains/state/storage';
import { useDerivedSessionChangeSet } from '@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet';

export type RepositoryTreeChangedFilesPaneProps = Readonly<{
    sessionId: string;
    scmSnapshot: ScmWorkingSnapshot | null;
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    onShowAllRepositoryFiles: () => void;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
}>;

function matchesQuery(filePath: string, query: string): boolean {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return true;
    return filePath.toLowerCase().includes(normalizedQuery);
}

function filterScmFilesByQuery(files: readonly ScmFileStatus[], query: string): ScmFileStatus[] {
    if (!query.trim()) return [...files];
    return files.filter((file) => matchesQuery(file.fullPath, query));
}

function filterAttributedFilesByQuery(files: readonly SessionAttributedFile[], query: string): SessionAttributedFile[] {
    if (!query.trim()) return [...files];
    return files.filter((entry) => matchesQuery(entry.file.fullPath, query));
}

export const RepositoryTreeChangedFilesPane = React.memo((props: RepositoryTreeChangedFilesPaneProps) => {
    const { theme } = useUnistyles();
    const project = useProjectForSession(props.sessionId);
    const projectSessionIds = useProjectSessions(project?.id ?? null);
    const touchedPaths = useSessionProjectScmTouchedPaths(props.sessionId);
    const operationLog = useSessionProjectScmOperationLog(props.sessionId);
    const scmReviewMaxFiles = useSetting('scmReviewMaxFiles');
    const scmReviewMaxChangedLines = useSetting('scmReviewMaxChangedLines');
    const { latestTurnScopedChangeSet, latestTurnDiffByPath, sessionChangeSet, providerDiffByPath } = useDerivedSessionChangeSet(props.sessionId);

    const [requestedChangedFilesViewMode, setChangedFilesViewMode] = React.useState<ChangedFilesViewMode>(() => {
        if (latestTurnScopedChangeSet) return 'turn';
        if (sessionChangeSet) return 'session';
        return getDefaultChangedFilesViewMode();
    });
    const [changedFilesPresentation, setChangedFilesPresentation] = React.useState<ChangedFilesPresentation>('list');

    const changed = useChangedFilesData({
        sessionId: props.sessionId,
        scmSnapshot: props.scmSnapshot,
        touchedPaths,
        operationLog,
        projectSessionIds,
        searchQuery: props.searchQuery,
        showAllRepositoryFiles: false,
        latestTurnChangeSet: latestTurnScopedChangeSet,
        sessionChangeSet,
    });

    const changedFilesViewMode = React.useMemo(() => resolveChangedFilesViewMode({
        mode: requestedChangedFilesViewMode,
        showTurnViewToggle: changed.showTurnViewToggle,
        showSessionViewToggle: changed.showSessionViewToggle,
    }), [changed.showSessionViewToggle, changed.showTurnViewToggle, requestedChangedFilesViewMode]);

    const filteredChanged = React.useMemo(() => {
        return {
            allRepositoryChangedFiles: filterScmFilesByQuery(changed.allRepositoryChangedFiles, props.searchQuery),
            turnAttributedFiles: filterAttributedFilesByQuery(changed.turnAttributedFiles, props.searchQuery),
            turnRepositoryOnlyFiles: filterScmFilesByQuery(changed.turnRepositoryOnlyFiles, props.searchQuery),
            sessionAttributedFiles: filterAttributedFilesByQuery(changed.sessionAttributedFiles, props.searchQuery),
            repositoryOnlyFiles: filterScmFilesByQuery(changed.repositoryOnlyFiles, props.searchQuery),
        };
    }, [
        changed.allRepositoryChangedFiles,
        changed.repositoryOnlyFiles,
        changed.sessionAttributedFiles,
        changed.turnAttributedFiles,
        changed.turnRepositoryOnlyFiles,
        props.searchQuery,
    ]);

    const reviewProviderDiffByPath = React.useMemo(() => {
        if (changedFilesViewMode === 'turn') return latestTurnDiffByPath;
        if (changedFilesViewMode === 'session') return providerDiffByPath;
        return null;
    }, [changedFilesViewMode, latestTurnDiffByPath, providerDiffByPath]);

    const maxFiles = typeof scmReviewMaxFiles === 'number' && Number.isFinite(scmReviewMaxFiles) ? scmReviewMaxFiles : 25;
    const maxChangedLines = typeof scmReviewMaxChangedLines === 'number' && Number.isFinite(scmReviewMaxChangedLines)
        ? scmReviewMaxChangedLines
        : 2000;

    const openFile = React.useCallback((file: ScmFileStatus) => {
        props.onOpenFile(file.fullPath);
    }, [props]);

    const openFilePinned = React.useCallback((file: ScmFileStatus) => {
        (props.onOpenFilePinned ?? props.onOpenFile)(file.fullPath);
    }, [props]);

    return (
        <>
            <FilesToolbar
                theme={theme}
                searchQuery={props.searchQuery}
                onSearchQueryChange={props.onSearchQueryChange}
                showAllRepositoryFiles={false}
                onShowChangedFiles={() => {}}
                onShowAllRepositoryFiles={props.onShowAllRepositoryFiles}
                changedFilesCount={changed.changedFilesCount}
                changedFilesViewMode={changedFilesViewMode}
                changedFilesPresentation={changedFilesPresentation}
                showTurnViewToggle={changed.showTurnViewToggle}
                showSessionViewToggle={changed.showSessionViewToggle}
                onChangedFilesViewMode={setChangedFilesViewMode}
                onChangedFilesPresentationChange={setChangedFilesPresentation}
                scmPanelExpanded={false}
                onToggleScmPanel={() => {}}
                onRefresh={undefined}
                showScmToggle={false}
            />
            {changedFilesPresentation === 'review' ? (
                <ChangedFilesReview
                    theme={theme}
                    sessionId={props.sessionId}
                    snapshot={props.scmSnapshot}
                    changedFilesViewMode={changedFilesViewMode}
                    attributionReliability={changed.attributionReliability}
                    allRepositoryChangedFiles={filteredChanged.allRepositoryChangedFiles}
                    turnAttributedFiles={filteredChanged.turnAttributedFiles}
                    turnRepositoryOnlyFiles={filteredChanged.turnRepositoryOnlyFiles}
                    sessionAttributedFiles={filteredChanged.sessionAttributedFiles}
                    repositoryOnlyFiles={filteredChanged.repositoryOnlyFiles}
                    suppressedInferredCount={changed.suppressedInferredCount}
                    maxFiles={maxFiles}
                    maxChangedLines={maxChangedLines}
                    onFilePress={openFile}
                    onFilePressPinned={openFilePinned}
                    providerDiffByPath={reviewProviderDiffByPath}
                    rowDensity="compact"
                />
            ) : (
                <ChangedFilesList
                    theme={theme}
                    changedFilesViewMode={changedFilesViewMode}
                    attributionReliability={changed.attributionReliability}
                    allRepositoryChangedFiles={filteredChanged.allRepositoryChangedFiles}
                    turnAttributedFiles={filteredChanged.turnAttributedFiles}
                    turnRepositoryOnlyFiles={filteredChanged.turnRepositoryOnlyFiles}
                    sessionAttributedFiles={filteredChanged.sessionAttributedFiles}
                    repositoryOnlyFiles={filteredChanged.repositoryOnlyFiles}
                    suppressedInferredCount={changed.suppressedInferredCount}
                    onFilePress={openFile}
                    onFilePressPinned={openFilePinned}
                    rowDensity="compact"
                />
            )}
        </>
    );
});
