import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function buildProfilesSummaryProperties(value: unknown): Record<string, number> {
    const profiles = Array.isArray(value) ? value : [];
    let customEnvVarProfileCount = 0;
    let builtInCount = 0;
    let machineLoginCount = 0;
    for (const profile of profiles) {
        if (!profile || typeof profile !== 'object' || Array.isArray(profile))
            continue;
        const record = profile as Record<string, unknown>;
        const environmentVariables = Array.isArray(record.environmentVariables) ? record.environmentVariables : [];
        if (environmentVariables.length > 0)
            customEnvVarProfileCount += 1;
        if (record.isBuiltIn === true)
            builtInCount += 1;
        if (record.authMode === 'machineLogin')
            machineLoginCount += 1;
    }
    return {
        totalCount: profiles.length,
        customEnvVarProfileCount,
        builtInCount,
        machineLoginCount,
    };
}

function serializeLastUsedProfileKind(value: unknown, settingsRecord: Readonly<Record<string, unknown>>): 'none' | 'builtin' | 'custom' {
    if (typeof value !== 'string' || value.length === 0)
        return 'none';
    const profiles = Array.isArray(settingsRecord.profiles) ? settingsRecord.profiles : [];
    const matchingProfile = profiles.find((profile) => (profile
        && typeof profile === 'object'
        && !Array.isArray(profile)
        && (profile as Record<string, unknown>).id === value));
    if (matchingProfile
        && typeof matchingProfile === 'object'
        && !Array.isArray(matchingProfile)
        && (matchingProfile as Record<string, unknown>).isBuiltIn === true) {
        return 'builtin';
    }
    return 'custom';
}

function buildSecretBindingsSummaryProperties(value: unknown): Record<string, number> {
    const bindingsByProfileId = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.values(value as Record<string, unknown>)
        : [];
    let totalBindingCount = 0;
    for (const bindingRecord of bindingsByProfileId) {
        if (!bindingRecord || typeof bindingRecord !== 'object' || Array.isArray(bindingRecord))
            continue;
        totalBindingCount += Object.keys(bindingRecord as Record<string, unknown>).length;
    }
    return {
        boundProfileCount: bindingsByProfileId.length,
        totalBindingCount,
    };
}

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
    profiles: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildProfilesSummaryProperties,
    },
    lastUsedProfile: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentWithContext: serializeLastUsedProfileKind,
    },
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
    secretBindingsByProfileId: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildSecretBindingsSummaryProperties,
    },
});
