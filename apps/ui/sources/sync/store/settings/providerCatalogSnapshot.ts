import type { ProviderConnectionsCatalogSnapshotV1, ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { DaemonProviderModelProjectionResponseV1, DaemonProviderModelsResponseV1, DaemonProviderConnectionsDescribeResponseV1 } from '@happier-dev/protocol/rpc/providers';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ProviderConnectionId } from '@happier-dev/protocol/providers/ids';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialChange, type HomeCredentialMutationEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { parseToken } from '@/utils/auth/parseToken';
import { canPublishCatalogReceipt, retainCatalogRevision } from './wholeCatalogReceiptOrdering';
import { ProviderCatalogReferences } from './providerCatalogReferences';
import { reconcileProviderCatalog } from './providerCatalogReconciliation';

/** Public key evidence from a read admitted under persisted E2EE mode; never retained key bytes. */
export type ProviderCatalogCryptoAdmission = Readonly<{ contentPublicKeyFingerprint: string }>;

export type ProviderCatalogSnapshot = Readonly<{
    scope: ServerAccountScope; status: ProviderConnectionsCatalogSnapshotV1['status'];
    catalog: ProviderConnectionsCatalogSnapshotV1; data: ProviderConnectionsCatalogV1 | null;
    revision: number | 'absent'; stale: boolean;
    /** Local write receipts advance editor bases; remote refreshes must not overwrite an open draft. */
    acknowledgedRevision?: number;
    cryptoAdmission: ProviderCatalogCryptoAdmission | null;
}>;
const snapshots = new Map<string, ProviderCatalogSnapshot>();
const references = new ProviderCatalogReferences();
type ModelProjection = Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }>;
type ConnectionModels = Extract<DaemonProviderModelsResponseV1, { status: 'success' }>;
type ConnectionCheck = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;
type ModelDisplay = Readonly<{ kind: 'projection'; value: ModelProjection }>
    | Readonly<{ kind: 'connection-list'; value: ConnectionModels }>
    | Readonly<{ kind: 'connection-check'; value: ConnectionCheck; accountCatalog: ProviderConnectionsCatalogV1 | null; readRequired?: true }>;
type ModelProjectionSnapshot = {
    scope: ServerAccountScope;
    data: ModelDisplay | null;
    requested: number;
    accepted: number;
    listeners: Set<() => void>;
};
// One display snapshot per exact credential/query, retired by the same credential
// lifecycle as the Account catalog. Retention creates no read or polling demand.
const modelProjections = new Map<string, ModelProjectionSnapshot>();
const listeners = new Set<() => void>();
let unsubscribeCredentials: (() => void) | null = null;

function onCredentialChange(event: HomeCredentialMutationEvent): void {
    for (const [key, snapshot] of modelProjections) {
        if (!areServerProfileIdentifiersEquivalent(snapshot.scope.serverId, event.serverId)) continue;
        withdrawModelProjection(key, snapshot);
    }
    for (const snapshot of [...snapshots.values()]) {
        if (!snapshot.data || !snapshot.cryptoAdmission
            || !areServerProfileIdentifiersEquivalent(snapshot.scope.serverId, event.serverId)) continue;
        let reason: 'unauthorized' | 'encryption-material-unavailable' | null = null;
        if (event.kind === 'credentials_removed' || !event.credentials) reason = 'unauthorized';
        else {
            try {
                if (parseToken(event.credentials.token) !== snapshot.scope.accountId) reason = 'unauthorized';
            } catch { reason = 'unauthorized'; }
            if (!reason) {
                try {
                    const material = resolveAccountScopedCryptoMaterialFromCredentials(event.credentials);
                    const admitted = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material });
                    if (admitted.contentPublicKeyFingerprint !== snapshot.cryptoAdmission.contentPublicKeyFingerprint) {
                        reason = 'encryption-material-unavailable';
                    }
                } catch { reason = 'encryption-material-unavailable'; }
            }
        }
        if (reason) applyProviderCatalogSnapshot(snapshot.scope, { status: 'unavailable', reason }, true);
    }
    syncCredentialSubscription();
}

function syncCredentialSubscription(): void {
    // Private display data can outlive its last mounted observer. Its admission ends
    // synchronously with the incumbent credential write, not a later render or GET.
    const retainsPrivateData = modelProjections.size > 0 || [...snapshots.values()].some(snapshot => snapshot.data && snapshot.cryptoAdmission);
    if (retainsPrivateData && !unsubscribeCredentials) unsubscribeCredentials = subscribeHomeCredentialChange(onCredentialChange);
    if (!retainsPrivateData && unsubscribeCredentials) {
        unsubscribeCredentials();
        unsubscribeCredentials = null;
    }
}
export function subscribeProviderCatalogSnapshots(listener: () => void): () => void {
    listeners.add(listener); return () => { listeners.delete(listener); };
}
export function getProviderCatalogSnapshot(scope: ServerAccountScope | null | undefined): ProviderCatalogSnapshot | null {
    return scope ? snapshots.get(serverAccountScopeKeySuffix(scope)) ?? null : null;
}
export function readProviderCatalogConnection(scope: ServerAccountScope | null | undefined,
    connectionId: string): ReturnType<ProviderCatalogReferences['connection']> {
    return scope ? references.connection(serverAccountScopeKeySuffix(scope), connectionId) : null;
}
export function readProviderCatalogModel(scope: ServerAccountScope | null | undefined,
    connectionId: string, modelId: string): ReturnType<ProviderCatalogReferences['model']> {
    return scope ? references.model(serverAccountScopeKeySuffix(scope), connectionId, modelId) : null;
}
function modelProjectionKey(scope: ServerAccountScope, credentialKey: string, queryKey: string): string {
    return JSON.stringify([serverAccountScopeKeySuffix(scope), credentialKey, queryKey]);
}
export function getProviderModelProjectionSnapshot(scope: ServerAccountScope, credentialKey: string, queryKey: string): ModelProjection | null {
    const data = modelProjections.get(modelProjectionKey(scope, credentialKey, queryKey))?.data;
    return data?.kind === 'projection' ? data.value : null;
}
export function getProviderConnectionModelsSnapshot(scope: ServerAccountScope, credentialKey: string, queryKey: string): ConnectionModels | null {
    const data = modelProjections.get(modelProjectionKey(scope, credentialKey, queryKey))?.data;
    return data?.kind === 'connection-list' ? data.value : null;
}
export function providerConnectionCheckQueryKey(machineId: string, connectionId?: string): string {
    return JSON.stringify(['connection-check', machineId, connectionId ?? null]);
}
export function getProviderConnectionCheckSnapshot(scope: ServerAccountScope, credentialKey: string, queryKey: string): ConnectionCheck | null {
    const data = modelProjections.get(modelProjectionKey(scope, credentialKey, queryKey))?.data;
    return data?.kind === 'connection-check' ? data.value : null;
}
export function isProviderConnectionCheckReadRequired(scope: ServerAccountScope, credentialKey: string, queryKey: string): boolean {
    const data = modelProjections.get(modelProjectionKey(scope, credentialKey, queryKey))?.data;
    return data?.kind === 'connection-check' && data.readRequired === true;
}
function ensureModelProjectionSnapshot(scope: ServerAccountScope, key: string): ModelProjectionSnapshot {
    let snapshot = modelProjections.get(key);
    if (!snapshot) {
        snapshot = { scope, data: null, requested: 0, accepted: 0, listeners: new Set() };
        modelProjections.set(key, snapshot);
        syncCredentialSubscription();
    }
    return snapshot;
}
function withdrawModelProjection(key: string, snapshot: ModelProjectionSnapshot): void {
    const changed = snapshot.data !== null;
    snapshot.data = null;
    snapshot.accepted = ++snapshot.requested;
    if (snapshot.listeners.size === 0) modelProjections.delete(key);
    if (changed) for (const listener of [...snapshot.listeners]) listener();
}
export function subscribeProviderModelProjectionSnapshot(scope: ServerAccountScope, credentialKey: string, queryKey: string, listener: () => void): () => void {
    const key = modelProjectionKey(scope, credentialKey, queryKey);
    const snapshot = ensureModelProjectionSnapshot(scope, key);
    snapshot.listeners.add(listener);
    return () => {
        snapshot.listeners.delete(listener);
        if (snapshot.listeners.size === 0 && snapshot.data === null && snapshot.accepted >= snapshot.requested
            && modelProjections.get(key) === snapshot) {
            modelProjections.delete(key);
            syncCredentialSubscription();
        }
    };
}
/** A mounted reader superseded this query; other observers still own its display. */
export function releaseProviderModelProjectionSnapshot(scope: ServerAccountScope, credentialKey: string, queryKey: string): void {
    const key = modelProjectionKey(scope, credentialKey, queryKey);
    const snapshot = modelProjections.get(key);
    if (!snapshot || snapshot.listeners.size > 0) return;
    modelProjections.delete(key);
    syncCredentialSubscription();
}
/** Each caller revalidates through its own Action; only admitted successes enter the shared display snapshot. */
export function beginProviderModelProjectionRead(scope: ServerAccountScope, credentialKey: string, queryKey: string): (data: ModelProjection) => void {
    const publish = beginModelDisplayRead(scope, credentialKey, queryKey);
    return value => publish({ kind: 'projection', value });
}
export function beginProviderConnectionModelsRead(scope: ServerAccountScope, credentialKey: string, queryKey: string): (data: ConnectionModels) => void {
    const publish = beginModelDisplayRead(scope, credentialKey, queryKey);
    return value => publish({ kind: 'connection-list', value });
}
export function beginProviderConnectionCheckRead(scope: ServerAccountScope, credentialKey: string, queryKey: string): (data: ConnectionCheck) => void {
    const target = modelProjections.get(modelProjectionKey(scope, credentialKey, queryKey));
    if (target?.data?.kind === 'connection-check' && target.data.readRequired) {
        const { readRequired: _readRequired, ...data } = target.data;
        target.data = data;
    }
    const publish = beginModelDisplayRead(scope, credentialKey, queryKey);
    const accountCatalog = getProviderCatalogSnapshot(scope)?.data ?? null;
    // Keys are produced by providerConnectionCheckQueryKey in this module.
    const [, machineId] = JSON.parse(queryKey) as readonly [string, string, string | null];
    return value => {
        const catalog = getProviderCatalogSnapshot(scope)?.data ?? null;
        value = reconcileConnectionCheck(value, accountCatalog, catalog);
        const observations = new Map(value.connections.map(row => [row.connectionId, row]));
        const peerKeys = new Set([providerConnectionCheckQueryKey(machineId),
            ...[...observations.keys()].map(connectionId => providerConnectionCheckQueryKey(machineId, connectionId))]);
        const peers = [...peerKeys].map(peerKey => modelProjections.get(modelProjectionKey(scope, credentialKey, peerKey)))
            .filter((peer): peer is ModelProjectionSnapshot => peer?.data?.kind === 'connection-check');
        // A delayed collection read cannot replace a newer detail observation.
        for (const peer of peers) {
            if (peer.data?.kind !== 'connection-check') continue;
            for (const row of peer.data.value.connections) {
                const connectionId = row.connectionId;
                const previous = observations.get(connectionId);
                if (previous && (row.runtime.checkedAt ?? -Infinity) >= (previous.runtime.checkedAt ?? -Infinity)
                    && !sameStrictJsonValue(previous, row)) observations.set(connectionId, row);
            }
        }
        value = mergeConnectionChecks(value, observations);
        if (!publish({ kind: 'connection-check', value, accountCatalog: catalog })) return;
        for (const peer of peers) {
            if (peer === target || peer.data?.kind !== 'connection-check') continue;
            const merged = mergeConnectionChecks(peer.data.value, observations);
            if (merged === peer.data.value) continue;
            peer.data = { ...peer.data, value: merged };
            for (const listener of [...peer.listeners]) listener();
        }
    };
}

function mergeConnectionChecks(current: ConnectionCheck,
    observations: ReadonlyMap<ProviderConnectionId, ConnectionCheck['connections'][number]>): ConnectionCheck {
    let changed = false;
    const connections = current.connections.map(row => {
        const next = observations.get(row.connectionId);
        if (!next || sameStrictJsonValue(row, next)) return row;
        changed = true;
        return next;
    });
    return changed ? { ...current, connections } : current;
}

function connectionCheckAccountFacts(catalog: ProviderConnectionsCatalogV1, connectionId: ProviderConnectionId) {
    const connection = catalog.connections.find(row => row.id === connectionId);
    if (!connection) return null;
    // Display edits advance the saved row without changing an endpoint check.
    const { displayName: _name, displayNameMode: _mode, revision: _revision, updatedAt: _updatedAt, ...source } = connection;
    return { source, accountGrants: catalog.accountGrants.filter(row => row.connectionId === connectionId),
        machineGrants: catalog.machineGrants.filter(row => row.connectionId === connectionId),
        bindings: catalog.secretBindingsByConnectionId[connectionId] ?? null };
}

/** Account observations can retire a check, but cannot manufacture an unchecked Machine observation. */
function reconcileConnectionCheck(value: ConnectionCheck, previous: ProviderConnectionsCatalogV1 | null,
    next: ProviderConnectionsCatalogV1 | null): ConnectionCheck {
    if (!previous || !next || previous === next) return value;
    const connections = value.connections.filter(row => sameStrictJsonValue(
        connectionCheckAccountFacts(previous, row.connectionId), connectionCheckAccountFacts(next, row.connectionId),
    ));
    return connections.length === value.connections.length ? value : { ...value, connections };
}

function reconcileConnectionChecks(scope: ServerAccountScope, catalog: ProviderConnectionsCatalogV1 | null): void {
    const currentIds = new Set(catalog?.connections.map(row => row.id));
    for (const projection of modelProjections.values()) {
        if (projection.data?.kind !== 'connection-check'
            || serverAccountScopeKeySuffix(projection.scope) !== serverAccountScopeKeySuffix(scope)) continue;
        const previous = projection.data.value;
        const value = reconcileConnectionCheck(previous, projection.data.accountCatalog, catalog);
        const retainedIds = new Set(value.connections.map(row => row.connectionId));
        // Deletions need no Machine work. Changed sources/grants/bindings retire
        // their check and ask currently mounted consumers for one new observation.
        const readRequired = previous.connections.some(row => currentIds.has(row.connectionId) && !retainedIds.has(row.connectionId));
        projection.data = { ...projection.data, value, accountCatalog: catalog, ...(readRequired ? { readRequired: true } : {}) };
        if (value !== previous) {
            // The retired source also retires reads admitted against it. Reuse
            // the query's existing admission ordering, as credential withdrawal does.
            projection.accepted = ++projection.requested;
            for (const listener of [...projection.listeners]) listener();
        }
    }
}
function beginModelDisplayRead(scope: ServerAccountScope, credentialKey: string, queryKey: string): (data: ModelDisplay) => boolean {
    const key = modelProjectionKey(scope, credentialKey, queryKey);
    const target = ensureModelProjectionSnapshot(scope, key);
    const request = ++target.requested;
    return data => {
        // A later successful revalidation wins over an older delayed reply.
        // Cancellation/failure of a newer borrower does not discard a still-valid answer.
        if (modelProjections.get(key) !== target || request < target.accepted) return false;
        target.accepted = request;
        if (target.data && sameStrictJsonValue(target.data, data)) return true;
        target.data = data;
        for (const listener of [...target.listeners]) listener();
        return true;
    };
}
export function applyAcknowledgedProviderCatalog(scope: ServerAccountScope, data: ProviderConnectionsCatalogV1, revision: number,
    current: boolean, cryptoAdmission: ProviderCatalogCryptoAdmission | null): void {
    const previous = getProviderCatalogSnapshot(scope);
    if (!canPublishCatalogReceipt({ current, revision, retainedRevision: previous?.revision })) return;
    data = reconcileProviderCatalog(previous?.data, data)!;
    const next: ProviderCatalogSnapshot = { scope, status: 'loading', catalog: { status: 'loading' },
        data, revision, acknowledgedRevision: revision, stale: true, cryptoAdmission };
    if (previous && sameStrictJsonValue(previous, next)) return;
    if (data !== previous?.data) references.apply(serverAccountScopeKeySuffix(scope), data);
    snapshots.set(serverAccountScopeKeySuffix(scope), next);
    reconcileConnectionChecks(scope, data);
    syncCredentialSubscription();
    for (const listener of [...listeners]) listener();
}
export function applyProviderCatalogSnapshot(scope: ServerAccountScope, catalog: ProviderConnectionsCatalogSnapshotV1, current: boolean,
    cryptoAdmission: ProviderCatalogCryptoAdmission | null = null): void {
    if (!current || (catalog.status === 'unavailable' && catalog.reason === 'scope-retired')) return;
    const key = serverAccountScopeKeySuffix(scope);
    const old = snapshots.get(key);
    const withdraw = catalog.status === 'unavailable' && ['account-mode-mismatch', 'encryption-material-unavailable',
        'unauthorized', 'forbidden', 'unsupported', 'account-not-found', 'account-inconsistent', 'invalid-stored-content'].includes(catalog.reason);
    if (withdraw) {
        for (const [modelKey, projection] of modelProjections) {
            if (serverAccountScopeKeySuffix(projection.scope) === key) withdrawModelProjection(modelKey, projection);
        }
        syncCredentialSubscription();
    }
    const candidate = catalog.status === 'ready' || catalog.status === 'partial' ? catalog.catalog : withdraw ? null : old?.data ?? null;
    const data = reconcileProviderCatalog(old?.data, candidate);
    const admitted = catalog.status === 'ready' || catalog.status === 'partial' ? { ...catalog, catalog: data! } : catalog;
    const next: ProviderCatalogSnapshot = { scope: old?.scope ?? scope, catalog: admitted, status: catalog.status, data,
        revision: retainCatalogRevision(catalog, old?.revision),
        ...(data && old?.acknowledgedRevision !== undefined ? { acknowledgedRevision: old.acknowledgedRevision } : {}),
        stale: catalog.status !== 'ready',
        cryptoAdmission: !data ? null : catalog.status === 'ready' || catalog.status === 'partial'
            ? cryptoAdmission : old?.cryptoAdmission ?? null };
    if (old && sameStrictJsonValue(old, next)) return;
    if (data !== old?.data) references.apply(key, data);
    snapshots.set(key, next);
    reconcileConnectionChecks(scope, data);
    syncCredentialSubscription();
    for (const listener of [...listeners]) listener();
}
/** Refresh is transport work; only explicit invalidation withdraws retained admission. */
export function beginProviderCatalogLoad(scope: ServerAccountScope, invalidate = false): void {
    if (!invalidate && getProviderCatalogSnapshot(scope)) return;
    applyProviderCatalogSnapshot(scope, { status: 'loading' }, true);
}
export function resetProviderCatalogSnapshotsForTests(): void {
    snapshots.clear(); references.clear(); modelProjections.clear(); listeners.clear(); syncCredentialSubscription();
}
