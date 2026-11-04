import { normalizeConnectedServiceCredentialHealthStatus } from '@happier-dev/protocol/connect/connected-service-schemas';

import { deriveAccountHealth } from './deriveAccountHealth';
import type { ConnectedAccountUiNegotiation } from './resolveConnectedAccountUiNegotiation';
import {
    getLegacyConnectedServiceRegistryEntry,
    type ConnectedServiceRegistryEntry,
} from './connectedServiceRegistry';
import { resolveQualifiedConnectedAccountLabel } from './connectedServiceProfilePreferences';
import type { ConnectedAccountIdentityPresenter } from './maskAccountEmail';
import { presentConnectedAccountNames } from './qualifiedConnectedAccountTargetPresentation';
import { t } from '@/text';

type ServiceIdentity = Readonly<{ pluginId: string; localId: string }>;

type ProfileAccounts = Readonly<{
    connectedServicesV2: ReadonlyArray<Readonly<{
        serviceId: string;
        profiles: ReadonlyArray<Readonly<{ profileId: string; status?: unknown }>>;
    }>>;
    connectedAccountsV4?: ReadonlyArray<Readonly<{
        ref: Readonly<{ service: ServiceIdentity; accountId: string }>;
        status?: unknown;
        displayName?: string | null;
        providerIdentity?: Readonly<{ email?: string | null; accountId?: string | null }> | null;
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

export type ConnectedAccountNeedingSignInDescription = Readonly<{
    need: ConnectedAccountNeedingSignIn;
    /** What the row says expired: the service, or a nameless account's own numbered name. */
    service: string;
    /** Which account of that service, by the name people know it by; null when only the service tells it. */
    account: string | null;
}>;

/**
 * What tells these rows apart, through the one connected-account naming rule (its privacy presenter
 * included): the account's name beside its service. Accounts that read the same also say their identity;
 * nameless ones keep their service, numbered when several are listed. Never an internal id.
 */
export function describeConnectedAccountsNeedingSignIn(params: Readonly<{
    accounts: readonly ConnectedAccountNeedingSignIn[];
    profile: ProfileAccounts;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    serviceTitle: (entry: ConnectedServiceRegistryEntry) => string;
    presentIdentity?: ConnectedAccountIdentityPresenter;
}>): readonly ConnectedAccountNeedingSignInDescription[] {
    const named = params.accounts.map((need) => {
        const serviceTitle = params.serviceTitle(need.entry);
        if (need.accountId === null) return { need, serviceTitle, name: null };
        const names = presentConnectedAccountNames((params.profile.connectedAccountsV4 ?? [])
            .filter(({ ref }) => ref.service.pluginId === need.service.pluginId && ref.service.localId === need.service.localId)
            .map((account) => ({
                key: account.ref.accountId,
                serviceTitle,
                userLabel: resolveQualifiedConnectedAccountLabel({ labelsByKey: params.labelsByKey, service: account.ref.service, accountId: account.ref.accountId }),
                displayName: account.displayName ?? null,
                email: account.providerIdentity?.email ?? null,
                providerAccountId: account.providerIdentity?.accountId ?? null,
                accountId: account.ref.accountId,
                presentIdentity: params.presentIdentity,
            })));
        return { need, serviceTitle, name: names.get(need.accountId) ?? null };
    });
    const nameKey = (service: string, label: string) => `${service}\u0000${label}`;
    const counts = new Map<string, number>();
    for (const { serviceTitle, name } of named) {
        if (!name || name.serviceFallback) continue;
        const key = nameKey(serviceTitle, name.primaryLabel);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return named.map(({ need, serviceTitle, name }) => {
        if (!name) return { need, service: serviceTitle, account: null };
        if (name.serviceFallback) {
            const unnumbered = name.primaryLabel === t('connectedServicesCollection.accountLabel', { service: serviceTitle });
            return { need, service: unnumbered ? serviceTitle : name.primaryLabel, account: null };
        }
        const repeated = (counts.get(nameKey(serviceTitle, name.primaryLabel)) ?? 0) > 1;
        return { need, service: serviceTitle,
            account: repeated && name.identityLabel ? `${name.primaryLabel} · ${name.identityLabel}` : name.primaryLabel };
    });
}
