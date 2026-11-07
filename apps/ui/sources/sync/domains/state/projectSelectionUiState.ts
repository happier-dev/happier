import { readProjectSelectionPreference, type ProjectSelectionPreferenceKeys } from '@/sync/domains/settings/projectSelectionPersistence';
import { projectLastActiveRootPathState, projectLastActiveWorktreeIdState } from './navigationUiState';
import { usePersistentUiStateValue } from './persistentUiState';

type ProjectSelectionUiState = Readonly<{ activeRootPath: string | null; worktreeId: string | null }>;

function readSelectionValue(keys: ProjectSelectionPreferenceKeys | null, current: string | undefined, predecessor: string | undefined): string | null {
    if (!keys) return null;
    const values: Record<string, string> = {};
    if (current !== undefined) values[keys.storageKey] = current;
    if (keys.predecessorStorageKey && predecessor !== undefined) values[keys.predecessorStorageKey] = predecessor;
    return readProjectSelectionPreference(values, keys);
}

/** Callback-only consumers read current device state when the intent runs. */
export function readProjectSelectionUiState(keys: ProjectSelectionPreferenceKeys | null): ProjectSelectionUiState {
    const root = keys ? projectLastActiveRootPathState.read(keys.storageKey) : undefined;
    const worktreeId = keys ? projectLastActiveWorktreeIdState.read(keys.storageKey) : undefined;
    return {
        activeRootPath: readSelectionValue(keys, root, root === undefined && keys?.predecessorStorageKey
            ? projectLastActiveRootPathState.read(keys.predecessorStorageKey) : undefined),
        worktreeId: readSelectionValue(keys, worktreeId, worktreeId === undefined && keys?.predecessorStorageKey
            ? projectLastActiveWorktreeIdState.read(keys.predecessorStorageKey) : undefined),
    };
}

/** The current Home key and its attributable bare-id fallback are the only subscriptions. */
export function useProjectSelectionUiState(keys: ProjectSelectionPreferenceKeys | null): ProjectSelectionUiState {
    const root = usePersistentUiStateValue(projectLastActiveRootPathState, keys?.storageKey ?? null);
    const predecessorRoot = usePersistentUiStateValue(projectLastActiveRootPathState, root === undefined ? keys?.predecessorStorageKey ?? null : null);
    const worktreeId = usePersistentUiStateValue(projectLastActiveWorktreeIdState, keys?.storageKey ?? null);
    const predecessorWorktreeId = usePersistentUiStateValue(projectLastActiveWorktreeIdState, worktreeId === undefined ? keys?.predecessorStorageKey ?? null : null);
    return { activeRootPath: readSelectionValue(keys, root, predecessorRoot), worktreeId: readSelectionValue(keys, worktreeId, predecessorWorktreeId) };
}

export function persistProjectSelectionUiState(keys: ProjectSelectionPreferenceKeys | null, rootPath: string, worktreeId: string): void {
    if (!keys) return;
    projectLastActiveRootPathState.set(keys.storageKey, rootPath);
    projectLastActiveWorktreeIdState.set(keys.storageKey, worktreeId);
}
