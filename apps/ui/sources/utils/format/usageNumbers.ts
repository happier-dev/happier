import { getPreferredLanguage, t } from '@/text';
import {
    formatTokenCount as formatSharedTokenCount,
    formatTokenCountLong as formatSharedTokenCountLong,
    formatUsageCost as formatSharedUsageCost,
} from '@happier-dev/protocol/usage/usageFormatting';

/** Usage reads the selected app language, including when it differs from the device's. */
export function formatTokenCount(value: number | null, locales: Intl.LocalesArgument = getPreferredLanguage()): string {
    return formatSharedTokenCount(value, locales, t('usage.board.plans.cellUnknown'));
}

export function formatTokenCountLong(value: number | null, locales: Intl.LocalesArgument = getPreferredLanguage()): string {
    return formatSharedTokenCountLong(value, locales, t('usage.board.plans.cellUnknown'));
}

export function formatUsageCost(usd: number | null, currency: string, locales: Intl.LocalesArgument = getPreferredLanguage()): string {
    return formatSharedUsageCost(usd, currency, locales, t('usage.board.plans.cellUnknown'));
}

export { formatPercent, formatIdentifierLabel }
    from '@happier-dev/protocol/usage/usageFormatting';
