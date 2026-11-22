import { formatUsageCost } from '@happier-dev/protocol/usage/usageFormatting';

import { t } from '@/text';

import type { ConnectedServiceQuotaReportedAmount, ProviderUsageAmount, ProviderUsageMeterPresentation } from './presentProviderConnectionUsage';

function formatMoney(value: number, unit: ProviderUsageMeterPresentation['unit'], currency?: string): string {
    const magnitude = Math.abs(value);
    const text = currency || unit === 'usd'
        ? formatUsageCost(magnitude, currency ?? 'USD')
        : new Intl.NumberFormat().format(magnitude);
    return value < 0 ? `−${text}` : text;
}

/** The reported amount, retaining denomination, negative balances and the distinction between spent and remaining. */
export function formatProviderUsageAmount(
    amount: ProviderUsageAmount | null,
    unit: ProviderUsageMeterPresentation['unit'],
    currency?: string,
): string | null {
    if (amount === null) return null;
    switch (amount.kind) {
        case 'used':
            return formatMoney(amount.used, unit, currency);
        case 'remaining':
            return amount.remaining < 0
                ? formatMoney(amount.remaining, unit, currency)
                : t('settingsProvidersCollection.usage.amountLeft', { amount: formatMoney(amount.remaining, unit, currency) });
        case 'remainingOfLimit':
            return t('settingsProvidersCollection.usage.amountLeftOfLimit', {
                amount: formatMoney(amount.remaining, unit, currency),
                limit: formatMoney(amount.limit, unit, currency),
            });
    }
}

/** Undefined retains a percentage row; null retains the provider's unavailable amount. */
export function formatConnectedServiceQuotaReportedAmount(
    reported: ConnectedServiceQuotaReportedAmount | undefined,
): string | null | undefined {
    return reported === undefined ? undefined : formatProviderUsageAmount(reported.amount, reported.unit, reported.currency);
}

/** Qualify spend when its observation establishes that the provider omitted the cap. */
export function formatConnectedServiceQuotaAllowance(
    reported: ConnectedServiceQuotaReportedAmount | undefined,
): string | null | undefined {
    const amount = formatConnectedServiceQuotaReportedAmount(reported);
    return reported?.capMissing === true
        ? `${amount} · ${t('usage.board.plans.cellNoAllowance')}`
        : amount;
}
