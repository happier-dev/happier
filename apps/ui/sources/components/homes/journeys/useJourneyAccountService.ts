import * as React from 'react';

import type { AccountDirectoryAuthMethodDiscovery } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { useAccountServiceDisplayName } from '@/components/account/auth/accountServiceDisplayName';
import {
    useAccountServiceEntryOptions,
    type AccountServiceEntryOptions,
} from '@/components/account/auth/useAccountServiceEntryOptions';
import { isDefaultAccountServiceUrl } from '@/components/settings/account/AccountServiceMark';
import type { AuthenticatedAccountEntryRequest } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import { formatAccountServiceHost } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';
import { t } from '@/text';

import {
    resolveServiceHomeStorage,
    type ServiceHomeStorage,
} from './homesJourneyModel';

export type JourneyAccountService = Readonly<{
    entry: AccountServiceEntryOptions;
    discovery: AccountDirectoryAuthMethodDiscovery | null;
    /** The service's own name, else "your sign-in service". */
    name: string;
    /** Its address as people read it. */
    host: string;
    /** The built-in default service (Happier Cloud on the public build). */
    isDefault: boolean;
    /** Verified Happier API endpoints also host Homes; delegation does not determine this. */
    hostsHome: boolean;
    /** How a Home on this service stores sessions, from the Account modes it can create. */
    storage: ServiceHomeStorage | null;
    /** "Happier account", or "<Service> account" for any other service. */
    accountNoun: string;
}>;

/** The service's account as a noun ("Happier account", "<Service> account"). */
export function resolveJourneyAccountNoun(input: Readonly<{ isDefault: boolean; named: string | null }>): string {
    if (input.isDefault) return t('homesJourneys.happierAccount');
    // The fallback name "your sign-in service" already carries the possessive the sentences add.
    return input.named === null ? t('homesJourneys.signInServiceAccount') : t('homesJourneys.serviceAccount', { service: input.named });
}

/**
 * The sign-in service this device finds its Homes with (its own selection, never a focused Home's
 * policy): "Already use Happier?", Add a Home and "Use <service> as your Home" all read it here, so
 * the name, the methods and whether the service is also a Home cannot disagree between them.
 */
export function useJourneyAccountService(): JourneyAccountService {
    const entry = useAccountServiceEntryOptions();
    const discovery = entry.status === 'ready' ? entry.discovery : null;
    const url = discovery?.endpointUrl ?? entry.endpoint.url;
    const named = useAccountServiceDisplayName({
        url,
        serverIdentityId: discovery?.serverIdentityId ?? entry.endpoint.serverIdentityId,
        savedName: entry.endpoint.displayName,
        advertisedName: discovery?.accountServiceDisplayName,
    });
    return React.useMemo(() => {
        const isDefault = isDefaultAccountServiceUrl(url);
        const name = named ?? t('welcome.yourSignInService');
        const features = discovery?.snapshot?.features;
        return {
            entry,
            discovery,
            name,
            host: formatAccountServiceHost(url),
            isDefault,
            // Every verified Happier API server hosts a Home. Sign-in
            // delegation describes authentication, not the endpoint's role.
            hostsHome: discovery !== null,
            storage: resolveServiceHomeStorage(features?.capabilities.encryption),
            accountNoun: resolveJourneyAccountNoun({ isDefault, named }),
        };
    }, [discovery, entry, named, url]);
}

/**
 * Build the existing post-auth intent from the captured Add a Home focus policy.
 * Ordinary sign-in refreshes without focus; explicitly using the service as a Home
 * targets that exact Home. First-Home discovery otherwise uses automatic selection. Null until discovery.
 */
export function useJourneySignInRequest(
    discovery: AccountDirectoryAuthMethodDiscovery | null,
    shouldFocusNewHome = true,
    purpose: 'find_homes' | 'use_service_as_home' = 'find_homes',
): AuthenticatedAccountEntryRequest | null {
    const endpointUrl = discovery?.endpointUrl ?? null;
    const serverIdentityId = discovery?.serverIdentityId ?? null;
    return React.useMemo<AuthenticatedAccountEntryRequest | null>(() => (endpointUrl && serverIdentityId ? {
        service: { endpointUrl, serverIdentityId },
        intent: shouldFocusNewHome
            ? { kind: 'enter', target: purpose === 'use_service_as_home'
                ? { kind: 'explicit', homeServerIdentityId: serverIdentityId }
                : { kind: 'automatic' } }
            : purpose === 'use_service_as_home'
                ? { kind: 'enroll', homeServerIdentityId: serverIdentityId }
                : { kind: 'refresh' },
        returnTo: '/',
    } : null), [endpointUrl, purpose, serverIdentityId, shouldFocusNewHome]);
}
