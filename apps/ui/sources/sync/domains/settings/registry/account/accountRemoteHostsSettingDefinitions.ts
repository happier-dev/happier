import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function arrayCount(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

export const ACCOUNT_REMOTE_HOSTS_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    remoteHostsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    },
});
