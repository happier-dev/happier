import { recentWorkspaceFilesState } from '@/sync/domains/state/filePaneUiState';
import { UiStatePersistenceError } from '@/sync/domains/state/persistentUiState';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { recentWorkspaceFilesKey, recordRecentWorkspaceFile } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';

/** File activation updates only this Account/workspace's MRU, never the settings document. */
export function recordWorkspaceFileOpen(scope: ServerAccountScope, workspaceKey: string, path: string): void {
    const key = recentWorkspaceFilesKey(scope, workspaceKey);
    const paths = recentWorkspaceFilesState.read(key);
    const previous = paths ? { [key]: paths } : {};
    const next = recordRecentWorkspaceFile(previous, key, path);
    if (next === previous) return;
    try { recentWorkspaceFilesState.set(key, next[key]); } catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[ui-state] Recent file history could not be saved.');
    }
}
