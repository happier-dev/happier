import { isConnectedServiceCredentialHealthStatusUsable, type ConnectedServiceCredentialHealthStatusV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { sameQualifiedConnectedAccountRef, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { ConnectSheetAccountRequest, ConnectSheetRequest, ConnectSheetKeyRequest, ConnectSheetNpmRegistryRequest } from './ConnectedServiceSetupModal';
import type { ConnectedServiceSetupTarget } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';

type SavedKey = Readonly<{ ref: string; kind?: 'apiKey' | 'token' | 'password' | 'other' | null }>;

export type ConnectSheetOpening<Key extends SavedKey = SavedKey> = Readonly<{
    initialMode: 'new' | 'saved';
    /** Whether the sheet offers existing accounts or keys at all: only when the caller links one (owner 04). */
    offerSaved: boolean;
    preselected: QualifiedConnectedAccountRef | string | null;
    savedKeys?: readonly Key[];
}>;
export type ConnectSheetInventory<Key extends SavedKey = SavedKey> = Readonly<{
    accounts?: readonly Readonly<{ ref: QualifiedConnectedAccountRef; status?: ConnectedServiceCredentialHealthStatusV1 }>[];
    sameTargetRefs?: readonly string[];
    keys?: readonly Key[];
    services?: readonly PluginContributionIdentityV1[];
}>;

/** One opening decision; unrelated inventory remains available to the body's Saved tab. */
export function isConnectSheetKeyRequest(request: ConnectSheetRequest): request is ConnectSheetKeyRequest {
    return request.service !== undefined && 'kind' in request.service && request.service.kind === 'key';
}

export function isConnectSheetNpmRegistryRequest(request: ConnectSheetRequest): request is ConnectSheetNpmRegistryRequest {
    return request.service !== undefined && 'kind' in request.service && request.service.kind === 'npm-registry-profile';
}

/**
 * How the sheet's body scrolls, fixed for its life: the key sheet keeps its mode switch in place and scrolls its own
 * list; an account or registry sheet scrolls its body under the band. Native cards pick their body (still View or
 * ScrollView) once, at presentation, so the presenter and the heading both read it here.
 */
export function resolveConnectSheetBodyScroll(request: ConnectSheetRequest): 'auto' | 'none' {
    return isConnectSheetKeyRequest(request) ? 'none' : 'auto';
}

export function resolveConnectSheetOpening<Key extends SavedKey>(request: ConnectSheetAccountRequest | ConnectSheetKeyRequest, inventory: ConnectSheetInventory<Key>): ConnectSheetOpening<Key> {
    if (isConnectSheetKeyRequest(request)) {
        const sameTargetRefs = new Set(inventory.sameTargetRefs ?? []);
        const rank = (key: Key) => key.ref === request.current ? 0 : sameTargetRefs.has(key.ref) ? 1 : 2;
        // A demonstrated link is stronger evidence of purpose than optional kind metadata.
        // Adding makes a new key; only a caller linking one to something chooses among the saved ones.
        const savedKeys = request.intent === 'add' ? [] : (inventory.keys ?? []).filter(key => !request.service.keyKind
            || key.kind === request.service.keyKind || rank(key) < 2).sort((a, b) => rank(a) - rank(b));
        const matching = savedKeys.find(key => rank(key) < 2);
        return { initialMode: savedKeys.length > 0 ? 'saved' : 'new', preselected: matching?.ref ?? null,
            offerSaved: savedKeys.length > 0, savedKeys };
    }
    const services = request.service ? [request.service] : inventory.services;
    const accounts = (inventory.accounts ?? []).filter(account => services?.some(service =>
        service.pluginId === account.ref.service.pluginId && service.localId === account.ref.service.localId));
    // Adding offers only the new-account form; linking and reconnecting offer the accounts that exist.
    if (request.intent === 'add') return { initialMode: 'new', preselected: null, offerSaved: false };
    const usable = accounts.filter(account => isConnectedServiceCredentialHealthStatusUsable(account.status));
    const matching = usable.find(account => request.account && sameQualifiedConnectedAccountRef(account.ref, request.account)) ?? usable[0];
    const offerSaved = accounts.length > 0;
    return matching ? { initialMode: 'saved', preselected: matching.ref, offerSaved } : { initialMode: 'new', preselected: null, offerSaved };
}

/**
 * Where an account sheet opens: a catalog holding one service that can add an account here is that service's own
 * form, never a list of one to press through (owner 2026-11-11). Several ways keep the catalog; a chosen target stays.
 */
export function resolveConnectSheetTarget(target: ConnectedServiceSetupTarget,
    catalog: readonly Readonly<{ serviceKey: string; canAdd: boolean }>[]): ConnectedServiceSetupTarget {
    if (target.kind !== 'catalog' || catalog.length !== 1 || !catalog[0]!.canAdd) return target;
    return { kind: 'service', serviceKey: catalog[0]!.serviceKey };
}
