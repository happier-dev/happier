import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { SavedSecretCatalogCorruptEntryV1, SavedSecretCatalogEntryV1, SavedSecretCatalogMaterialStatusV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSavedSecretCatalogFingerprintV1, formatSavedSecretCatalogReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { SavedSecret, SavedSecretLegacyImportResult } from '@/sync/domains/settings/savedSecretTypes';

import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    isAuthoritativeScopedSnapshotRefusal,
    reachabilityForScopedSnapshotError,
    type ScopedSnapshotError,
    type ScopedSnapshotReachability,
    type ScopedSnapshotStatus,
} from '@/sync/domains/scope/scopedSnapshotFacts';
import { createRowInventoryReceiptOrdering } from './rowInventoryReceiptOrdering';
import { createSavedSecretCatalogReferences, type SavedSecretCatalogReferenceSelection } from './savedSecretCatalogReferences';
import { areSnapshotProjectionsEquivalent, retainDeep, retainKeyedRows } from '@/sync/domains/state/structuralSharing';
export type { SavedSecretCatalogNameReading, SavedSecretCatalogNameUnavailableReason } from './savedSecretCatalogReferences';

export type SavedSecretCatalogSnapshot = Readonly<{
    scope: ServerAccountScope;
    status: ScopedSnapshotStatus;
    data: readonly SavedSecretCatalogEntryV1[] | null;
    corruptEntries: readonly SavedSecretCatalogCorruptEntryV1[];
    materializedSecrets: readonly SavedSecret[];
    /** Metadata-only reads cannot establish material readiness, including for an empty catalog. */
    includesMaterial?: boolean;
    legacyImport: SavedSecretLegacyImportResult | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

const snapshots = new Map<string, SavedSecretCatalogSnapshot>();
const receiptOrdering = createRowInventoryReceiptOrdering();
const references = createSavedSecretCatalogReferences();
const listeners = new Set<() => void>();

const key = (scope: ServerAccountScope): string => serverAccountScopeKeySuffix(scope);

function notify(): void {
    for (const listener of [...listeners]) listener();
}

function publish(next: SavedSecretCatalogSnapshot, notifyInventory = true,
    referenceFacts?: Parameters<typeof references.publish>[1]): void {
    const previous = getSavedSecretCatalogSnapshot(next.scope);
    if (previous && sameStrictJsonValue(previous, next)) {
        if (referenceFacts) references.publish(previous, referenceFacts);
        return;
    }
    if (previous && sameStrictJsonValue({ ...previous, lastObservedAt: null }, { ...next, lastObservedAt: null })) {
        // The refresh owner may read its observation time without publishing unchanged catalog content.
        const observed = Object.freeze({ ...previous, lastObservedAt: next.lastObservedAt });
        snapshots.set(key(next.scope), observed);
        references.publish(observed, referenceFacts);
        return;
    }
    snapshots.set(key(next.scope), Object.freeze(next));
    references.publish(next, referenceFacts);
    if (notifyInventory) notify();
}

/** A reference selection consumes metadata and catalog settlement, never unrelated material/freshness carriers. */
export function subscribeSavedSecretCatalogSnapshots(listener: () => void, selection?: SavedSecretCatalogReferenceSelection): () => void {
    if (selection) return references.subscribe(selection, listener);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export const readSavedSecretCatalogEntry = references.readEntry;
export const readSavedSecretCatalogName = references.readName;

export function getSavedSecretCatalogSnapshot(scope: ServerAccountScope | null | undefined): SavedSecretCatalogSnapshot | null {
    return scope ? snapshots.get(key(scope)) ?? null : null;
}
/** A receipt establishes metadata, never permission to reuse pre-write material. */
export function applyAcknowledgedSavedSecretCatalogEntry(scope: ServerAccountScope, entry: SavedSecretCatalogEntryV1, current: boolean): void {
    if (!current) return;
    const previous = getSavedSecretCatalogSnapshot(scope);
    const old = readSavedSecretCatalogEntry(scope, entry.ref);
    if (!receiptOrdering.admit(scope, entry.ref, entry.revision)) return;
    const entries = previous?.data ?? [];
    const data = old ? entries.map(candidate => candidate.ref === entry.ref ? entry : candidate) : [...entries, entry];
    publish({ scope, status: 'refreshing', data: Object.freeze(data),
        corruptEntries: previous?.corruptEntries ?? EMPTY_CORRUPT_ENTRIES, materializedSecrets: EMPTY_MATERIALIZED_SECRETS,
        legacyImport: previous?.legacyImport ?? null, lastObservedAt: previous?.lastObservedAt ?? null,
        stale: true, reachability: previous?.reachability ?? 'unknown', error: null });
}

function preserveRows(previous: readonly SavedSecretCatalogEntryV1[] | null, incoming: readonly SavedSecretCatalogEntryV1[]): readonly SavedSecretCatalogEntryV1[] {
    return retainKeyedRows(previous, incoming.map((entry) => Object.freeze({ ...entry })), (entry) => entry.ref);
}

function hasCurrentMaterial(snapshot: SavedSecretCatalogSnapshot | null): snapshot is SavedSecretCatalogSnapshot {
    return snapshot !== null && !snapshot.stale && snapshot.error === null
        && (snapshot.status === 'ready' || snapshot.status === 'refreshing');
}

export function beginSavedSecretCatalogLoad(scope: ServerAccountScope): void {
    const current = getSavedSecretCatalogSnapshot(scope);
    publish({
        scope,
        status: current?.data ? 'refreshing' : 'loading',
        data: current?.data ?? null,
        corruptEntries: current?.corruptEntries ?? EMPTY_CORRUPT_ENTRIES,
        // A read alone does not revoke the admitted material. Wakes, receipts,
        // observer gaps and failures withdraw its authority through invalidation.
        materializedSecrets: hasCurrentMaterial(current) ? current.materializedSecrets : EMPTY_MATERIALIZED_SECRETS,
        includesMaterial: hasCurrentMaterial(current) && current.includesMaterial === true,
        legacyImport: current?.legacyImport ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    });
}

export function applySavedSecretCatalogPage(params: Readonly<{ scope: ServerAccountScope; entries: readonly SavedSecretCatalogEntryV1[]; corruptEntries?: readonly SavedSecretCatalogCorruptEntryV1[]; materializedSecrets?: readonly SavedSecret[]; includesMaterial?: boolean; legacyImport?: SavedSecretLegacyImportResult; observedAt: number; current?: boolean }>): void {
    const previous = getSavedSecretCatalogSnapshot(params.scope);
    for (const entry of params.entries) receiptOrdering.retain(params.scope, entry.ref, entry.revision);
    for (const entry of params.corruptEntries ?? []) {
        if (!entry.repair) continue;
        try {
            receiptOrdering.retain(params.scope,
                formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: entry.repair.resourceId }), entry.repair.expectedRevision);
        } catch {
            // An opaque corrupt identity cannot match a valid metadata receipt; preserve its repair row unchanged.
        }
    }
    publish({
        scope: params.scope,
        status: 'ready',
        data: preserveRows(previous?.data ?? null, params.entries),
        corruptEntries: previous && areSnapshotProjectionsEquivalent(previous.corruptEntries, params.corruptEntries ?? [])
            ? previous.corruptEntries : Object.freeze([...(params.corruptEntries ?? [])]),
        materializedSecrets: retainKeyedRows(previous?.materializedSecrets ?? null,
            params.materializedSecrets ?? EMPTY_MATERIALIZED_SECRETS, secret => secret.id),
        includesMaterial: params.includesMaterial !== false,
        legacyImport: retainDeep(previous?.legacyImport, params.legacyImport ?? null),
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }, true, { settled: true });
}

export function applySavedSecretCatalogFailure(params: Readonly<{ scope: ServerAccountScope; error: ScopedSnapshotError }>): void {
    const current = getSavedSecretCatalogSnapshot(params.scope);
    const authoritativeRefusal = isAuthoritativeScopedSnapshotRefusal(params.error);
    if (authoritativeRefusal) receiptOrdering.clearScope(params.scope);
    const retained = authoritativeRefusal ? null : (current?.data ?? null);
    publish({
        scope: params.scope,
        status: 'error',
        data: retained,
        corruptEntries: authoritativeRefusal
            ? EMPTY_CORRUPT_ENTRIES
            : (current?.corruptEntries ?? EMPTY_CORRUPT_ENTRIES),
        materializedSecrets: EMPTY_MATERIALIZED_SECRETS,
        legacyImport: authoritativeRefusal ? null : current?.legacyImport ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: true,
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: retainDeep(current?.error ?? undefined, params.error),
    }, true, { settled: true });
}

export function invalidateSavedSecretCatalog(scope: ServerAccountScope): void {
    const current = getSavedSecretCatalogSnapshot(scope);
    if (!current || current.stale) return;
    publish({
        ...current,
        stale: true,
        materializedSecrets: EMPTY_MATERIALIZED_SECRETS,
    });
}

/** An acknowledged delete is authoritative even when the next catalog read fails. */
export function removeDeletedSavedSecretCatalogResource(scope: ServerAccountScope, resourceId: string,
    expectedRevision?: number, isCurrent = true): void {
    if (!isCurrent) return;
    const current = getSavedSecretCatalogSnapshot(scope);
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const removedRevision = expectedRevision ?? readSavedSecretCatalogEntry(scope, ref)?.revision
        ?? current?.corruptEntries.find(entry => entry.repair?.resourceId === resourceId)?.repair?.expectedRevision;
    if (!receiptOrdering.admitRemoval(scope, ref, removedRevision) || !current) return;
    const data = current.data?.filter(entry => entry.ref !== ref) ?? null;
    const corruptEntries = current.corruptEntries.filter(entry => entry.repair?.resourceId !== resourceId);
    const materializedSecrets = current.materializedSecrets.filter(secret => secret.id !== ref);
    if (data?.length === current.data?.length && corruptEntries.length === current.corruptEntries.length
        && materializedSecrets.length === current.materializedSecrets.length) {
        publish(current, true, { withdrawnRef: ref });
        return;
    }
    publish({
        ...current,
        data: data?.length === current.data?.length ? current.data : data ? Object.freeze(data) : null,
        corruptEntries: corruptEntries.length === current.corruptEntries.length ? current.corruptEntries : Object.freeze(corruptEntries),
        materializedSecrets: materializedSecrets.length === current.materializedSecrets.length ? current.materializedSecrets : Object.freeze(materializedSecrets),
    }, true, { withdrawnRef: ref });
}

export function invalidateSavedSecretCatalogsForServer(serverId: string): void {
    let changed = false;
    for (const current of snapshots.values()) {
        if (current.scope.serverId !== serverId || current.stale) continue;
        publish({
            ...current,
            stale: true,
            materializedSecrets: EMPTY_MATERIALIZED_SECRETS,
        }, false);
        changed = true;
    }
    if (changed) notify();
}

export function resetSavedSecretCatalogSnapshotsForTests(): void {
    snapshots.clear();
    receiptOrdering.reset();
    references.reset();
    listeners.clear();
}

const EMPTY_MATERIALIZED_SECRETS: readonly SavedSecret[] = Object.freeze([]);
const EMPTY_CORRUPT_ENTRIES: readonly SavedSecretCatalogCorruptEntryV1[] = Object.freeze([]);

export type SavedSecretReferenceResolution = Readonly<{
    ref: string;
    kind: 'personal' | 'shared_resource';
    status: SavedSecretCatalogMaterialStatusV1;
    /** Last-known metadata for display only; `status` and `secret` still govern material use. */
    displayStatus?: SavedSecretCatalogMaterialStatusV1;
    entry: SavedSecretCatalogEntryV1 | null;
    secret: SavedSecret | null;
    revision: number | null;
    /** Stable non-secret identity used to invalidate recipient approval after rotation. */
    fingerprint: string | null;
}>;

/**
 * Canonical value-bearing projection for any persisted SavedSecret ref.
 *
 * An extant legacy personal row wins before namespace parsing so reserved-ref
 * collisions retain value continuity until the Settings CAS rekeys them.
 * Otherwise shared refs remain shared: their metadata survives transient
 * catalog loss, while material is returned only from a current snapshot
 * for this exact Account/Home scope.
 */
export function resolveSavedSecretReference(
    scope: ServerAccountScope | null | undefined,
    personalSecrets: readonly SavedSecret[],
    ref: string,
    options?: Readonly<{ includeMaterial?: boolean }>,
): SavedSecretReferenceResolution {
    const personalSecret = personalSecrets.find((candidate) => candidate.id === ref) ?? null;
    if (personalSecret) {
        return Object.freeze({
            ref,
            kind: 'personal',
            status: 'ready',
            entry: null,
            secret: options?.includeMaterial === false ? null : personalSecret,
            revision: personalSecret.updatedAt,
            fingerprint: formatSavedSecretCatalogFingerprintV1({ ref, source: 'personal', revision: personalSecret.updatedAt }),
        });
    }
    let parsed: ReturnType<typeof parseSavedSecretRefV1>;
    try {
        parsed = parseSavedSecretRefV1(ref);
    } catch {
        return Object.freeze({
            ref,
            kind: ref.startsWith('happier:shared-secret:v1:') ? 'shared_resource' : 'personal',
            status: 'temporarily_unavailable',
            entry: null,
            secret: null,
            revision: null,
            fingerprint: null,
        });
    }
    if (parsed.kind === 'personal') {
        const secret = personalSecrets.find((candidate) => candidate.id === ref) ?? null;
        return Object.freeze({
            ref,
            kind: 'personal',
            status: secret ? 'ready' : 'deleted',
            entry: null,
            secret: options?.includeMaterial === false ? null : secret,
            revision: secret?.updatedAt ?? null,
            fingerprint: formatSavedSecretCatalogFingerprintV1({ ref, source: 'personal', revision: secret?.updatedAt ?? null }),
        });
    }

    const snapshot = getSavedSecretCatalogSnapshot(scope);
    const entry = readSavedSecretCatalogEntry(scope, ref);
    const revision = entry?.revision ?? null;
    const fingerprint = formatSavedSecretCatalogFingerprintV1({ ref, source: 'shared_resource', revision });
    if (!hasCurrentMaterial(snapshot) || (!entry && snapshot.status !== 'ready')) {
        return Object.freeze({
            ref,
            kind: 'shared_resource',
            status: entry?.materialStatus === 'access_removed' || entry?.materialStatus === 'deleted'
                ? entry.materialStatus
                : 'temporarily_unavailable',
            ...(entry && snapshot?.status !== 'error' ? { displayStatus: entry.materialStatus } : {}),
            entry,
            secret: null,
            revision,
            fingerprint,
        });
    }
    if (!entry) {
        return Object.freeze({
            ref,
            kind: 'shared_resource',
            status: 'access_removed',
            entry: null,
            secret: null,
            revision: null,
            fingerprint: null,
        });
    }
    const usable = entry.materialStatus === 'ready' && entry.capabilities.use;
    const materialized = usable && options?.includeMaterial !== false
        ? references.readMaterial(scope, ref)
        : null;
    const currentMaterial = materialized?.updatedAt === entry.revision ? materialized : null;
    return Object.freeze({
        ref,
        kind: 'shared_resource',
        status: currentMaterial || (usable && options?.includeMaterial === false) ? 'ready' : entry.materialStatus === 'ready'
            ? 'temporarily_unavailable'
            : entry.materialStatus,
        entry,
        secret: currentMaterial,
        revision,
        fingerprint,
    });
}

export function getUsableSavedSecrets(
    scope: ServerAccountScope | null | undefined,
    personalSecrets: readonly SavedSecret[],
): readonly SavedSecret[] {
    const shared = getMaterializedSavedSecrets(scope).filter((secret) => (
        resolveSavedSecretReference(scope, personalSecrets, secret.id).status === 'ready'
    ));
    return shared.length === 0
        ? personalSecrets
        : Object.freeze([...personalSecrets, ...shared]);
}

export function getMaterializedSavedSecret(
    scope: ServerAccountScope | null | undefined,
    ref: string,
): SavedSecret | null {
    const snapshot = getSavedSecretCatalogSnapshot(scope);
    if (!hasCurrentMaterial(snapshot)) return null;
    return references.readMaterial(scope, ref);
}

export function getMaterializedSavedSecrets(
    scope: ServerAccountScope | null | undefined,
): readonly SavedSecret[] {
    const snapshot = getSavedSecretCatalogSnapshot(scope);
    return hasCurrentMaterial(snapshot)
        ? snapshot.materializedSecrets
        : EMPTY_MATERIALIZED_SECRETS;
}
