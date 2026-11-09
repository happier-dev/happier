import * as React from 'react';
import { t } from '@/text';
import { getCachedServerFeaturesSnapshot, subscribeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import {
    areServerProfileIdentifiersEquivalent,
    getActiveServerSnapshot,
    readServerProfileHomeName,
    resolveUniqueServerProfileByUrl,
    resolveServerProfileScopeId,
    resolveServerProfileForPortableIdentity,
    subscribeActiveServer,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';

export type HomeDisplayProfile = Pick<ServerProfile,
    'id' | 'name' | 'serverUrl' | 'serverIdentityId' | 'canonicalServerUrl' | 'publicServerUrl' | 'personalHomeBootstrapCompleted'>;

/**
 * How the app names a Home to a person: the name the Home itself publishes (`homePresentation`, set
 * in its Home settings, so every device says the same), else the name this device gave it, else
 * "Personal Home" for this device's Personal Home, else null. It never offers the Home's address as
 * its name; labels for unnamed Homes are resolved by `resolveHomeDisplayLabel`. The published name
 * is read from the Home's last features answer.
 */
export function resolveHomeDisplayName(profile: HomeDisplayProfile | null | undefined): string | null {
    if (!profile) return null;
    const published = getCachedServerFeaturesSnapshot({ serverId: resolveServerProfileScopeId(profile) });
    const publishedName = published?.status === 'ready' ? published.features.homePresentation?.displayName.trim() : '';
    if (publishedName) return publishedName;
    const named = readServerProfileHomeName(profile);
    if (named) return named;
    if (profile.personalHomeBootstrapCompleted === true) return t('personalHome.settings.defaultHomeLabel');
    return null;
}

/**
 * The display name of the Home a portable server identity belongs to (a machine target's Home), or
 * null when this device has no single named profile for it.
 */
export function resolveHomeDisplayNameForServerIdentity(serverIdentityId: string): string | null {
    const resolution = resolveServerProfileForPortableIdentity(serverIdentityId);
    return resolution.kind === 'resolved' ? resolveHomeDisplayName(resolution.profile) : null;
}

/**
 * The visible label of the Home a portable server identity belongs to: its name, "This Home" for the current
 * unnamed Home, or the generic Home word when this device has no single profile for it.
 */
export function resolveHomeDisplayLabelForServerIdentity(serverIdentityId: string): string {
    const resolution = resolveServerProfileForPortableIdentity(serverIdentityId);
    return resolution.kind === 'resolved' ? resolveHomeDisplayLabel(resolution.profile, serverIdentityId) : t('common.homeProductName');
}

/**
 * One visible label for every Home surface: prefer its name, call only the current unnamed Home
 * "This Home", and distinguish unnamed peers by their saved address. Consumers with a current-Home
 * snapshot pass its id; others use the active-Home owner. The nullable name resolver stays separate
 * so naming and rename affordances still know when a Home is unnamed.
 */
export function resolveHomeDisplayLabel(
    profile: HomeDisplayProfile | null | undefined,
    fallbackId: string,
    currentServerId?: string,
): string {
    const name = resolveHomeDisplayName(profile);
    if (name) return name;
    const currentId = currentServerId ?? getActiveServerSnapshot().serverId;
    const homeId = profile ? resolveServerProfileScopeId(profile) : fallbackId;
    if (profile?.id === currentId || areServerProfileIdentifiersEquivalent(homeId, currentId)) {
        return t('settingsAccount.thisHomeTitle');
    }
    return (profile ? toServerUrlDisplay(profile.serverUrl) : '') || t('common.homeProductName');
}

/** `resolveHomeDisplayName` for a mounted surface; null while the Home has no name. */
export function useHomeDisplayName(profile: HomeDisplayProfile | null | undefined): string | null {
    const getName = React.useCallback(() => resolveHomeDisplayName(profile), [profile]);
    return React.useSyncExternalStore(subscribeServerFeaturesSnapshot, getName, getName);
}

/** Mounted Home labels observe only their resolved text, so unrelated feature changes stay local. */
export function useHomeDisplayLabel(profile: HomeDisplayProfile | null | undefined): string {
    const getLabel = React.useCallback(() => resolveHomeDisplayLabel(profile, ''), [profile]);
    return React.useSyncExternalStore(subscribeHomeDisplayLabel, getLabel, getLabel);
}

function subscribeHomeDisplayLabel(listener: () => void): () => void {
    const unsubscribeFeatures = subscribeServerFeaturesSnapshot(listener);
    const unsubscribeActive = subscribeActiveServer(listener);
    return () => {
        unsubscribeFeatures();
        unsubscribeActive();
    };
}

/**
 * The display name of the saved Home at a relay address, or `null` when it has none — including
 * when two saved Homes share the address (the canonical URL resolver never guesses, A13-05).
 */
export function resolveHomeDisplayNameForRelayUrl(relayUrl: string): string | null {
    return resolveHomeDisplayName(resolveUniqueServerProfileByUrl(relayUrl));
}
