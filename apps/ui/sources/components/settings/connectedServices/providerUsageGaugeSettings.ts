export const PROVIDER_USAGE_GAUGE_SETTINGS_SECTION = {
    titleKey: 'settingsSession.providerUsageGauge.title',
    featureId: 'connectedServices.quotas',
    settings: {
        gaugeVisible: { storage: { scope: 'account', key: 'sessionProviderUsageGaugeMode', access: 'read_write' }, titleKey: 'settingsSession.providerUsageGauge.visibilityTitle' },
        gaugeLabels: { storage: { scope: 'account', key: 'sessionUsageGaugeLabels', access: 'read_write' }, titleKey: 'settingsSession.providerUsageGauge.labelsTitle' },
        gaugeWindow: {
            titleKey: 'settingsSession.providerUsageGauge.windowTitle',
            keywordKeys: [
                'settingsSession.providerUsageGauge.windowDailyTitle',
                'settingsSession.providerUsageGauge.windowWeeklyTitle',
            ],
        },
    },
} as const;
