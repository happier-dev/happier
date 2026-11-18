import type { McpServerCatalogSnapshotV1, McpServerCatalogSourceCleanupV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerCatalogV1, McpServerCatalogDiagnosticV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { retainDeep, retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { canPublishCatalogReceipt, retainCatalogRevision } from './wholeCatalogReceiptOrdering';
import { admitCatalogBrandMark } from '@/components/ui/media/catalogBrandMark';
import type { HostCatalogMark } from '@/components/ui/media/HappierBrandMark';

export type McpServerCatalogValueSnapshot = Readonly<{
    status: 'loading' | 'ready' | 'partial' | 'unavailable'; value: McpServerCatalogV1 | null;
    revision: number | 'absent'; authority: 'active' | 'inactive'; stale: boolean;
    diagnostics: readonly McpServerCatalogDiagnosticV1[]; reason?: string; cleanup?: McpServerCatalogSourceCleanupV1;
    brandMarks?: Readonly<Record<string, HostCatalogMark>>;
}>;
const loading: McpServerCatalogValueSnapshot = Object.freeze({ status: 'loading', value: null,
    revision: 'absent', authority: 'inactive', stale: true, diagnostics: [] });
const snapshots = new Map<string, Readonly<{ scope: ServerAccountScope; value: McpServerCatalogValueSnapshot }>>();
const listeners = new Set<() => void>();

function reconcileRows<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
    return retainKeyedRows(previous, incoming, row => row.id, { freeze: false }) as T[];
}

/** Reads and acknowledged writes share one server/rule identity reconciliation. */
function reconcileCatalog(previous: McpServerCatalogV1 | null | undefined, incoming: McpServerCatalogV1): McpServerCatalogV1 {
    if (!previous || previous === incoming) return incoming;
    const servers = reconcileRows(previous.servers, incoming.servers);
    const bindings = reconcileRows(previous.bindings, incoming.bindings);
    const pluginServers = incoming.pluginServers
        ? retainDeep(previous.pluginServers, incoming.pluginServers) : undefined;
    if (servers === previous.servers && bindings === previous.bindings && pluginServers === previous.pluginServers) return previous;
    return { ...incoming, servers, bindings, ...(pluginServers ? { pluginServers } : {}) };
}

/** Admit held origin artwork once beside the catalog, shared by every installed presentation. */
function projectBrandMarks(value: McpServerCatalogV1 | null, previous?: McpServerCatalogValueSnapshot): Readonly<Record<string, HostCatalogMark>> | undefined {
    if (!value) return undefined;
    if (value.servers === previous?.value?.servers && previous.brandMarks) return previous.brandMarks;
    const previousServers = new Map(previous?.value?.servers.map(server => [server.id, server]));
    return Object.fromEntries(value.servers.map((server): [string, HostCatalogMark] => {
        const held = previous?.brandMarks?.[server.id];
        if (held && previousServers.get(server.id) === server) return [server.id, held];
        const origin = server.origin?.kind === 'registry' ? server.origin : undefined;
        return [server.id, admitCatalogBrandMark({ displayName: server.title || server.name,
            iconUrl: origin?.iconUrl, iconDarkUrl: origin?.iconDarkUrl }, held)];
    }));
}

export function subscribeMcpServerCatalogSnapshots(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function getMcpServerCatalogSnapshot(scope: ServerAccountScope | null | undefined): McpServerCatalogValueSnapshot {
    if (scope) return snapshots.get(serverAccountScopeKeySuffix(scope))?.value ?? loading;
    return loading;
}

export function applyAcknowledgedMcpServerCatalog(scope: ServerAccountScope, catalog: McpServerCatalogV1, revision: number, current: boolean): void {
    const previous = getMcpServerCatalogSnapshot(scope);
    if (!canPublishCatalogReceipt({ current, revision, retainedRevision: previous.revision })) return;
    const value = reconcileCatalog(previous.value, catalog);
    const next = retainDeep<McpServerCatalogValueSnapshot>(previous, { status: 'loading', value,
        brandMarks: projectBrandMarks(value, previous),
        revision, authority: 'active', stale: true, diagnostics: [], reason: 'loading',
        ...(previous.cleanup ? { cleanup: previous.cleanup } : {}) });
    if (previous === next) return;
    snapshots.set(serverAccountScopeKeySuffix(scope), { scope, value: next });
    for (const listener of [...listeners]) listener();
}
export function projectMcpServerCatalogSnapshot(snapshot: McpServerCatalogSnapshotV1,
    previous?: McpServerCatalogValueSnapshot, stale = false): McpServerCatalogValueSnapshot {
    let next: McpServerCatalogValueSnapshot;
    if (snapshot.status === 'ready' || snapshot.status === 'partial') {
        if (previous && !canPublishCatalogReceipt({ current: true, revision: snapshot.revision, retainedRevision: previous.revision })) return previous;
        const value = reconcileCatalog(previous?.value, snapshot.catalog);
        next = { status: stale ? 'loading' : snapshot.status, value, brandMarks: projectBrandMarks(value, previous),
            revision: retainCatalogRevision(snapshot, previous?.revision), authority: snapshot.authority,
            stale, diagnostics: snapshot.diagnostics, ...(stale ? { reason: 'loading' } : {}), ...(snapshot.cleanup ? { cleanup: snapshot.cleanup } : {}) };
    } else {
        const withdraw = snapshot.status === 'unavailable' && ['account-mode-mismatch', 'encryption-material-unavailable',
            'unauthorized', 'forbidden', 'account-not-found', 'account-inconsistent', 'invalid-stored-content', 'scope-retired'].includes(snapshot.reason);
        next = { status: snapshot.status, value: withdraw ? null : previous?.value ?? null,
            ...(withdraw || !previous?.brandMarks ? {} : { brandMarks: previous.brandMarks }),
            revision: retainCatalogRevision(snapshot, previous?.revision), authority: previous?.authority ?? 'inactive', stale: true,
            diagnostics: [], ...(snapshot.status === 'unavailable' ? { reason: snapshot.reason } : {}) };
    }
    return retainDeep(previous, next);
}
export function applyMcpServerCatalogSnapshot(scope: ServerAccountScope, snapshot: McpServerCatalogSnapshotV1, current: boolean, stale = false): void {
    if (!current) return;
    const key = serverAccountScopeKeySuffix(scope);
    const previous = snapshots.get(key)?.value;
    const next = projectMcpServerCatalogSnapshot(snapshot, previous, stale);
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
