type WorkspaceRepositoryDirectoryRevisionListener = () => void;

const workspaceRepositoryDirectoryRevisions = new Map<string, Readonly<{ revision: number; reason?: 'recovery' }>>();
const workspaceRepositoryDirectoryListeners = new Map<string, Set<WorkspaceRepositoryDirectoryRevisionListener>>();

function normalizeWorkspaceCacheKey(workspaceCacheKey: string | null | undefined): string {
    return typeof workspaceCacheKey === 'string' ? workspaceCacheKey.trim() : '';
}

export function getWorkspaceRepositoryDirectoryRevision(workspaceCacheKey: string | null | undefined): number {
    const key = normalizeWorkspaceCacheKey(workspaceCacheKey);
    if (!key) return 0;
    return workspaceRepositoryDirectoryRevisions.get(key)?.revision ?? 0;
}

export function isWorkspaceRepositoryDirectoryRecovery(workspaceCacheKey: string, revision: number): boolean {
    const current = workspaceRepositoryDirectoryRevisions.get(workspaceCacheKey);
    return current?.revision === revision && current.reason === 'recovery';
}

export function subscribeWorkspaceRepositoryDirectoryRevision(
    workspaceCacheKey: string | null | undefined,
    listener: WorkspaceRepositoryDirectoryRevisionListener,
): () => void {
    const key = normalizeWorkspaceCacheKey(workspaceCacheKey);
    if (!key) return () => {};

    let listeners = workspaceRepositoryDirectoryListeners.get(key);
    if (!listeners) {
        listeners = new Set();
        workspaceRepositoryDirectoryListeners.set(key, listeners);
    }
    listeners.add(listener);

    return () => {
        const current = workspaceRepositoryDirectoryListeners.get(key);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) {
            workspaceRepositoryDirectoryListeners.delete(key);
        }
    };
}

/** Every mounted tree re-reads: what it showed belonged to an Account that left. */
export function markMountedWorkspaceRepositoryDirectoriesChanged(): void {
    for (const key of [...workspaceRepositoryDirectoryListeners.keys()]) markWorkspaceRepositoryDirectoryChanged(key);
}

export function markWorkspaceRepositoryDirectoryChanged(workspaceCacheKey: string | null | undefined, reason?: 'recovery'): void {
    const key = normalizeWorkspaceCacheKey(workspaceCacheKey);
    if (!key) return;

    const currentRevision = workspaceRepositoryDirectoryRevisions.get(key)?.revision ?? 0;
    const nextRevision = currentRevision >= Number.MAX_SAFE_INTEGER ? 1 : currentRevision + 1;
    workspaceRepositoryDirectoryRevisions.set(key, { revision: nextRevision, reason });

    const listeners = workspaceRepositoryDirectoryListeners.get(key);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
        listener();
    }
}
