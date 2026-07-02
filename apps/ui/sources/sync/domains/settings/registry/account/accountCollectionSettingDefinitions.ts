import { buildSettingArtifacts, defineSettingDefinitions, WorkspaceRefV1Schema } from '@happier-dev/protocol';
import { z } from 'zod';

import { FavoriteModelSelectionV1Schema } from '@/sync/domains/models/favoriteModelSelections';
import { FavoriteBackendTargetKeysV1Schema } from '@/sync/domains/session/authoring/favoriteBackendTargets';
import { SessionFoldersV1Schema } from '@/sync/domains/session/folders';
import { SessionSplitCanvasLayoutsSchema } from '@/sync/domains/session/sessionSplitCanvasPersistence';

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
    favoriteModelSelectionsV1: {
        schema: z.array(FavoriteModelSelectionV1Schema),
        default: [],
        description: 'User-defined favorite engine model selections for quick access in engine selection',
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
    favoriteBackendTargetKeysV1: {
        schema: FavoriteBackendTargetKeysV1Schema,
        default: [],
        description: 'User-defined favorite new-session engines for quick access in engine selection',
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
    workspaceRefsV1: {
        schema: z.array(WorkspaceRefV1Schema).default([]),
        default: [],
        description: 'Saved workspace (project) references for first-class Projects UI',
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
    pinnedWorkspaceRefIdsV1: {
        schema: z.array(z.string()).default([]),
        default: [],
        description: 'Pinned workspace ref ids (Projects)',
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
    sessionWorkspaceOrderV1: {
        schema: z.record(z.string(), z.array(z.string())).default({}),
        default: {},
        description: 'Manual workspace ordering overrides by server scope',
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
    sessionFoldersV1: {
        schema: SessionFoldersV1Schema.default({ v: 1, folders: [] }),
        default: { v: 1, folders: [] },
        description: 'User-defined folders for organizing synced sessions',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: (value: unknown) => {
                const folders = value && typeof value === 'object' && !Array.isArray(value)
                    ? (value as Record<string, unknown>).folders
                    : null;
                return Array.isArray(folders) ? folders.length : 0;
            },
        },
    },
    sessionSplitCanvasLayoutsV1: {
        schema: SessionSplitCanvasLayoutsSchema,
        default: {},
        description: 'Synced semantic split-canvas layouts for workspace-scoped session canvases',
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
