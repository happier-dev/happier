import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

export const ACCOUNT_MACHINE_ADMINISTRATION_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    machineAdministrationSelectionsV1: {
        valueKind: 'presence',
        privacy: 'forbidden',
        identityScope: 'person',
    },
});
