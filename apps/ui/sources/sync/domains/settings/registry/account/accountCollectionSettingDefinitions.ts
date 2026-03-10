import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

function objectKeyCount(value: unknown): number {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value as Record<string, unknown>).length
        : 0;
}

function arrayCount(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function buildSessionTagSummaryProperties(value: unknown): Record<string, number> {
    const entries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value as Record<string, unknown>)
        : [];

    let taggedSessionCount = 0;
    let totalTagsCount = 0;
    for (const [, tags] of entries) {
        if (!Array.isArray(tags)) continue;
        taggedSessionCount += 1;
        totalTagsCount += tags.length;
    }

    return {
        taggedSessionCount,
        totalTagsCount,
    };
}

function buildSessionListGroupOrderSummaryProperties(value: unknown): Record<string, number> {
    const entries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value as Record<string, unknown>)
        : [];

    let totalOrderedKeyCount = 0;
    for (const [, orderedKeys] of entries) {
        if (!Array.isArray(orderedKeys)) continue;
        totalOrderedKeyCount += orderedKeys.length;
    }

    return {
        groupOverrideCount: entries.length,
        totalOrderedKeyCount,
    };
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
        if (!machineWarnings || typeof machineWarnings !== 'object' || Array.isArray(machineWarnings)) continue;
        perMachineDismissedCount += Object.keys(machineWarnings as Record<string, unknown>).length;
    }

    return {
        globalDismissedCount: Object.keys(globalWarnings).length,
        perMachineDismissedCount,
    };
}

export const ACCOUNT_COLLECTION_SETTING_DEFINITIONS = defineSettingDefinitions({
    recentMachinePaths: {
        schema: z.array(z.object({ machineId: z.string(), path: z.string() })),
        default: [],
        description: 'Last 10 machine-path combinations, ordered by most recent first',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: arrayCount,
        },
    },
    favoriteDirectories: {
        schema: z.array(z.string()),
        default: [],
        description: 'User-defined favorite directories for quick access in path selection',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: arrayCount,
        },
    },
    favoriteMachines: {
        schema: z.array(z.string()),
        default: [],
        description: 'User-defined favorite machines (machine IDs) for quick access in machine selection',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: arrayCount,
        },
    },
    favoriteProfiles: {
        schema: z.array(z.string()),
        default: [],
        description: 'User-defined favorite profiles (profile IDs) for quick access in profile selection',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: arrayCount,
        },
    },
    pinnedSessionKeysV1: {
        schema: z.array(z.string()).default([]),
        default: [],
        description: 'Pinned session keys (format: serverId:sessionId)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: arrayCount,
        },
    },
    workspaceLabelsV1: {
        schema: z.record(z.string(), z.string()).default({}),
        default: {},
        description: 'Custom display labels for workspace groups in the session list',
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
    collapsedGroupKeysV1: {
        schema: z.record(z.string(), z.boolean()).default({}),
        default: {},
        description: 'Collapsed state for session list groups',
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
    sessionTagsV1: {
        schema: z.record(z.string(), z.array(z.string())).default({}),
        default: {},
        description: 'User-defined tags per session',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildSessionTagSummaryProperties,
        },
    },
    sessionListGroupOrderV1: {
        schema: z.record(z.string(), z.array(z.string())).default({}),
        default: {},
        description: 'Manual ordering overrides by groupKey',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildSessionListGroupOrderSummaryProperties,
        },
    },
    dismissedCLIWarnings: {
        schema: z.object({
            perMachine: z.record(z.string(), z.record(z.string(), z.boolean()).default({})).default({}),
            global: z.record(z.string(), z.boolean()).default({}),
        }).default({ perMachine: {}, global: {} }),
        default: { perMachine: {}, global: {} },
        description: 'Tracks which CLI installation warnings user has dismissed (per-machine or globally)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildDismissedCliWarningsSummaryProperties,
        },
    },
});

export const ACCOUNT_COLLECTION_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_COLLECTION_SETTING_DEFINITIONS);
