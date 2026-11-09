import { getPreferredLanguage } from '@/text';
import {
    formatTokenCount as formatSharedTokenCount,
    formatTokenCountLong as formatSharedTokenCountLong,
    formatUsageCost as formatSharedUsageCost,
} from '@happier-dev/protocol/usage/usageFormatting';

/** Usage reads the selected app language, including when it differs from the device's. */
export function formatTokenCount(value: number, locales: Intl.LocalesArgument = getPreferredLanguage()): string {
    return formatSharedTokenCount(value, locales);
}

export function formatTokenCountLong(value: number, locales: Intl.LocalesArgument = getPreferredLanguage()): string {
    return formatSharedTokenCountLong(value, locales);
}

export function formatUsageCost(usd: number, currency: string, locales: Intl.LocalesArgument = getPreferredLanguage()): string {
    return formatSharedUsageCost(usd, currency, locales);
}

export { formatPercent, formatIdentifierLabel }
    from '@happier-dev/protocol/usage/usageFormatting';
