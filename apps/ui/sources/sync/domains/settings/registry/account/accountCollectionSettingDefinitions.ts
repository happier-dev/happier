import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function objectKeyCount(value: unknown): number {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value as Record<string, unknown>).length
        : 0;
}

function arrayCount(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function buildDismissedCliWarningsSummaryProperties(value: unknown): Record<string, number> {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const globalWarnings = record.global && typeof record.global === 'object' && !Array.isArray(record.global)
        ? record.global as Record<string, unknown>
        : {};
    const perMachineWarnings = record.perMachine && typeof record.perMachine === 'object' && !Array.isArray(record.perMachine)
        ? record.perMachine as Record<string, unknown>
        : {};
    let perMachineDismissedCount = 0;
    for (const machineWarnings of Object.values(perMachineWarnings)) {
        if (!machineWarnings || typeof machineWarnings !== 'object' || Array.isArray(machineWarnings))
            continue;
        perMachineDismissedCount += Object.keys(machineWarnings as Record<string, unknown>).length;
    }
    return {
        globalDismissedCount: Object.keys(globalWarnings).length,
        perMachineDismissedCount,
    };
}

export const ACCOUNT_COLLECTION_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    recentMachinePaths: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    },
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
    workspaceRefsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    },
    pinnedWorkspaceRefIdsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    },
    sessionSplitCanvasLayoutsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: objectKeyCount,
    },
    dismissedCLIWarnings: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildDismissedCliWarningsSummaryProperties,
    },
});
