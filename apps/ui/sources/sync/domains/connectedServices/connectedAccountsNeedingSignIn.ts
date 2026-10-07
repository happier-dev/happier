import { normalizeConnectedServiceCredentialHealthStatus } from '@happier-dev/protocol/connect/connected-service-schemas';

import { deriveAccountHealth } from './deriveAccountHealth';
import type { ConnectedAccountUiNegotiation } from './resolveConnectedAccountUiNegotiation';
import {
    getLegacyConnectedServiceRegistryEntry,
    type ConnectedServiceRegistryEntry,
} from './connectedServiceRegistry';

type ServiceIdentity = Readonly<{ pluginId: string; localId: string }>;

type ProfileAccounts = Readonly<{
    connectedServicesV2: ReadonlyArray<Readonly<{
        serviceId: string;
        profiles: ReadonlyArray<Readonly<{ profileId: string; status?: unknown }>>;
    }>>;
    connectedAccountsV4?: ReadonlyArray<Readonly<{
        ref: Readonly<{ service: ServiceIdentity; accountId: string }>;
        status?: unknown;
    }>>;
}>;

export type ConnectedAccountNeedingSignIn = Readonly<{
    key: string;
    entry: ConnectedServiceRegistryEntry;
    service: ServiceIdentity;
    /** The qualified account to focus; released per-service profiles open their service. */
    accountId: string | null;
}>;

function needsSignIn(status: unknown): boolean {
    return deriveAccountHealth({
        status: normalizeConnectedServiceCredentialHealthStatus(status),
        capacityPct: null,
    }) === 'error';
}

/**
 * The connected accounts whose sign-in has expired, read from the Account profile the app already
 * holds. Health comes from `deriveAccountHealth`, the owner the Connected services page uses, and the
 * account transport from the server's negotiation: while that is unknown nothing is claimed.
 */
export function listConnectedAccountsNeedingSignIn(params: Readonly<{
    profile: ProfileAccounts;
    accountTransport: ConnectedAccountUiNegotiation;
    entries: readonly ConnectedServiceRegistryEntry[];
}>): ConnectedAccountNeedingSignIn[] {
    if (params.accountTransport === 'advertised-v4') {
        return (params.profile.connectedAccountsV4 ?? []).flatMap((account) => {
            if (!needsSignIn(account.status)) return [];
            const { service, accountId } = account.ref;
            const entry = params.entries.find((candidate) => (
                candidate.service?.pluginId === service.pluginId && candidate.service.localId === service.localId
            ));
            return entry ? [{ key: `${service.pluginId}/${service.localId}/${accountId}`, entry, service, accountId }] : [];
        });
    }
    if (params.accountTransport === 'legacy') {
        return params.profile.connectedServicesV2.flatMap((legacyService) => {
            if (!legacyService.profiles.some((profile) => needsSignIn(profile.status))) return [];
            const entry = getLegacyConnectedServiceRegistryEntry(legacyService.serviceId);
            if (!entry.service) return [];
            return [{ key: `legacy/${legacyService.serviceId}`, entry, service: entry.service, accountId: null }];
        });
    }
    return [];
}
