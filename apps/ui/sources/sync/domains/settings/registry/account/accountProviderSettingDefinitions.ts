import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

export const ACCOUNT_PROVIDER_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    providerDefaultModelSelectionsByAgentTargetKeyV1: {
        valueKind: 'presence',
        privacy: 'forbidden',
        identityScope: 'person',
    },
});
