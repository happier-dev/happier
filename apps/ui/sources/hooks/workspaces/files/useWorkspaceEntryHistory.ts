import * as React from 'react';
import type { ScmEntryHistoryV1 } from '@happier-dev/protocol/scm';

import { machineScmHistoryEntries } from '@/sync/ops/scm/machineScm';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';

export type WorkspaceEntryHistory = Readonly<{
    status: 'idle' | 'pending' | 'ready' | 'unavailable';
    entries: ReadonlyMap<string, ScmEntryHistoryV1>;
    headOid: string | null;
    stale: boolean;
    reason?: string;
}>;

const EMPTY: WorkspaceEntryHistory = { status: 'idle', entries: new Map(), headOid: null, stale: false };

/** One transient demand batch. A response belongs to its captured Home, folder and HEAD. */
export function useWorkspaceEntryHistory(input: Readonly<{
    scope: WorkspaceScopeBase;
    folder: string;
    paths: readonly string[];
    headOid?: string | null;
    /** Actual repository root from the same qualified SCM snapshot as the HEAD witness. */
    repoRootPath?: string | null;
    enabled: boolean;
    reloadToken?: string | number;
}>) {
    const workspaceKey = tryBuildWorkspaceCacheKey(input.scope) ?? '';
    const scopeKey = JSON.stringify([workspaceKey, input.folder]);
    const pathsKey = JSON.stringify([...new Set(input.paths)].sort());
    const [state, setState] = React.useState<Readonly<{ scopeKey: string; repoRootPath: string | null; value: WorkspaceEntryHistory }> | null>(null);
    const scope = React.useMemo(() => input.scope, [input.scope.serverId, input.scope.machineId, input.scope.rootPath]);
    const repoRootPath = input.repoRootPath ?? null;
    const workspacePrefix = React.useMemo(() => repoRootPath
        ? resolvePathRelativeToRoot({ path: scope.rootPath, root: repoRootPath, preservePathSpelling: true }) : null,
    [scope.rootPath, repoRootPath]);
    React.useEffect(() => {
        if (!input.enabled || !workspaceKey) return;
        const paths: string[] = JSON.parse(pathsKey);
        if (paths.length === 0) return;
        const controller = new AbortController();
        const previousForScope = (previous: typeof state) => previous?.scopeKey === scopeKey ? previous.value : EMPTY;
        setState(previous => ({ scopeKey, repoRootPath, value: { ...previousForScope(previous), status: 'pending', stale: previousForScope(previous).entries.size > 0 } }));
        const unavailable = (reason: string) => {
            if (controller.signal.aborted) return;
            setState(previous => {
                const value = previousForScope(previous);
                return { scopeKey, repoRootPath, value: { ...value, status: 'unavailable', stale: value.entries.size > 0, reason } };
            });
        };
        if (workspacePrefix === null) {
            unavailable(repoRootPath ? 'Workspace outside repository root' : 'Repository root unavailable');
            return () => controller.abort();
        }
        const prefix = workspacePrefix === '.' ? '' : workspacePrefix;
        const toRepoPath = (path: string) => prefix ? path ? `${prefix}/${path}` : prefix : path;
        const demandedPaths = new Map(paths.map(path => [toRepoPath(path), path]));
        void machineScmHistoryEntries(scope.machineId, {
            cwd: scope.rootPath, folder: toRepoPath(input.folder), paths: [...demandedPaths.keys()],
            ...(input.headOid ? { headOid: input.headOid } : {}),
        }, { serverId: scope.serverId, signal: controller.signal }).then(response => {
            if (controller.signal.aborted) return;
            if (!response.success) { unavailable(response.errorCode === 'SCM_SOURCE_CHANGED' ? response.errorCode : response.error ?? response.errorCode); return; }
            if (input.headOid !== undefined && response.headOid !== input.headOid) { unavailable('SCM_SOURCE_CHANGED'); return; }
            const entries = new Map<string, ScmEntryHistoryV1>();
            for (const entry of response.entries) {
                const path = demandedPaths.get(entry.path);
                if (path !== undefined) entries.set(path, { ...entry, path });
            }
            // An omitted answer is unavailable, not proof that an entry has never been committed.
            for (const path of paths) if (!entries.has(path)) entries.set(path, { path, kind: 'unavailable', reason: 'Missing entry history' });
            setState({ scopeKey, repoRootPath, value: { status: 'ready', entries, headOid: response.headOid, stale: false } });
        }).catch(error => unavailable(error instanceof Error ? error.message : 'History unavailable'));
        return () => controller.abort();
    }, [workspaceKey, scopeKey, scope, input.folder, pathsKey, input.headOid, input.enabled, input.reloadToken, repoRootPath, workspacePrefix]);
    const value = state?.scopeKey === scopeKey ? state.value : EMPTY;
    const witnessChanged = input.headOid !== undefined && value.headOid !== input.headOid;
    return (!input.enabled || witnessChanged || state?.repoRootPath !== repoRootPath) && value.entries.size > 0 ? { ...value, stale: true } : value;
}
