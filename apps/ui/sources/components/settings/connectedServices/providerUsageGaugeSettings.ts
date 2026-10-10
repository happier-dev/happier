import { gaugeWindowStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';

export const PROVIDER_USAGE_GAUGE_SETTINGS_SECTION = {
    titleKey: 'settingsSession.providerUsageGauge.title',
    featureId: 'connectedServices.quotas',
    settings: {
        gaugeVisible: {},
        gaugeLabels: {},
        routingHints: {},
        gaugeWindow: {
            storage: gaugeWindowStorage,

        },
    },
} as const;
