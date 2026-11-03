import { isConnectedServiceCredentialHealthStatusUsable, type ConnectedServiceCredentialHealthStatusV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { sameQualifiedConnectedAccountRef, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { ConnectSheetAccountRequest } from './ConnectedServiceSetupModal';

type SavedKey = Readonly<{ ref: string; kind?: 'apiKey' | 'token' | 'password' | 'other' | null }>;

export type ConnectSheetOpening<Key extends SavedKey = SavedKey> = Readonly<{
    initialMode: 'new' | 'saved';
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
export function resolveConnectSheetOpening<Key extends SavedKey>(request: ConnectSheetAccountRequest, inventory: ConnectSheetInventory<Key>): ConnectSheetOpening<Key> {
    const services = request.service ? [request.service] : inventory.services;
    const accounts = (inventory.accounts ?? []).filter(account => services?.some(service =>
        service.pluginId === account.ref.service.pluginId && service.localId === account.ref.service.localId));
    const usable = accounts.filter(account => isConnectedServiceCredentialHealthStatusUsable(account.status));
    const matching = request.intent === 'add' ? undefined
        : usable.find(account => request.account && sameQualifiedConnectedAccountRef(account.ref, request.account)) ?? usable[0];
    return matching ? { initialMode: 'saved', preselected: matching.ref } : { initialMode: 'new', preselected: null };
}
