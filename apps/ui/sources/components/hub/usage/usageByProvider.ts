import type { MeterTone } from '@/components/ui/lists/MeterBar';
import { resolveQuotaTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { resolveConnectedServiceQuotaMeterLabel } from '@happier-dev/protocol/connect/connectedServiceQuotaMeterLabel';

/**
 * The usage summary grouped the way people read limits: per provider (Claude, Codex…), then each
 * connected account with its own state, then each limit window with how much is used and left and
 * when it resets. Pure: it only regroups what `useUsageSummary` already holds and decides nothing.
 */

export type UsageWindowInput = Readonly<{
    meterId: string;
    label: string;
    remainingPct: number | null;
    resetsAt: number | null;
}>;

export type UsageAccountInput = Readonly<{
    key: string;
    /** Groups accounts of one provider (the connected service's identity). */
    serviceGroupKey: string;
    serviceLabel: string;
    /** For the provider's brand mark (catalog-owned); null when it has none. */
    legacyServiceId: string | null;
    /** The account's name (given in Happier, else its display name); null when it has none. */
    accountLabel: string | null;
    /** Raw identity for the one presenter (`useConnectedAccountIdentityPrivacy`); null when unknown. */
    accountEmail: string | null;
    accountId: string | null;
    planLabel: string | null;
    /** This account's reading time, never another account's or a combined timestamp. */
    fetchedAt?: number | null;
    /** `ready`: windows read; `loading`: being read; `unavailable`: the provider reported nothing. */
    state: 'ready' | 'loading' | 'unavailable';
    meters: readonly UsageWindowInput[];
}>;

export type UsageWindowRow = Readonly<{
    meterId: string;
    label: string;
    usedPct: number | null;
    remainingPct: number | null;
    resetsAt: number | null;
    /** How healthy the window is, from what is left (`resolveQuotaTone`, the one threshold owner). */
    tone: MeterTone;
}>;

export type UsageAccountRow = Readonly<{
    key: string;
    label: string | null;
    email: string | null;
    accountId: string | null;
    planLabel: string | null;
    fetchedAt: number | null;
    state: UsageAccountInput['state'];
    windows: readonly UsageWindowRow[];
    /** Every window was read and has comfortable room left. */
    healthy: boolean;
}>;

export type UsageProviderGroup = Readonly<{
    key: string;
    serviceLabel: string;
    legacyServiceId: string | null;
    /** The plan every account of this provider reports, else null (never a guess). */
    planLabel: string | null;
    accounts: readonly UsageAccountRow[];
}>;

function clampPct(value: number): number {
    return Math.max(0, Math.min(100, value));
}

export function groupUsageByProvider(accounts: readonly UsageAccountInput[]): UsageProviderGroup[] {
    const groups = new Map<string, { first: UsageAccountInput; accounts: UsageAccountInput[] }>();
    for (const account of accounts) {
        const group = groups.get(account.serviceGroupKey);
        if (group) group.accounts.push(account);
        else groups.set(account.serviceGroupKey, { first: account, accounts: [account] });
    }
    return Array.from(groups.entries())
        .map(([key, group]): UsageProviderGroup => {
            // Only read accounts say what their plan is; one still loading or unavailable is silent.
            const plans = new Set(group.accounts.filter((account) => account.state === 'ready').map((account) => account.planLabel));
            const sharedPlan = plans.size === 1 ? [...plans][0] ?? null : null;
            return {
                key,
                serviceLabel: group.first.serviceLabel,
                legacyServiceId: group.first.legacyServiceId,
                planLabel: sharedPlan,
                accounts: group.accounts.map((account) => {
                    const windows = account.meters.map((meter): UsageWindowRow => {
                        const remainingPct = meter.remainingPct === null || !Number.isFinite(meter.remainingPct)
                            ? null
                            : clampPct(meter.remainingPct);
                        return {
                            meterId: meter.meterId,
                            label: resolveConnectedServiceQuotaMeterLabel(meter.meterId, meter.label),
                            usedPct: remainingPct === null ? null : Math.round(100 - remainingPct),
                            remainingPct: remainingPct === null ? null : Math.round(remainingPct),
                            resetsAt: meter.resetsAt,
                            tone: resolveQuotaTone(remainingPct),
                        };
                    });
                    return {
                        key: account.key,
                        label: account.accountLabel,
                        email: account.accountEmail,
                        accountId: account.accountId,
                        planLabel: account.planLabel,
                        fetchedAt: account.fetchedAt ?? null,
                        state: account.state,
                        windows,
                        healthy: account.state === 'ready'
                            && windows.length > 0
                            && windows.every((window) => window.tone === 'success'),
                    };
                }),
            };
        })
        .sort((left, right) => left.serviceLabel.localeCompare(right.serviceLabel) || left.key.localeCompare(right.key));
}
