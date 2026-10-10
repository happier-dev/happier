import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function arrayCount(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

export const ACCOUNT_COLLECTION_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    favoriteDirectories: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    },
    favoriteMachines: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    },
    favoriteProfiles: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    },
    favoriteModelSelectionsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    },
    favoriteBackendTargetKeysV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    },
});
