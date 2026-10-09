import type { McpServerCatalogSnapshotV1, McpServerCatalogSourceCleanupV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerCatalogV1, McpServerCatalogDiagnosticV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type McpServerCatalogValueSnapshot = Readonly<{
    status: 'loading' | 'ready' | 'partial' | 'unavailable'; value: McpServerCatalogV1 | null;
    revision: number | 'absent'; authority: 'active' | 'inactive'; stale: boolean;
    diagnostics: readonly McpServerCatalogDiagnosticV1[]; reason?: string; cleanup?: McpServerCatalogSourceCleanupV1;
}>;
const loading: McpServerCatalogValueSnapshot = Object.freeze({ status: 'loading', value: null,
    revision: 'absent', authority: 'inactive', stale: true, diagnostics: [] });
const snapshots = new Map<string, Readonly<{ scope: ServerAccountScope; value: McpServerCatalogValueSnapshot }>>();
const listeners = new Set<() => void>();

export function subscribeMcpServerCatalogSnapshots(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function getMcpServerCatalogSnapshot(scope: ServerAccountScope | null | undefined): McpServerCatalogValueSnapshot {
    return scope ? snapshots.get(serverAccountScopeKeySuffix(scope))?.value ?? loading : loading;
}
export function projectMcpServerCatalogSnapshot(snapshot: McpServerCatalogSnapshotV1,
    previous?: McpServerCatalogValueSnapshot): McpServerCatalogValueSnapshot {
    let next: McpServerCatalogValueSnapshot;
    if (snapshot.status === 'ready' || snapshot.status === 'partial') {
        const value = previous?.value && JSON.stringify(previous.value) === JSON.stringify(snapshot.catalog)
            ? previous.value : snapshot.catalog;
        next = { status: snapshot.status, value, revision: snapshot.revision, authority: snapshot.authority,
            stale: false, diagnostics: snapshot.diagnostics, ...(snapshot.cleanup ? { cleanup: snapshot.cleanup } : {}) };
    } else {
        const withdraw = snapshot.status === 'unavailable' && ['account-mode-mismatch', 'encryption-material-unavailable',
            'unauthorized', 'forbidden', 'account-not-found', 'account-inconsistent', 'invalid-stored-content', 'scope-retired'].includes(snapshot.reason);
        next = { status: snapshot.status, value: withdraw ? null : previous?.value ?? null,
            revision: previous?.revision ?? 'absent', authority: previous?.authority ?? 'inactive', stale: true,
            diagnostics: [], ...(snapshot.status === 'unavailable' ? { reason: snapshot.reason } : {}) };
    }
    return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
export function applyMcpServerCatalogSnapshot(scope: ServerAccountScope, snapshot: McpServerCatalogSnapshotV1, current: boolean): void {
    if (!current) return;
    const key = serverAccountScopeKeySuffix(scope);
    const previous = snapshots.get(key)?.value;
    const next = projectMcpServerCatalogSnapshot(snapshot, previous);
    if (previous === next) return;
    snapshots.set(key, { scope, value: next });
    for (const listener of [...listeners]) listener();
}
export function beginMcpServerCatalogLoad(scope: ServerAccountScope): void {
    applyMcpServerCatalogSnapshot(scope, { status: 'loading' }, true);
}
export function invalidateMcpServerCatalogsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) if (snapshot.scope.serverId === serverId) beginMcpServerCatalogLoad(snapshot.scope);
}
export function resetMcpServerCatalogSnapshotsForTests(): void { snapshots.clear(); listeners.clear(); }
