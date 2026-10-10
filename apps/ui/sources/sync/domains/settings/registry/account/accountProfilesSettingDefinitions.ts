import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function buildProfileEnabledSummaryProperties(value: unknown): Record<string, number> {
    const entries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.values(value as Record<string, unknown>)
        : [];
    return {
        overrideCount: entries.length,
        enabledOverrideCount: entries.filter((entry) => entry === true).length,
        disabledOverrideCount: entries.filter((entry) => entry === false).length,
    };
}

export const ACCOUNT_PROFILES_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    profileEnabledById: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildProfileEnabledSummaryProperties,
    },
    secrets: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: (value: unknown) => (Array.isArray(value) ? value.length : 0),
    },
});
