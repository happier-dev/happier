import { t } from '@/text';
import type { UsageCostMode } from '@/sync/api/account/usageAnalytics';

export function resolveUsageCostModeLabel(input: Readonly<{
    availableCostModes: readonly UsageCostMode[];
    mode: UsageCostMode;
}>): string {
    if (input.availableCostModes.length === 1 && input.availableCostModes[0] === 'auto') {
        return t('usage.auto');
    }

    if (input.mode === 'reported') {
        return t('usage.reported');
    }
    if (input.mode === 'estimated') {
        return t('usage.estimated');
    }
    return t('usage.auto');
}
