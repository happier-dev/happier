import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import {
    normalizeWorkspaceRootPath,
    normalizeWorkspaceScopeBase,
    tryBuildWorkspaceCacheKey,
    type WorkspaceScopeBase,
} from '@/sync/domains/workspaces/workspaceScope';

export type AcknowledgedWorkspaceFileWrite = Readonly<{ path: string; hash: string | null }>;
type Target = WorkspaceScopeBase & Readonly<{ accountId: string }>;
type Listener = (write: AcknowledgedWorkspaceFileWrite) => void;
const listeners = new Map<string, Set<Listener>>();

function fileKey(target: Target, path: string): string | null {
    const scope = normalizeWorkspaceScopeBase(target);
    const accountId = target.accountId.trim();
    if (!scope || !accountId) return null;
    const absolutePath = normalizeWorkspaceRootPath(resolveMachineAbsolutePath({
        rootPath: scope.rootPath, requestPath: path, pathKind: 'workspace_entry',
    }));
    return absolutePath ? JSON.stringify([scope.workspace ? tryBuildWorkspaceCacheKey(scope) : scope.serverId,
        accountId, scope.machineId, absolutePath]) : null;
}

/** Mounted saved-byte readers share acknowledgements; this holds neither file bytes nor history. */
export function subscribeAcknowledgedWorkspaceFileWrites(target: Target, path: string, listener: Listener): () => void {
    const key = fileKey(target, path);
    if (!key) return () => {};
    const subscribed = listeners.get(key) ?? new Set<Listener>();
    subscribed.add(listener);
    listeners.set(key, subscribed);
    return () => {
        subscribed.delete(listener);
        if (subscribed.size === 0) listeners.delete(key);
    };
}

/** Only validated successful writer results enter this owner; hashes remain the writer's evidence. */
export function acknowledgeWorkspaceFileWrites(target: Target, writes: readonly AcknowledgedWorkspaceFileWrite[]): void {
    for (const write of writes) {
        const key = fileKey(target, write.path);
        if (!key) continue;
        for (const listener of [...listeners.get(key) ?? []]) {
            try { listener(write); }
            catch { /* A reader cannot turn an acknowledged mutation into a failed write. */ }
        }
    }
}
