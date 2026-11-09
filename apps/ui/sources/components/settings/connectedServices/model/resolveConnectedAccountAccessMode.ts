import type { ConnectedAccountAccessModeV1 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { ProviderAccountSubscriptionV1 } from '@happier-dev/protocol/connect/accountSubscription';
import type { ConnectedAccountAccessMode } from './presentConnectedAccountAccessMode';

/** Producer metadata wins; a provider's observed subscription can fill an unknown mode. */
export function resolveConnectedAccountAccessMode(
    account: Readonly<{ accessMode?: ConnectedAccountAccessModeV1 }> | null | undefined,
    subscription?: Pick<ProviderAccountSubscriptionV1, 'status'> | null,
): ConnectedAccountAccessMode | null {
    const kind = account?.accessMode ?? (subscription?.status === 'subscribed' ? 'subscription' : null);
    if (kind === 'apiKey') return { kind, keySuffix: null };
    return kind === 'subscription' ? { kind } : null;
}

/** An explicit key mode withdraws subscription presentation without discarding its usage. */
export function projectConnectedAccountSubscriptionFacts(
    mode: ConnectedAccountAccessMode | null | undefined,
    facts: Readonly<{ planLabel: string | null; subscription: ProviderAccountSubscriptionV1 | null }>,
): Readonly<{ planLabel: string | null; subscription: ProviderAccountSubscriptionV1 | null }> {
    return mode?.kind === 'apiKey' ? { planLabel: null, subscription: null } : facts;
}
