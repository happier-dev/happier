import * as React from 'react';
import { isHappierCloudServerUrl } from '@happier-dev/cli-common/happierCloud';

import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { normalizeAccountDirectoryEndpoint } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';
import {
    areServerProfileIdentifiersEquivalent,
    DEFAULT_ACCOUNT_SERVICE_ENDPOINT,
    getServerProfilesGeneration,
    isAddressOnlyName,
    listServerProfiles,
    resolveServerProfileScopeId,
    subscribeServerProfiles,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { t } from '@/text';

export type AccountServiceNameInput = Readonly<{
    url: string;
    serverIdentityId?: string | null;
    /** The name saved with the selection; ignored when it is only an address (`isAddressOnlyName`). */
    savedName?: string | null;
    /** The name the service presents itself (`accountServicePresentation.displayName`). */
    advertisedName?: string | null;
    profiles: readonly ServerProfile[];
    /** The Home in focus, so an unnamed Home that is also the service reads "This Home". */
    activeServerId?: string | null;
}>;

function profileServesUrl(profile: ServerProfile, url: string): boolean {
    const target = normalizeAccountDirectoryEndpoint(url);
    return target !== null && [profile.serverUrl, profile.canonicalServerUrl, profile.publicServerUrl]
        .some((candidate) => candidate && normalizeAccountDirectoryEndpoint(candidate) === target);
}

/**
 * How the app names a sign-in service to a person. The one owner for every surface that names it
 * (the Account section, the service chooser, the account-entry route, the connection control):
 * its presented name, else the name saved with the choice, "Happier Cloud" for the default, else
 * the Home it is (its Home name, or "This Home" for the unnamed Home in focus). It never offers the
 * service's address as its name; callers without a name use a generic phrase.
 */
export function resolveAccountServiceDisplayName(input: AccountServiceNameInput): string | null {
    const advertised = input.advertisedName?.trim();
    if (advertised) return advertised;
    const saved = input.savedName?.trim();
    if (saved && !isAddressOnlyName(saved)) return saved;
    if (isHappierCloudServerUrl(input.url)) return t('setupOnboarding.relayCloudTitle');
    const defaultUrl = normalizeAccountDirectoryEndpoint(DEFAULT_ACCOUNT_SERVICE_ENDPOINT.url);
    if (defaultUrl && normalizeAccountDirectoryEndpoint(input.url) === defaultUrl && DEFAULT_ACCOUNT_SERVICE_ENDPOINT.displayName) {
        return DEFAULT_ACCOUNT_SERVICE_ENDPOINT.displayName;
    }
    const identity = input.serverIdentityId?.trim();
    const home = input.profiles.find((profile) => (
        identity ? profile.serverIdentityId === identity : profileServesUrl(profile, input.url)
    ));
    if (!home) return null;
    const homeName = resolveHomeDisplayName(home);
    if (homeName) return homeName;
    return input.activeServerId && areServerProfileIdentifiersEquivalent(resolveServerProfileScopeId(home), input.activeServerId)
        ? t('settingsAccount.thisHomeTitle')
        : null;
}

/** `resolveAccountServiceDisplayName` for a surface, with this device's Homes and focus. */
export function useAccountServiceDisplayName(
    service: Omit<AccountServiceNameInput, 'profiles' | 'activeServerId'> | null,
): string | null {
    const activeServer = useActiveServerSnapshot();
    const profileGeneration = React.useSyncExternalStore(
        (listener) => subscribeServerProfiles(() => listener()),
        getServerProfilesGeneration,
        getServerProfilesGeneration,
    );
    const profiles = React.useMemo(() => listServerProfiles(), [profileGeneration]);
    if (!service) return null;
    return resolveAccountServiceDisplayName({ ...service, profiles, activeServerId: activeServer.serverId });
}

/** The same answer read once from this device's current Homes, for render helpers without hooks. */
export function readAccountServiceDisplayName(
    service: Omit<AccountServiceNameInput, 'profiles' | 'activeServerId'>,
): string | null {
    return resolveAccountServiceDisplayName({
        ...service,
        profiles: listServerProfiles(),
        activeServerId: getActiveServerSnapshot().serverId,
    });
}
