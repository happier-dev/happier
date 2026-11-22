import {
    presentConnectedAccountNames,
    type ConnectedAccountNamePresentation,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import type { ConnectedServiceQuotaAccountPresentation } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import type { ConnectedAccountIdentityPresenter } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';

export type UsagePopoverRefresh = Readonly<{
    keys: readonly string[];
    loadingByKey?: Readonly<Record<string, boolean>>;
    refreshingByKey: Readonly<Record<string, boolean>>;
    errorsByKey: Readonly<Record<string, string | null>>;
    accountIdentities?: readonly ConnectedServiceQuotaAccountPresentation[];
    run(keys?: readonly string[]): Promise<void>;
}>;

function presentFailedReads(
    refresh: UsagePopoverRefresh,
    names: ReadonlyMap<string, ConnectedAccountNamePresentation>,
    presentIdentity: ConnectedAccountIdentityPresenter,
    identitiesHidden: boolean,
): string | null {
    const failedKeys = Object.keys(refresh.errorsByKey).filter(key => refresh.errorsByKey[key] != null);
    const count = failedKeys.length;
    if (count === 0) return null;
    if (identitiesHidden || count > 2) return t('sidebarFooter.usageRefreshFailedAccounts', { count });

    // A usage record may fail even when its account has no limits row to supply a name.
    const catalogNames = failedKeys.some(key => !names.has(key))
        ? presentConnectedAccountNames((refresh.accountIdentities ?? []).map(account => ({
            key: account.key, serviceTitle: account.serviceLabel, userLabel: account.profileLabel, providerDisplayName: account.accountLabel,
            email: account.accountEmail, accountId: account.accountId, presentIdentity,
        })))
        : null;
    const labels = failedKeys.flatMap(key => {
        const name = catalogNames?.get(key) ?? names.get(key);
        return name ? [name.inlineLabel ?? name.primaryLabel] : [];
    });
    return t('sidebarFooter.usageRefreshFailedAccounts', {
        count,
        ...(labels.length === count ? { accounts: joinList(labels) } : {}),
    });
}

/** The rail and widened Session report how much of the read failed. A scoped Session has one account. */
export function summarizeUsagePopoverRefresh(input: Readonly<{
    refresh?: UsagePopoverRefresh;
    /** Undefined widens to all accounts. Null is a Session without a connected account. */
    accountKey?: string | null;
    names: ReadonlyMap<string, ConnectedAccountNamePresentation>;
    presentIdentity: ConnectedAccountIdentityPresenter;
    identitiesHidden: boolean;
}>): Readonly<{ keys: readonly string[]; refreshing: boolean; error: string | null }> {
    const { refresh, accountKey } = input;
    if (!refresh) return { keys: [], refreshing: false, error: null };
    const keys = accountKey === undefined ? refresh.keys : refresh.keys.filter(key => key === accountKey);
    return {
        keys,
        refreshing: keys.some(key => refresh.refreshingByKey[key] === true || refresh.loadingByKey?.[key] === true),
        error: accountKey === undefined
            ? presentFailedReads(refresh, input.names, input.presentIdentity, input.identitiesHidden)
            : accountKey === null ? null : refresh.errorsByKey[accountKey] ?? null,
    };
}
