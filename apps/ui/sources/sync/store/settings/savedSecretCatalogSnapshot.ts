import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
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

export type SavedSecretCatalogSnapshot = Readonly<{
    scope: ServerAccountScope;
    status: ScopedSnapshotStatus;
    data: readonly SavedSecretCatalogEntryV1[] | null;
    corruptEntries: readonly SavedSecretCatalogCorruptEntryV1[];
    materializedSecrets: readonly SavedSecret[];
    legacyImport: SavedSecretLegacyImportResult | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

const snapshots = new Map<string, SavedSecretCatalogSnapshot>();
const listeners = new Set<() => void>();

const key = (scope: ServerAccountScope): string => serverAccountScopeKeySuffix(scope);

function notify(): void {
    for (const listener of [...listeners]) listener();
}

export function subscribeSavedSecretCatalogSnapshots(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getSavedSecretCatalogSnapshot(scope: ServerAccountScope | null | undefined): SavedSecretCatalogSnapshot | null {
    return scope ? snapshots.get(key(scope)) ?? null : null;
}

function preserveRows(previous: readonly SavedSecretCatalogEntryV1[] | null, incoming: readonly SavedSecretCatalogEntryV1[]): readonly SavedSecretCatalogEntryV1[] {
    const byRef = new Map(previous?.map((entry) => [entry.ref, entry]) ?? []);
    return Object.freeze(incoming.map((entry) => {
        const current = byRef.get(entry.ref);
        return current && JSON.stringify(current) === JSON.stringify(entry) ? current : Object.freeze({ ...entry });
    }));
}

export function beginSavedSecretCatalogLoad(scope: ServerAccountScope): void {
    const current = getSavedSecretCatalogSnapshot(scope);
    snapshots.set(key(scope), Object.freeze({
        scope,
        status: current?.data ? 'refreshing' : 'loading',
        data: current?.data ?? null,
        corruptEntries: current?.corruptEntries ?? EMPTY_CORRUPT_ENTRIES,
        materializedSecrets: EMPTY_MATERIALIZED_SECRETS,
        legacyImport: current?.legacyImport ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify();
}

export function applySavedSecretCatalogPage(params: Readonly<{ scope: ServerAccountScope; entries: readonly SavedSecretCatalogEntryV1[]; corruptEntries?: readonly SavedSecretCatalogCorruptEntryV1[]; materializedSecrets?: readonly SavedSecret[]; legacyImport?: SavedSecretLegacyImportResult; observedAt: number; current?: boolean }>): void {
    const previous = getSavedSecretCatalogSnapshot(params.scope);
    snapshots.set(key(params.scope), Object.freeze({
        scope: params.scope,
        status: 'ready',
        data: preserveRows(previous?.data ?? null, params.entries),
        corruptEntries: Object.freeze([...(params.corruptEntries ?? [])]),
        materializedSecrets: Object.freeze([...(params.materializedSecrets ?? [])]),
        legacyImport: params.legacyImport ?? null,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    notify();
}

export function applySavedSecretCatalogFailure(params: Readonly<{ scope: ServerAccountScope; error: ScopedSnapshotError }>): void {
    const current = getSavedSecretCatalogSnapshot(params.scope);
    const authoritativeRefusal = isAuthoritativeScopedSnapshotRefusal(params.error);
    const retained = authoritativeRefusal ? null : (current?.data ?? null);
    snapshots.set(key(params.scope), Object.freeze({
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
        error: params.error,
    }));
    notify();
}

export function invalidateSavedSecretCatalog(scope: ServerAccountScope): void {
    const current = getSavedSecretCatalogSnapshot(scope);
    if (!current || current.stale) return;
    snapshots.set(key(scope), Object.freeze({
        ...current,
        stale: true,
        materializedSecrets: EMPTY_MATERIALIZED_SECRETS,
    }));
    notify();
}

/** An acknowledged delete is authoritative even when the next catalog read fails. */
export function removeDeletedSavedSecretCatalogResource(scope: ServerAccountScope, resourceId: string): void {
    const current = getSavedSecretCatalogSnapshot(scope);
    if (!current) return;
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const data = current.data?.filter(entry => entry.ref !== ref) ?? null;
    const corruptEntries = current.corruptEntries.filter(entry => entry.repair?.resourceId !== resourceId);
    const materializedSecrets = current.materializedSecrets.filter(secret => secret.id !== ref);
    if (data?.length === current.data?.length && corruptEntries.length === current.corruptEntries.length
        && materializedSecrets.length === current.materializedSecrets.length) return;
    snapshots.set(key(scope), Object.freeze({
        ...current,
        data: data?.length === current.data?.length ? current.data : data ? Object.freeze(data) : null,
        corruptEntries: corruptEntries.length === current.corruptEntries.length ? current.corruptEntries : Object.freeze(corruptEntries),
        materializedSecrets: materializedSecrets.length === current.materializedSecrets.length ? current.materializedSecrets : Object.freeze(materializedSecrets),
    }));
    notify();
}

export function invalidateSavedSecretCatalogsForServer(serverId: string): void {
    let changed = false;
    for (const [snapshotKey, current] of snapshots) {
        if (current.scope.serverId !== serverId || current.stale) continue;
        snapshots.set(snapshotKey, Object.freeze({
            ...current,
            stale: true,
            materializedSecrets: EMPTY_MATERIALIZED_SECRETS,
        }));
        changed = true;
    }
    if (changed) notify();
}

export function resetSavedSecretCatalogSnapshotsForTests(): void {
    snapshots.clear();
    listeners.clear();
}

const EMPTY_MATERIALIZED_SECRETS: readonly SavedSecret[] = Object.freeze([]);
const EMPTY_CORRUPT_ENTRIES: readonly SavedSecretCatalogCorruptEntryV1[] = Object.freeze([]);

export type SavedSecretReferenceResolution = Readonly<{
    ref: string;
    kind: 'personal' | 'shared_resource';
    status: SavedSecretCatalogMaterialStatusV1;
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
 * catalog loss, while material is returned only from a current, ready snapshot
 * for this exact Account/Home scope.
 */
export function resolveSavedSecretReference(
    scope: ServerAccountScope | null | undefined,
    personalSecrets: readonly SavedSecret[],
    ref: string,
): SavedSecretReferenceResolution {
    const personalSecret = personalSecrets.find((candidate) => candidate.id === ref) ?? null;
    if (personalSecret) {
        return Object.freeze({
            ref,
            kind: 'personal',
            status: 'ready',
            entry: null,
            secret: personalSecret,
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
            secret,
            revision: secret?.updatedAt ?? null,
            fingerprint: formatSavedSecretCatalogFingerprintV1({ ref, source: 'personal', revision: secret?.updatedAt ?? null }),
        });
    }

    const snapshot = getSavedSecretCatalogSnapshot(scope);
    const entry = snapshot?.data?.find((candidate) => candidate.ref === ref) ?? null;
    const revision = entry?.revision ?? null;
    const fingerprint = formatSavedSecretCatalogFingerprintV1({ ref, source: 'shared_resource', revision });
    if (!snapshot || snapshot.stale || snapshot.status !== 'ready') {
        return Object.freeze({
            ref,
            kind: 'shared_resource',
            status: entry?.materialStatus === 'access_removed' || entry?.materialStatus === 'deleted'
                ? entry.materialStatus
                : 'temporarily_unavailable',
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
    const materialized = entry.materialStatus === 'ready' && entry.capabilities.use
        ? snapshot.materializedSecrets.find((secret) => (
            secret.id === ref && secret.updatedAt === entry.revision
        )) ?? null
        : null;
    return Object.freeze({
        ref,
        kind: 'shared_resource',
        status: materialized ? 'ready' : entry.materialStatus === 'ready'
            ? 'temporarily_unavailable'
            : entry.materialStatus,
        entry,
        secret: materialized,
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
    if (!snapshot || snapshot.stale || snapshot.status !== 'ready') return null;
    return snapshot.materializedSecrets.find((secret) => secret.id === ref) ?? null;
}

export function getMaterializedSavedSecrets(
    scope: ServerAccountScope | null | undefined,
): readonly SavedSecret[] {
    const snapshot = getSavedSecretCatalogSnapshot(scope);
    return snapshot && !snapshot.stale && snapshot.status === 'ready'
        ? snapshot.materializedSecrets
        : EMPTY_MATERIALIZED_SECRETS;
}
