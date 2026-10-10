import type { PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, type PromptLibraryCatalogKeyV1, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type PromptLibraryValueV1<K extends PromptLibraryCatalogKeyV1> = Extract<PromptLibraryRecordV1, { key: K }>['value'];
export type PromptLibraryCatalogValueSnapshot<K extends PromptLibraryCatalogKeyV1> = Readonly<{
    status: 'loading' | 'ready' | 'unavailable'; value: PromptLibraryValueV1<K> | null;
    revision: number | 'absent'; sourceSettingsVersion: number | null; stale: boolean; reason?: string;
}>;
export type PromptLibraryCatalogProjection = Readonly<{
    catalog: PromptLibraryCatalogSnapshotV1; rawSettings: Readonly<Record<string, unknown>>; sourceSettingsVersion: number;
}>;
type StoredSnapshot = Readonly<{ scope: ServerAccountScope; projection: PromptLibraryCatalogProjection;
    values: ReadonlyMap<PromptLibraryCatalogKeyV1, PromptLibraryCatalogValueSnapshot<PromptLibraryCatalogKeyV1>> }>;
const snapshots = new Map<string, StoredSnapshot>();
const listeners = new Set<() => void>();
const loading = Object.freeze({ status: 'loading', value: null, revision: 'absent', sourceSettingsVersion: null, stale: true } as const);
export function subscribePromptLibraryCatalogSnapshots(listener: () => void): () => void {
    listeners.add(listener); return () => { listeners.delete(listener); };
}
export function getPromptLibraryCatalogValue<K extends PromptLibraryCatalogKeyV1>(scope: ServerAccountScope | null | undefined, key: K): PromptLibraryCatalogValueSnapshot<K> {
    // Each entry is produced at the same validated key below; the generic preserves caller narrowing.
    return (scope ? snapshots.get(serverAccountScopeKeySuffix(scope))?.values.get(key) ?? loading : loading) as PromptLibraryCatalogValueSnapshot<K>;
}
export function getPromptLibraryCatalogSnapshot(scope: ServerAccountScope): PromptLibraryCatalogProjection | null {
    return snapshots.get(serverAccountScopeKeySuffix(scope))?.projection ?? null;
}
export function applyPromptLibraryCatalogSnapshot(scope: ServerAccountScope, projection: PromptLibraryCatalogProjection, current: boolean): void {
    if (!current || (projection.catalog.status === 'unavailable' && projection.catalog.reason === 'scope-retired')) return;
    const scopeKey = serverAccountScopeKeySuffix(scope);
    const previous = snapshots.get(scopeKey);
    const values = new Map<PromptLibraryCatalogKeyV1, PromptLibraryCatalogValueSnapshot<PromptLibraryCatalogKeyV1>>();
    let changed = !previous;
    for (const key of PromptLibraryCatalogKeyV1Schema.options) {
        const read = readPromptLibraryCatalogRecordV1({ catalog: projection.catalog, key, rawSettings: projection.rawSettings });
        const old = previous?.values.get(key);
        let next: PromptLibraryCatalogValueSnapshot<PromptLibraryCatalogKeyV1>;
        if (read.status === 'ready') {
            const value = old?.value && JSON.stringify(old.value) === JSON.stringify(read.record.value) ? old.value : read.record.value;
            next = { status: 'ready', value, revision: read.revision,
                sourceSettingsVersion: read.authority === 'inactive' ? projection.sourceSettingsVersion : null, stale: false };
        } else {
            const withdraw = ['account-mode-mismatch', 'encryption-material-unavailable', 'unauthorized', 'forbidden',
                'account-not-found', 'account-inconsistent', 'invalid-stored-content'].includes(read.reason);
            next = { status: read.reason === 'loading' ? 'loading' : 'unavailable', value: withdraw ? null : old?.value ?? null,
                revision: old?.revision ?? 'absent', sourceSettingsVersion: projection.sourceSettingsVersion,
                stale: true, reason: read.reason };
        }
        if (old && JSON.stringify(old) === JSON.stringify(next)) next = old;
        changed ||= next !== old;
        values.set(key, next);
    }
    snapshots.set(scopeKey, { scope, projection, values });
    if (!changed) return;
    for (const listener of [...listeners]) listener();
}
export function beginPromptLibraryCatalogLoad(scope: ServerAccountScope): void {
    const previous = getPromptLibraryCatalogSnapshot(scope);
    applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'loading' }, rawSettings: previous?.rawSettings ?? {},
        sourceSettingsVersion: previous?.sourceSettingsVersion ?? 0 }, true);
}
export function invalidatePromptLibraryCatalogsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) if (snapshot.scope.serverId === serverId) beginPromptLibraryCatalogLoad(snapshot.scope);
}
export function resetPromptLibraryCatalogSnapshotsForTests(): void { snapshots.clear(); listeners.clear(); }
