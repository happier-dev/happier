import { ConnectedServicesDefaultAuthByAgentIdV1Schema, ConnectedServicesProviderStateSharingSettingsV1Schema } from '@happier-dev/protocol';
import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function objectKeyCount(value: unknown): number {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value as Record<string, unknown>).length
        : 0;
}

function buildPinnedMeterSummaryProperties(value: unknown): Record<string, number> {
    const entries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value as Record<string, unknown>)
        : [];
    let profilesWithPinsCount = 0;
    let totalPinnedMeterCount = 0;
    for (const [, pinnedMeterIds] of entries) {
        if (!Array.isArray(pinnedMeterIds))
            continue;
        profilesWithPinsCount += 1;
        totalPinnedMeterCount += pinnedMeterIds.length;
    }
    return {
        profilesWithPinsCount,
        totalPinnedMeterCount,
    };
}

function buildQuotaSummaryStrategyProperties(value: unknown): Record<string, number> {
    const entries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.values(value as Record<string, unknown>)
        : [];
    let primaryCount = 0;
    let minRemainingCount = 0;
    for (const strategy of entries) {
        if (strategy === 'primary')
            primaryCount += 1;
        if (strategy === 'min_remaining')
            minRemainingCount += 1;
    }
    return {
        primaryCount,
        minRemainingCount,
    };
}

export const ACCOUNT_CONNECTED_SERVICES_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    connectedServicesDefaultProfileByServiceId: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: objectKeyCount,
    },
    connectedServicesProfileLabelByKey: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: objectKeyCount,
    },
    connectedServicesQuotaPinnedMeterIdsByKey: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildPinnedMeterSummaryProperties,
    },
    connectedServicesCollapsedItemKeysV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: objectKeyCount,
    },
    connectedServicesQuotaSummaryStrategyByKey: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildQuotaSummaryStrategyProperties,
    },
    connectedServicesDefaultAuthByAgentIdV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: (value: unknown) => {
            const parsed = ConnectedServicesDefaultAuthByAgentIdV1Schema.parse(value);
            return objectKeyCount(parsed.bindingsByAgentId);
        },
    },
    connectedServicesDefaultAuthPoolAdoptionDismissedByKey: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: objectKeyCount,
    },
    connectedServicesProviderStateSharingSettingsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: (value: unknown) => {
            const parsed = ConnectedServicesProviderStateSharingSettingsV1Schema.parse(value);
            return {
                overrideCount: objectKeyCount(parsed.byAgentId),
                acknowledgedRiskCount: objectKeyCount(parsed.acknowledgedRisksByAgentId),
                defaultsConfigLinked: parsed.defaults.configMode === 'linked' ? 1 : 0,
                defaultsConfigCopied: parsed.defaults.configMode === 'copied' ? 1 : 0,
                defaultsConfigIsolated: parsed.defaults.configMode === 'isolated' ? 1 : 0,
                defaultsStateShared: parsed.defaults.stateMode === 'shared' ? 1 : 0,
            };
        },
    },
});
