import {
    BackendTargetKeyV2Schema,
    BackendTargetRefV2InputSchema,
    buildSettingArtifacts,
    defineSettingDefinitions,
    readBackendTargetRefV2,
} from '@happier-dev/protocol';
import { z } from 'zod';

import {
    SESSION_TRANSCRIPT_STORAGE_MODES,
    serializeTranscriptStorageModeByTargetKeyAnalytics,
    type SessionTranscriptStorageMode,
} from '@/sync/domains/session/transcriptStorageDefaults';

const SessionTranscriptStorageModeSchema = z.enum(SESSION_TRANSCRIPT_STORAGE_MODES);

const SessionTranscriptStorageModeByTargetKeySchema = z.preprocess((value) => {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};

    const filtered = Object.fromEntries(
        Object.entries(record).flatMap(([targetKey, raw]) => {
            if (!BackendTargetKeyV2Schema.safeParse(targetKey).success) return [];
            return raw === 'direct' || raw === 'persisted'
                ? [[targetKey, raw]]
                : [];
        }),
    ) as Record<string, SessionTranscriptStorageMode>;

    return filtered;
}, z.record(BackendTargetKeyV2Schema, SessionTranscriptStorageModeSchema).default({}));

const LastUsedBackendTargetSchema = z.union([
    BackendTargetRefV2InputSchema,
    z.null(),
]).transform((value) => {
    if (value === null) return null;
    return readBackendTargetRefV2(value);
});

export const ACCOUNT_SESSION_CREATION_SETTING_DEFINITIONS = defineSettingDefinitions({
    lastUsedAgent: {
        schema: z.string().nullable(),
        default: null,
        description: 'Last selected agent type for new sessions',
        storageScope: 'local',
    },
    lastUsedBackendTarget: {
        schema: LastUsedBackendTargetSchema,
        default: null,
        description: 'Last selected backend target for new sessions',
        storageScope: 'local',
    },
    newSessionDefaultPersistenceModeV1: {
        schema: SessionTranscriptStorageModeSchema,
        default: 'persisted',
        description: 'Default transcript storage mode for new sessions',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'enum',
            privacy: 'safe',
            identityScope: 'person',
        },
    },
    newSessionDefaultPersistenceModeByTargetKeyV1: {
        schema: SessionTranscriptStorageModeByTargetKeySchema,
        default: {} as Record<string, SessionTranscriptStorageMode>,
        description: 'Per-backend override for the default transcript storage mode used for new sessions',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'enum',
            privacy: 'safe',
            identityScope: 'person',
            serializeCurrentProperties: serializeTranscriptStorageModeByTargetKeyAnalytics,
        },
    },
});

export const ACCOUNT_SESSION_CREATION_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_SESSION_CREATION_SETTING_DEFINITIONS);
