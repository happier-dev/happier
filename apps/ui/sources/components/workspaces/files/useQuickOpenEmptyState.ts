import * as React from 'react';

import { useOptionalUniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { selectScmChangedFileByPath, selectScmChangedFiles, selectScmChangedFilesForPaths, selectScmDeletedPaths } from '@/scm/scmStatusFiles';
import { storage, useWorkspaceScmSnapshot } from '@/sync/domains/state/storage';
import { useDerivedSessionChangeSet } from '@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet';
import { recentWorkspaceFilesState } from '@/sync/domains/state/filePaneUiState';
import { usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { recentWorkspaceFilesKey, selectRecentWorkspaceFiles, workspacePathToFileSearchItem } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';
import { workspaceFileSearchCache } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const NO_PATHS: readonly string[] = [];

function projectQuickOpenRecentFiles(input: Readonly<{
    storedPaths: readonly string[];
    existingPaths: ReadonlySet<string> | null;
    deletedPaths: ReadonlySet<string>;
    activeFilePath?: string | null;
}>): FileSearchItem[] {
    const paths = selectRecentWorkspaceFiles(input.storedPaths, input.existingPaths)
        .filter(path => !input.deletedPaths.has(path));
    if (input.activeFilePath && paths.includes(input.activeFilePath)) {
        paths.splice(paths.indexOf(input.activeFilePath), 1);
        paths.unshift(input.activeFilePath);
    }
    return paths.map(workspacePathToFileSearchItem);
}

/** Demand-time read of the same Recent source, without mounting a picker subscription or issuing RPCs. */
export function readQuickOpenRecentFiles(scope: WorkspaceScopeBase | null): readonly FileSearchItem[] {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!scope || !lifetime || lifetime.scope.serverId !== scope.serverId || !lifetime.isCurrent()) return [];
    const key = tryBuildWorkspaceCacheKey(scope);
    if (!key) return [];
    const state = storage.getState();
    const snapshot = state.getWorkspaceScmSnapshot(scope);
    return projectQuickOpenRecentFiles({ storedPaths: recentWorkspaceFilesState.read(recentWorkspaceFilesKey(lifetime.scope, key)) ?? NO_PATHS,
        existingPaths: workspaceFileSearchCache.readFilePaths(scope, lifetime),
        deletedPaths: snapshot ? selectScmDeletedPaths(snapshot) : NO_DELETED_PATHS });
}

const NO_DELETED_PATHS: ReadonlySet<string> = new Set();

/** Device-local Recent and the canonical last SCM snapshot, shared by quick open and the empty editor column. */
type QuickOpenEmptyStateInput = Readonly<{
    scope: WorkspaceScopeBase | null;
    sessionId?: string | null;
    activeFilePath?: string | null;
}>;

export function useQuickOpenFileSources(input: QuickOpenEmptyStateInput) {
    const snapshot = useWorkspaceScmSnapshot(input.scope);
    // A Session's own changes are its daemon-owned turn evidence, not inferred from snapshots.
    const sessionChanges = useDerivedSessionChangeSet(input.sessionId && input.scope
        ? { serverId: input.scope.serverId, sessionId: input.sessionId } : null, snapshot?.repo.rootPath ?? null).sessionChangeSet;
    const touched = React.useMemo(() => sessionChanges?.files.map(file => file.filePath) ?? NO_PATHS, [sessionChanges]);
    const credentials = useServerCredentialAccountScopeBinding(input.scope?.serverId);
    const authorized = credentials.binding?.isCurrent() === true;
    const key = input.scope ? tryBuildWorkspaceCacheKey(input.scope) : null;
    const stored = usePersistentUiStateValue(recentWorkspaceFilesState, authorized && credentials.binding && key
        ? recentWorkspaceFilesKey(credentials.binding.scope, key) : null);
    const storedPaths = stored ?? NO_PATHS;
    const knownFilePaths = input.scope && credentials.binding
        ? workspaceFileSearchCache.readFilePaths(input.scope, credentials.binding) : null;
    const recent = React.useMemo(() => {
        return projectQuickOpenRecentFiles({ storedPaths,
            existingPaths: knownFilePaths,
            activeFilePath: input.activeFilePath,
            deletedPaths: snapshot ? selectScmDeletedPaths(snapshot) : NO_DELETED_PATHS });
    }, [input.activeFilePath, knownFilePaths, snapshot, storedPaths]);
    const changedProjection = React.useMemo(() => {
        const paths = input.sessionId ? new Set(touched) : null;
        const files = !authorized || !snapshot ? []
            : input.sessionId ? selectScmChangedFilesForPaths(snapshot, touched) : selectScmChangedFiles(snapshot);
        return { files, paths };
    }, [authorized, input.sessionId, snapshot, touched]);
    const changed = changedProjection.files;
    const defaultSelectedPath = recent[0]?.fullPath === input.activeFilePath
        ? recent[1]?.fullPath ?? changed.find(file => file.fullPath !== input.activeFilePath)?.fullPath ?? input.activeFilePath
        : recent[0]?.fullPath ?? changed[0]?.fullPath ?? null;
    const changeForPath = React.useCallback((path: string) => {
        if (!authorized || !snapshot) return undefined;
        const file = selectScmChangedFileByPath(snapshot, path);
        // A Session exposes only its own Changed rows and line counts.
        if (changedProjection.paths && !changedProjection.paths.has(path)) return undefined;
        return file?.isComplete !== false && file ? { added: file.linesAdded, removed: file.linesRemoved } : undefined;
    }, [authorized, changedProjection.paths, snapshot]);
    return { recent, recentPaths: storedPaths, changed, changeForPath, defaultSelectedPath, accountId: credentials.binding?.accountId ?? null };
}

/**
 * Opens quick open (Universal Search, Files in this workspace) from a control that is not the keyboard
 * command: the empty editor column, the Files tree's Go to file field (with what was typed there).
 * Null where Search is not mounted.
 */
export function useQuickOpenFilesLauncher(input: Readonly<{ scope: WorkspaceScopeBase | null; sessionId?: string | null }>) {
    const runtime = useOptionalUniversalSearchRuntime();
    const accountId = useServerCredentialAccountScopeBinding(input.scope?.serverId).binding?.accountId ?? null;
    const scope = input.scope;
    const sessionId = input.sessionId ?? null;
    return React.useMemo(() => runtime ? (query?: string) => {
        runtime.open(query?.trim() ? query : undefined, scope ? { ...scope, accountId, sessionId } : undefined, { source: 'files' });
    } : null, [accountId, runtime, scope, sessionId]);
}

export function useQuickOpenEmptyState(input: QuickOpenEmptyStateInput) {
    const sources = useQuickOpenFileSources(input);
    const launch = useQuickOpenFilesLauncher(input);
    const openFiles = React.useCallback(() => { launch?.(); }, [launch]);
    return { ...sources, openFiles };
}
