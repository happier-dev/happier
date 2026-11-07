import type { ConnectedMetadataCatalogV1 } from '@happier-dev/protocol/connect/connectedMetadataCatalogV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { connectedAcknowledgementSubjectKeyV1, projectConnectedPresentationLabelsV1,
    type ConnectedPresentationRecordV1, type ConnectedAcknowledgementsRecordV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import { isDemoModeActive } from '@/demoMode/runtime/enterExitDemoMode';
import { canPublishCatalogReceipt, retainCatalogRevision } from './wholeCatalogReceiptOrdering';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

export type ConnectedMetadataCatalogSnapshot = ConnectedMetadataCatalogV1 & Readonly<{
    labelsByKey: Readonly<Record<string, string>>;
    acknowledgementsByKey: Readonly<Record<string, boolean>>;
    presentationStale: boolean;
    acknowledgementsStale: boolean;
    presentationRevision?: number;
    acknowledgementsRevision?: number;
}>;
type StoredSnapshot = Readonly<{ scope: ServerAccountScope; snapshot: ConnectedMetadataCatalogSnapshot }>;
const snapshots = new Map<string, StoredSnapshot>();
const listeners = new Set<() => void>();
let demoProjection: ConnectedMetadataCatalogSnapshot | null = null;
const emptyLabels: Readonly<Record<string, string>> = Object.freeze({});
const emptyAcknowledgements: Readonly<Record<string, boolean>> = Object.freeze({});
const loading: ConnectedMetadataCatalogSnapshot = Object.freeze({
    presentation: Object.freeze({ status: 'loading' as const }),
    acknowledgements: Object.freeze({ status: 'loading' as const }), disclosure: Object.freeze([]),
    labelsByKey: emptyLabels, acknowledgementsByKey: emptyAcknowledgements,
    presentationStale: true, acknowledgementsStale: true,
});

export function subscribeConnectedMetadataCatalog(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function getConnectedMetadataCatalog(scope: ServerAccountScope | null | undefined): ConnectedMetadataCatalogSnapshot {
    if (scope) return snapshots.get(serverAccountScopeKeySuffix(scope))?.snapshot ?? loading;
    return isDemoModeActive() ? demoProjection ?? loading : loading;
}
function withdraws(reason: string): boolean {
    return isAuthoritativeScopedSnapshotRefusalKind(reason)
        || ['account-mode-mismatch', 'encryption-material-unavailable', 'account-not-found',
            'account-inconsistent', 'invalid-stored-content'].includes(reason);
}
function numericRevision(revision: number | 'absent'): number | undefined {
    return typeof revision === 'number' ? revision : undefined;
}
function projectSnapshot(projection: ConnectedMetadataCatalogV1, previous: ConnectedMetadataCatalogSnapshot): ConnectedMetadataCatalogSnapshot {
    const presentation = projection.presentation;
    const acknowledgements = projection.acknowledgements;
    const labelsByKey = retainDeep(previous.labelsByKey,
        presentation.status === 'ready' || presentation.status === 'partial' ? projectConnectedPresentationLabelsV1(presentation)
            : presentation.status === 'unavailable' && withdraws(presentation.reason) ? emptyLabels : previous.labelsByKey);
    const acknowledgementsByKey = retainDeep(previous.acknowledgementsByKey,
        acknowledgements.status === 'ready' || acknowledgements.status === 'partial'
            ? Object.fromEntries(acknowledgements.entries.map(entry => [connectedAcknowledgementSubjectKeyV1(entry.subject), entry.acknowledged]))
            : acknowledgements.status === 'unavailable' && withdraws(acknowledgements.reason) ? emptyAcknowledgements : previous.acknowledgementsByKey);
    return {
        ...projection,
        presentation: JSON.stringify(previous.presentation) === JSON.stringify(presentation) ? previous.presentation : presentation,
        acknowledgements: JSON.stringify(previous.acknowledgements) === JSON.stringify(acknowledgements) ? previous.acknowledgements : acknowledgements,
        labelsByKey, acknowledgementsByKey,
        presentationStale: presentation.status !== 'ready', acknowledgementsStale: acknowledgements.status !== 'ready',
        presentationRevision: numericRevision(retainCatalogRevision(presentation, previous.presentationRevision)),
        acknowledgementsRevision: numericRevision(retainCatalogRevision(acknowledgements, previous.acknowledgementsRevision)),
    };
}
export function applyAcknowledgedConnectedMetadata(scope: ServerAccountScope,
    acknowledged: Readonly<{ kind: 'presentation'; record: ConnectedPresentationRecordV1 }>
        | Readonly<{ kind: 'acknowledgements'; record: ConnectedAcknowledgementsRecordV1 }>, revision: number, current: boolean): void {
    const previous = getConnectedMetadataCatalog(scope);
    const oldRevision = acknowledged.kind === 'presentation' ? previous.presentationRevision : previous.acknowledgementsRevision;
    if (!canPublishCatalogReceipt({ current, revision, retainedRevision: oldRevision })) return;
    const next = projectSnapshot(acknowledged.kind === 'presentation'
        ? { ...previous, presentation: { status: 'ready', entries: acknowledged.record.entries, revision, diagnostics: [] } }
        : { ...previous, acknowledgements: { status: 'ready', entries: acknowledged.record.entries, revision, diagnostics: [] } }, previous);
    const snapshot = { ...next,
        ...(acknowledged.kind === 'presentation' ? { presentationStale: true } : { acknowledgementsStale: true }) };
    if (sameStrictJsonValue(previous, snapshot)) return;
    snapshots.set(serverAccountScopeKeySuffix(scope), { scope, snapshot });
    for (const listener of [...listeners]) listener();
}
/** Seed-owned display fixture only. Real Account scopes and mutation admission never use it. */
export function setDemoConnectedMetadataCatalogProjection(projection: ConnectedMetadataCatalogV1 | null): void {
    if (projection && !isDemoModeActive()) throw new Error('Demo catalog projection requires the seeded demo lifetime');
    if (!projection && !demoProjection) return;
    demoProjection = projection ? projectSnapshot(projection, loading) : null;
    for (const listener of [...listeners]) listener();
}
export function applyConnectedMetadataCatalogSnapshot(scope: ServerAccountScope, projection: ConnectedMetadataCatalogV1, current: boolean): void {
    if (!current || (projection.presentation.status === 'unavailable' && projection.presentation.reason === 'scope-retired')
        || (projection.acknowledgements.status === 'unavailable' && projection.acknowledgements.reason === 'scope-retired')) return;
    const key = serverAccountScopeKeySuffix(scope);
    const previous = getConnectedMetadataCatalog(scope);
    const next = projectSnapshot(projection, previous);
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    snapshots.set(key, { scope, snapshot: next });
    for (const listener of [...listeners]) listener();
}
/** Refresh is transport work; only explicit invalidation withdraws retained admission. */
export function beginConnectedMetadataCatalogLoad(scope: ServerAccountScope, invalidate = false): void {
    if (!invalidate && snapshots.has(serverAccountScopeKeySuffix(scope))) return;
    applyConnectedMetadataCatalogSnapshot(scope, { presentation: { status: 'loading' }, acknowledgements: { status: 'loading' }, disclosure: [] }, true);
}
