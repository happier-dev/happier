import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

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
        if (!Array.isArray(pinnedMeterIds)) continue;
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
        if (strategy === 'primary') primaryCount += 1;
        if (strategy === 'min_remaining') minRemainingCount += 1;
    }

    return {
        primaryCount,
        minRemainingCount,
    };
}

export const ACCOUNT_CONNECTED_SERVICES_SETTING_DEFINITIONS = defineSettingDefinitions({
    connectedServicesDefaultProfileByServiceId: {
        schema: z.record(z.string(), z.string()).default({}),
        default: {},
        description: 'Default connected service profileId per serviceId (used for new-session bindings)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: objectKeyCount,
        },
    },
    connectedServicesProfileLabelByKey: {
        schema: z.record(z.string(), z.string()).default({}),
        default: {},
        description: 'User-defined label per connected service profile, keyed by "serviceId/profileId"',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: objectKeyCount,
        },
    },
    connectedServicesQuotaPinnedMeterIdsByKey: {
        schema: z.record(z.string(), z.array(z.string())).default({}),
        default: {},
        description: 'Pinned connected service quota meter ids per profile, keyed by "serviceId/profileId"',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildPinnedMeterSummaryProperties,
        },
    },
    connectedServicesQuotaSummaryStrategyByKey: {
        schema: z.record(z.string(), z.enum(['primary', 'min_remaining'])).default({}),
        default: {},
        description: 'Connected service quota summary strategy per profile, keyed by "serviceId/profileId"',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildQuotaSummaryStrategyProperties,
        },
    },
});

export const ACCOUNT_CONNECTED_SERVICES_SETTING_ARTIFACTS = buildSettingArtifacts(
    ACCOUNT_CONNECTED_SERVICES_SETTING_DEFINITIONS,
);
