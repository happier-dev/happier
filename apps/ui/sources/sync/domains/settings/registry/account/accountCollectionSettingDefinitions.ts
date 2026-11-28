import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

import { FavoriteModelSelectionV1Schema } from '@/sync/domains/models/favoriteModelSelections';
import { FavoriteBackendTargetKeysV1Schema } from '@/sync/domains/sessionAuthoring/favoriteBackendTargets';

function arrayCount(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

export const ACCOUNT_COLLECTION_SETTING_DEFINITIONS = defineSettingDefinitions({
    recentMachinePaths: {
        schema: z.array(z.object({ machineId: z.string(), path: z.string() })),
        default: [],
        description: 'Last 10 machine-path combinations, ordered by most recent first',
        storageScope: 'account',
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
    dismissedCLIWarnings: {
        schema: z.object({
            perMachine: z.record(z.string(), z.record(z.string(), z.boolean()).default({})).default({}),
            global: z.record(z.string(), z.boolean()).default({}),
        }).default({ perMachine: {}, global: {} }),
        default: { perMachine: {}, global: {} },
        description: 'Tracks which CLI installation warnings user has dismissed (per-machine or globally)',
        storageScope: 'account',
    },
});

export const ACCOUNT_COLLECTION_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_COLLECTION_SETTING_DEFINITIONS);
