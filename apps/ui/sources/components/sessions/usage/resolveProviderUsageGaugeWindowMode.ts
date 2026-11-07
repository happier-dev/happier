import type { ConnectedServiceQuotaGaugeWindowMode } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

/** Narrows the persisted `sessionProviderUsageGaugeWindowMode` setting to a window mode. */
export function resolveProviderUsageGaugeWindowMode(setting: unknown): ConnectedServiceQuotaGaugeWindowMode {
    return setting === 'daily'
        || setting === 'weekly'
        || setting === 'primary'
        || setting === 'secondary'
        || setting === 'session'
        ? setting
        : 'most_constrained';
}
