import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import type { SavedSecretCatalogSnapshot } from './savedSecretCatalogSnapshot';

export type SavedSecretCatalogNameUnavailableReason = ScopedSnapshotError
    | Readonly<{ kind: 'reference_unavailable' | 'scope_unavailable'; retryable: false }>;
/** Metadata-only presentation: never a reference id, credential value, or material-use authority. */
export type SavedSecretCatalogNameReading =
    | Readonly<{ status: 'ready'; name: string; resolving: false }>
    | Readonly<{ status: 'loading'; name: null; resolving: true }>
    | Readonly<{ status: 'unavailable'; name: null; resolving: false; reason: SavedSecretCatalogNameUnavailableReason }>;
export type SavedSecretCatalogReferenceSelection = Readonly<{
    scope: ServerAccountScope | null | undefined;
    refs: readonly string[];
}>;
const LOADING_NAME: SavedSecretCatalogNameReading = Object.freeze({ status: 'loading', name: null, resolving: true });
const ABSENT_NAME: SavedSecretCatalogNameReading = Object.freeze({ status: 'unavailable', name: null, resolving: false,
    reason: Object.freeze({ kind: 'reference_unavailable', retryable: false }) });
const NO_SCOPE_NAME: SavedSecretCatalogNameReading = Object.freeze({ status: 'unavailable', name: null, resolving: false,
    reason: Object.freeze({ kind: 'scope_unavailable', retryable: false }) });

/** Snapshot-owned indexes, rebuilt only at publication; exact readers never traverse the inventory. */
export function createSavedSecretCatalogReferences() {
    type Indexed = Readonly<{
        snapshot: SavedSecretCatalogSnapshot;
        entries: ReadonlyMap<string, SavedSecretCatalogEntryV1>;
        names: ReadonlyMap<string, SavedSecretCatalogNameReading>;
        material: ReadonlyMap<string, SavedSecret>;
        absentName: SavedSecretCatalogNameReading;
    }>;
    const scopes = new Map<string, Indexed>();
    const listeners = new Map<string, Map<string, Set<() => void>>>();
    const indexed = (scope: ServerAccountScope | null | undefined) => scope
        ? scopes.get(serverAccountScopeKeySuffix(scope)) : undefined;

    return {
        readEntry(scope: ServerAccountScope | null | undefined, ref: string): SavedSecretCatalogEntryV1 | null {
            return indexed(scope)?.entries.get(ref) ?? null;
        },
        readName(scope: ServerAccountScope | null | undefined, ref: string): SavedSecretCatalogNameReading {
            if (!scope) return NO_SCOPE_NAME;
            const current = indexed(scope);
            return current?.names.get(ref) ?? current?.absentName ?? LOADING_NAME;
        },
        readMaterial(scope: ServerAccountScope | null | undefined, ref: string): SavedSecret | null {
            return indexed(scope)?.material.get(ref) ?? null;
        },
        subscribe(selection: SavedSecretCatalogReferenceSelection, listener: () => void): () => void {
            if (!selection.scope || selection.refs.length === 0) return () => {};
            const key = serverAccountScopeKeySuffix(selection.scope);
            const byRef = listeners.get(key) ?? new Map<string, Set<() => void>>();
            listeners.set(key, byRef);
            const refs = [...new Set(selection.refs)];
            for (const ref of refs) {
                const held = byRef.get(ref) ?? new Set<() => void>();
                held.add(listener);
                byRef.set(ref, held);
            }
            return () => {
                for (const ref of refs) {
                    const held = byRef.get(ref);
                    held?.delete(listener);
                    if (held?.size === 0) byRef.delete(ref);
                }
                if (byRef.size === 0) listeners.delete(key);
            };
        },
        publish(snapshot: SavedSecretCatalogSnapshot, facts?: Readonly<{ withdrawnRef?: string; settled?: boolean }>): void {
            const key = serverAccountScopeKeySuffix(snapshot.scope);
            const previous = scopes.get(key);
            const changed = new Set<string>();
            let entries = previous?.entries ?? new Map<string, SavedSecretCatalogEntryV1>();
            let names = previous?.names ?? new Map<string, SavedSecretCatalogNameReading>();
            const refreshing = snapshot.status === 'loading' || snapshot.status === 'refreshing';
            if (!previous || previous.snapshot.data !== snapshot.data) {
                entries = new Map(snapshot.data?.map(entry => [entry.ref, entry]));
            }
            if (!previous || previous.snapshot.data !== snapshot.data || facts?.withdrawnRef !== undefined
                || (facts?.settled === true && previous.names.size !== previous.entries.size)) {
                const nextNames = new Map<string, SavedSecretCatalogNameReading>();
                // A removal already admitted by this owner stays settled through that refresh.
                // Settlement discards these temporary absent facts; the complete inventory then owns absence.
                if (facts?.settled !== true) for (const [ref, reading] of previous?.names ?? []) {
                    if (!entries.has(ref) && reading.status === 'unavailable') nextNames.set(ref, reading);
                }
                for (const entry of entries.values()) {
                    if (previous?.entries.get(entry.ref) !== entry) changed.add(entry.ref);
                    const name = previous?.names.get(entry.ref);
                    const reading: SavedSecretCatalogNameReading = entry.name === null ? ABSENT_NAME
                        : name?.status === 'ready' && name.name === entry.name
                            ? name : Object.freeze({ status: 'ready', name: entry.name, resolving: false });
                    nextNames.set(entry.ref, reading);
                }
                for (const ref of previous?.entries.keys() ?? []) if (!entries.has(ref)) {
                    changed.add(ref);
                    if (facts?.settled !== true) nextNames.set(ref, ABSENT_NAME);
                }
                if (facts?.withdrawnRef !== undefined && !entries.has(facts.withdrawnRef)) {
                    const before = previous?.names.get(facts.withdrawnRef) ?? previous?.absentName ?? LOADING_NAME;
                    nextNames.set(facts.withdrawnRef, ABSENT_NAME);
                    if (before !== ABSENT_NAME) changed.add(facts.withdrawnRef);
                }
                names = nextNames;
            }
            const absentName: SavedSecretCatalogNameReading = snapshot.error
                ? previous?.snapshot.error === snapshot.error && previous.absentName.status === 'unavailable'
                    ? previous.absentName
                    : Object.freeze({ status: 'unavailable', name: null, resolving: false, reason: Object.freeze({
                        kind: snapshot.error.kind, retryable: snapshot.error.retryable,
                        ...(snapshot.error.code === undefined ? {} : { code: snapshot.error.code }),
                    }) })
                : refreshing ? LOADING_NAME : ABSENT_NAME;
            const material = previous?.snapshot.materializedSecrets === snapshot.materializedSecrets
                ? previous.material : new Map(snapshot.materializedSecrets.map(secret => [secret.id, secret]));
            scopes.set(key, { snapshot, entries, names, material, absentName });
            const byRef = listeners.get(key);
            if (!byRef) return;
            // Missing references also consume catalog settlement. Existing rows do not consume that carrier.
            if ((previous?.absentName ?? LOADING_NAME) !== absentName || (previous?.snapshot.data != null) !== (snapshot.data !== null)) {
                for (const ref of byRef.keys()) if (!entries.has(ref)
                    && ((previous?.names.get(ref) ?? previous?.absentName ?? LOADING_NAME) !== (names.get(ref) ?? absentName)
                        || (previous?.snapshot.data != null) !== (snapshot.data !== null))) changed.add(ref);
            }
            const notify = new Set<() => void>();
            for (const ref of changed) for (const listener of byRef.get(ref) ?? []) notify.add(listener);
            for (const listener of notify) listener();
        },
        reset(): void { scopes.clear(); listeners.clear(); },
    };
}
