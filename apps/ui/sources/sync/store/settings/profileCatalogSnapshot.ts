import type { ProfileCatalogSnapshotV1, ProfileCatalogRecordV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import type { AiLaunchProfile, AiLaunchProfileReadDiagnostic, LegacyProfileRecordPreparationV1 } from '@happier-dev/protocol/profiles/read';
import type { LegacyProfileTransferResultV1, ProfileTransferSourceCleanupResultV1 } from '@happier-dev/protocol/profiles/transferLegacyProfilesV1';
import { createRowInventoryReceiptOrdering } from './rowInventoryReceiptOrdering';

export type ProfileCatalogLegacyProjection = Readonly<{
    legacyProfiles?: readonly AiLaunchProfile[];
    legacyDiagnostics?: readonly (AiLaunchProfileReadDiagnostic | LegacyProfileRecordPreparationV1['diagnostics'][number])[];
    transfer?: LegacyProfileTransferResultV1;
    cleanup?: ProfileTransferSourceCleanupResultV1;
}>;

export type ProfileCatalogSnapshot = Readonly<{
    scope: ServerAccountScope;
    catalog: ProfileCatalogSnapshotV1;
    data: readonly ProfileCatalogRecordV1[] | null;
    /** Retained inventory coverage; loading alone cannot establish that an earlier partial read was complete. */
    dataComplete: boolean;
    stale: boolean;
    artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
    source: 'destination' | 'legacy' | null;
}> & ProfileCatalogLegacyProjection;
const snapshots = new Map<string, ProfileCatalogSnapshot>();
const receiptOrdering = createRowInventoryReceiptOrdering();
const listeners = new Set<() => void>();
const emptyArtifacts: ReadonlyMap<string, ArtifactSharingResourceV1> = new Map();
const loading: ProfileCatalogSnapshotV1 = Object.freeze({ status: 'loading' });
function publish(next: ProfileCatalogSnapshot): void {
    const key = serverAccountScopeKeySuffix(next.scope);
    const previous = snapshots.get(key);
    if (previous && previous.catalog === next.catalog && previous.data === next.data && previous.dataComplete === next.dataComplete
        && previous.stale === next.stale && previous.artifactsById === next.artifactsById && previous.source === next.source
        && previous.legacyProfiles === next.legacyProfiles && previous.legacyDiagnostics === next.legacyDiagnostics
        && previous.transfer === next.transfer && previous.cleanup === next.cleanup) return;
    snapshots.set(key, Object.freeze(next));
    for (const listener of [...listeners]) listener();
}
export function subscribeProfileCatalogSnapshots(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function getProfileCatalogSnapshot(scope: ServerAccountScope | null | undefined): ProfileCatalogSnapshot | null {
    return scope ? snapshots.get(serverAccountScopeKeySuffix(scope)) ?? null : null;
}
export function beginProfileCatalogLoad(scope: ServerAccountScope): void {
    const current = getProfileCatalogSnapshot(scope);
    publish({ scope, catalog: loading, data: current?.data ?? null, dataComplete: current?.dataComplete ?? false, stale: true,
        artifactsById: current?.artifactsById ?? emptyArtifacts, source: current?.source ?? null,
        legacyProfiles: current?.legacyProfiles, legacyDiagnostics: current?.legacyDiagnostics,
        transfer: current?.transfer, cleanup: current?.cleanup });
}
export function applyProfileCatalogSnapshot(scope: ServerAccountScope, catalog: ProfileCatalogSnapshotV1, current: boolean,
    artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1> = emptyArtifacts, legacy: ProfileCatalogLegacyProjection = {}, fresh = true): void {
    if (!current) return;
    if (catalog.status === 'unavailable' && catalog.reason === 'scope-retired') {
        receiptOrdering.clearScope(scope);
    }
    const previous = getProfileCatalogSnapshot(scope);
    // A wake can overtake the first checked read. Retain that cold answer for
    // display while the queued census catches up, without replacing newer
    // retained/acknowledged data or granting runtime and mutation authority.
    if (!fresh && (previous?.data != null || (catalog.status !== 'ready' && catalog.status !== 'partial'))) return;
    const refused = catalog.status === 'unavailable' && ['scope-retired', 'unauthorized', 'forbidden', 'account-mode-mismatch',
        'account-not-found', 'account-inconsistent', 'encryption-material-unavailable'].includes(catalog.reason);
    if (refused || ((catalog.status === 'ready' || catalog.status === 'partial') && catalog.source !== 'destination')) {
        receiptOrdering.clearScope(scope);
    } else if (catalog.status === 'ready' || catalog.status === 'partial') {
        for (const row of catalog.records) receiptOrdering.retain(scope, row.record.id, row.revision);
        for (const row of catalog.tombstones ?? []) receiptOrdering.retain(scope, row.id, row.revision);
        for (const row of catalog.diagnostics) receiptOrdering.retain(scope, row.id, row.revision);
    }
    let data = refused ? null : previous?.data ?? null;
    if (catalog.status === 'ready' || catalog.status === 'partial') {
        const byId = new Map(previous?.data?.map(row => [row.record.id, row]) ?? []);
        const rows = catalog.records.map(row => {
            const old = byId.get(row.record.id);
            return old && JSON.stringify(old) === JSON.stringify(row) ? old : row;
        });
        data = previous?.data && rows.length === previous.data.length
            && rows.every((row, index) => row === previous.data![index]) ? previous.data : Object.freeze(rows);
        catalog = { ...catalog, records: data };
    }
    if (previous && JSON.stringify(previous.catalog) === JSON.stringify(catalog)) catalog = previous.catalog;
    const previousArtifacts = previous?.artifactsById;
    const sameArtifacts = previousArtifacts && previousArtifacts.size === artifactsById.size
        && [...artifactsById].every(([id, value]) => JSON.stringify(previousArtifacts.get(id)) === JSON.stringify(value));
    const ready = catalog.status === 'ready' || catalog.status === 'partial';
    const legacyProfiles = refused ? undefined : ready ? legacy.legacyProfiles : previous?.legacyProfiles;
    const legacyDiagnostics = refused ? undefined : ready ? legacy.legacyDiagnostics : previous?.legacyDiagnostics;
    const transfer = refused ? undefined : ready ? legacy.transfer : previous?.transfer;
    const cleanup = refused ? undefined : ready ? legacy.cleanup : previous?.cleanup;
    const dataComplete = refused ? false : ready
        ? catalog.status === 'ready' && catalog.diagnostics.length === 0 && (legacyDiagnostics?.length ?? 0) === 0
        : previous?.dataComplete ?? false;
    publish({ scope, catalog: fresh ? catalog : loading, data, dataComplete, stale: !fresh || catalog.status !== 'ready',
        artifactsById: refused ? emptyArtifacts : !ready ? previousArtifacts ?? emptyArtifacts
            : sameArtifacts ? previousArtifacts : artifactsById,
        source: refused ? null : catalog.status === 'ready' || catalog.status === 'partial'
            ? catalog.source ?? null : previous?.source ?? null,
        legacyProfiles: previous && JSON.stringify(previous.legacyProfiles) === JSON.stringify(legacyProfiles) ? previous.legacyProfiles : legacyProfiles,
        legacyDiagnostics: previous && JSON.stringify(previous.legacyDiagnostics) === JSON.stringify(legacyDiagnostics) ? previous.legacyDiagnostics : legacyDiagnostics,
        transfer: previous && JSON.stringify(previous.transfer) === JSON.stringify(transfer) ? previous.transfer : transfer,
        cleanup: previous && JSON.stringify(previous.cleanup) === JSON.stringify(cleanup) ? previous.cleanup : cleanup });
}
export function invalidateProfileCatalog(scope: ServerAccountScope): void { beginProfileCatalogLoad(scope); }
/** A durable row receipt updates last-known display data, never census/runtime authority. */
export function applyAcknowledgedProfileRecord(scope: ServerAccountScope,
    input: Readonly<{ id: string; revision: number; record: ProfileRecordV1 | null }>, current: boolean): void {
    const previous = getProfileCatalogSnapshot(scope);
    if (!current || !previous?.data || previous.source !== 'destination') return;
    const existing = previous.data.find(row => row.record.id === input.id);
    if (!receiptOrdering.admit(scope, input.id, input.revision)) return;
    const record = input.record;
    const data = record ? previous.data.map(row => row.record.id === input.id ? { record, revision: input.revision } : row)
        : previous.data.filter(row => row.record.id !== input.id);
    if (record && !existing) data.push({ record, revision: input.revision });
    publish({ ...previous, catalog: loading, data: Object.freeze(data), stale: true });
}
/** Body receipts use the same retained projection as row receipts. */
export function applyAcknowledgedProfileArtifact(scope: ServerAccountScope, artifact: ArtifactSharingResourceV1, current: boolean): void {
    const previous = getProfileCatalogSnapshot(scope);
    const existing = previous?.artifactsById.get(artifact.artifactId);
    if (!current || previous?.source !== 'destination' || !existing || !artifact.revision) return;
    if (existing.revision && (existing.revision.headerVersion > artifact.revision.headerVersion
        || existing.revision.bodyVersion > artifact.revision.bodyVersion)) return;
    const artifactsById = new Map(previous.artifactsById);
    artifactsById.set(artifact.artifactId, artifact);
    publish({ ...previous, catalog: loading, artifactsById, stale: true });
}
export function invalidateProfileCatalogsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) if (snapshot.scope.serverId === serverId) beginProfileCatalogLoad(snapshot.scope);
}
export function resetProfileCatalogSnapshotsForTests(): void { snapshots.clear(); receiptOrdering.reset(); listeners.clear(); }
