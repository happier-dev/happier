import { listAccountSettingsSavedSecretReferences, type AccountSettingsSavedSecretReference,
    type SavedSecretReferenceCatalogsV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { projectConnectedAccountCredentialReferenceSources } from '@/sync/domains/connectedServices/connectedAccountCredentialReferenceSources';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getProfileCatalogSnapshot, subscribeProfileCatalogSnapshots } from './profileCatalogSnapshot';
import { getProviderCatalogSnapshot, subscribeProviderCatalogSnapshots } from './providerCatalogSnapshot';
import { getMcpServerCatalogSnapshot, subscribeMcpServerCatalogSnapshots } from './mcpServerCatalogSnapshot';
import { getAcpCatalogSnapshot, subscribeAcpCatalogSnapshots } from './acpCatalogSnapshot';
import { getConnectedAccountCatalogValue, subscribeConnectedAccountCatalogSnapshots } from './connectedAccountCatalogSnapshot';
import { getNotificationChannelCatalogValue, subscribeNotificationChannelCatalogSnapshots } from './notificationChannelCatalogSnapshot';
import { getPromptLibraryCatalogValue, subscribePromptLibraryCatalogSnapshots } from './promptLibraryCatalogSnapshot';
import { getRemoteHostCatalogSnapshot, subscribeRemoteHostCatalogSnapshots } from './remoteHostCatalogSnapshot';
import { getConnectedMetadataCatalog, subscribeConnectedMetadataCatalog } from './connectedMetadataCatalogSnapshot';
import { observeProfileCatalog } from '@/sync/engine/settings/profileCatalogEngine';
import { observeProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import { observeMcpServerCatalog } from '@/sync/engine/settings/mcpServerCatalogEngine';
import { observeAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { observeConnectedAccountCatalog } from '@/sync/engine/settings/connectedAccountCatalogEngine';
import { observeNotificationChannelCatalog } from '@/sync/engine/settings/notificationChannelCatalogEngine';
import { observePromptLibraryCatalog } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { observeRemoteHostCatalog } from '@/sync/engine/settings/remoteHostCatalogEngine';
import { observeConnectedMetadataCatalog } from '@/sync/engine/settings/connectedMetadataCatalogEngine';

/**
 * While a surface shows the census, each catalog's own loader keeps its input present: a cold Account
 * otherwise never completes coverage, because nothing else has opened those catalogs yet.
 */
export function observeSavedSecretUsedBySources(scope: ServerAccountScope): () => void {
    const releases = [observeProfileCatalog(scope), observeProviderCatalog(scope), observeMcpServerCatalog(scope), observeAcpCatalog(scope),
        observeConnectedAccountCatalog(scope, 'configurations'), observeConnectedAccountCatalog(scope, 'purposes'),
        observeNotificationChannelCatalog(scope), observePromptLibraryCatalog(scope), observeRemoteHostCatalog(scope), observeConnectedMetadataCatalog(scope)];
    return () => { for (const release of releases) release(); };
}

/** Retained census inputs only. This read never observes/loads a catalog. */
export function readSavedSecretUsedBySources(scope: ServerAccountScope | null) {
    const state = getStorage().getState();
    return {
        settingsScope: state.settingsScope, settings: state.settings,
        profileAccountId: state.profile.id, connectedAccounts: state.profile.connectedAccountsV4,
        connectedAccountLabels: getConnectedMetadataCatalog(scope).labelsByKey,
        profiles: getProfileCatalogSnapshot(scope), providers: getProviderCatalogSnapshot(scope),
        mcp: getMcpServerCatalogSnapshot(scope), acp: getAcpCatalogSnapshot(scope),
        configurations: getConnectedAccountCatalogValue(scope, 'configurations'),
        purposes: getConnectedAccountCatalogValue(scope, 'purposes'),
        notifications: getNotificationChannelCatalogValue(scope),
        registry: getPromptLibraryCatalogValue(scope, 'registry-sources'),
        remoteHosts: getRemoteHostCatalogSnapshot(scope),
    };
}

/** Metadata coverage belongs to each retained catalog; missing coverage never proves unused. */
export function projectSavedSecretUsedBy(scope: ServerAccountScope | null, ref: string | null,
    source: ReturnType<typeof readSavedSecretUsedBySources>,
): readonly AccountSettingsSavedSecretReference[] | null {
    if (!scope || !ref || !areServerAccountScopesEqual(scope, source.settingsScope)
        || source.profileAccountId !== scope.accountId) return null;
    const { profiles, providers, mcp, acp, configurations, purposes, notifications, registry, remoteHosts } = source;
    if (!profiles?.dataComplete || profiles.catalog.status !== 'ready'
        || providers?.catalog.status !== 'ready' || mcp.status !== 'ready' || acp?.catalog.status !== 'ready'
        || configurations.status !== 'ready' || purposes.status !== 'ready' || notifications.status !== 'ready'
        || registry.status !== 'ready' || remoteHosts?.catalog.status !== 'ready') return null;
    const catalogs: SavedSecretReferenceCatalogsV1 = {
        profileRecords: profiles.catalog.records.map(row => row.record),
        profileControl: profiles.catalog.control?.record ?? null, artifactsById: profiles.artifactsById,
        providerConnections: providers.data, mcp: mcp.value, acp: acp.data,
        connectedConfigurations: configurations.value, connectedPurposes: purposes.value,
        notificationChannels: { v: 1, channels: [...notifications.channels] },
        registrySources: registry.value, remoteHostRecords: remoteHosts.data,
        connectedAccountCredentials: projectConnectedAccountCredentialReferenceSources(source.connectedAccounts, source.connectedAccountLabels),
    };
    try { return listAccountSettingsSavedSecretReferences(source.settings, ref, catalogs); }
    catch { return null; } // The census rejects incomplete/invalid carriers; display stays unknown.
}

export function readSavedSecretUsedBy(scope: ServerAccountScope, ref: string): readonly AccountSettingsSavedSecretReference[] | null {
    return projectSavedSecretUsedBy(scope, ref, readSavedSecretUsedBySources(scope));
}

export function subscribeSavedSecretUsedBySources(listener: () => void): () => void {
    const subscriptions = [getStorage().subscribe(listener), subscribeProfileCatalogSnapshots(listener),
        subscribeProviderCatalogSnapshots(listener), subscribeMcpServerCatalogSnapshots(listener), subscribeAcpCatalogSnapshots(listener),
        subscribeConnectedAccountCatalogSnapshots(listener), subscribeNotificationChannelCatalogSnapshots(listener),
        subscribePromptLibraryCatalogSnapshots(listener), subscribeRemoteHostCatalogSnapshots(listener), subscribeConnectedMetadataCatalog(listener)];
    return () => { for (const unsubscribe of subscriptions) unsubscribe(); };
}
