import type { ProviderConnectionsCatalogSnapshotV1, ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialChange, type HomeCredentialMutationEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { parseToken } from '@/utils/auth/parseToken';

/** Public key evidence from a read admitted under persisted E2EE mode; never retained key bytes. */
export type ProviderCatalogCryptoAdmission = Readonly<{ contentPublicKeyFingerprint: string }>;

export type ProviderCatalogSnapshot = Readonly<{
    scope: ServerAccountScope; status: ProviderConnectionsCatalogSnapshotV1['status'];
    catalog: ProviderConnectionsCatalogSnapshotV1; data: ProviderConnectionsCatalogV1 | null;
    revision: number | 'absent'; stale: boolean;
    cryptoAdmission: ProviderCatalogCryptoAdmission | null;
}>;
const snapshots = new Map<string, ProviderCatalogSnapshot>();
const listeners = new Set<() => void>();
let unsubscribeCredentials: (() => void) | null = null;

function onCredentialChange(event: HomeCredentialMutationEvent): void {
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
}

function syncCredentialSubscription(): void {
    // Private display data can outlive its last mounted observer. Its admission ends
    // synchronously with the incumbent credential write, not a later render or GET.
    const retainsPrivateData = [...snapshots.values()].some(snapshot => snapshot.data && snapshot.cryptoAdmission);
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
export function applyProviderCatalogSnapshot(scope: ServerAccountScope, catalog: ProviderConnectionsCatalogSnapshotV1, current: boolean,
    cryptoAdmission: ProviderCatalogCryptoAdmission | null = null): void {
    if (!current || (catalog.status === 'unavailable' && catalog.reason === 'scope-retired')) return;
    const key = serverAccountScopeKeySuffix(scope);
    const old = snapshots.get(key);
    const withdraw = catalog.status === 'unavailable' && ['account-mode-mismatch', 'encryption-material-unavailable',
        'unauthorized', 'forbidden', 'unsupported', 'account-not-found', 'account-inconsistent', 'invalid-stored-content'].includes(catalog.reason);
    const candidate = catalog.status === 'ready' || catalog.status === 'partial' ? catalog.catalog : withdraw ? null : old?.data ?? null;
    const data = old?.data && JSON.stringify(old.data) === JSON.stringify(candidate) ? old.data : candidate;
    const next: ProviderCatalogSnapshot = { scope: old?.scope ?? scope, catalog, status: catalog.status, data,
        revision: catalog.status === 'ready' || catalog.status === 'partial' ? catalog.revision : old?.revision ?? 'absent',
        stale: catalog.status !== 'ready',
        cryptoAdmission: !data ? null : catalog.status === 'ready' || catalog.status === 'partial'
            ? cryptoAdmission : old?.cryptoAdmission ?? null };
    if (old && JSON.stringify(old) === JSON.stringify(next)) return;
    snapshots.set(key, next);
    syncCredentialSubscription();
    for (const listener of [...listeners]) listener();
}
export function beginProviderCatalogLoad(scope: ServerAccountScope): void {
    applyProviderCatalogSnapshot(scope, { status: 'loading' }, true);
}
export function invalidateProviderCatalogsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) if (snapshot.scope.serverId === serverId) beginProviderCatalogLoad(snapshot.scope);
}
export function resetProviderCatalogSnapshotsForTests(): void {
    snapshots.clear(); listeners.clear(); syncCredentialSubscription();
}
