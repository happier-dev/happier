import {
    BackendTargetKeySchema,
    BackendTargetRefSchema,
    buildSettingArtifacts,
    defineSettingDefinitions,
} from '@happier-dev/protocol';
import { z } from 'zod';

import {
    SESSION_TRANSCRIPT_STORAGE_MODES,
    serializeTranscriptStorageModeByTargetKeyAnalytics,
    type SessionTranscriptStorageMode,
} from '@/sync/domains/session/transcriptStorageDefaults';
import { RememberedEngineSelectionsByScopeV1Schema } from '@/sync/domains/sessionAuthoring/rememberedEngineSelections';

const SessionTranscriptStorageModeSchema = z.enum(SESSION_TRANSCRIPT_STORAGE_MODES);
const NewSessionDefaultCheckoutModeV1Schema = z.enum(['current_path', 'git_worktree']);

export const NEW_SESSION_WIZARD_SELECTION_SECTION_IDS = [
    'profiles',
    'backends',
    'models',
    'machines',
    'paths',
    'permissions',
] as const;

export const NEW_SESSION_WIZARD_SECTION_PRESENTATIONS = [
    'auto',
    'list',
    'dropdown',
] as const;

export type NewSessionWizardSelectionSectionId = typeof NEW_SESSION_WIZARD_SELECTION_SECTION_IDS[number];
export type NewSessionWizardSectionPresentation = typeof NEW_SESSION_WIZARD_SECTION_PRESENTATIONS[number];

const NewSessionWizardSelectionSectionIdSchema = z.enum(NEW_SESSION_WIZARD_SELECTION_SECTION_IDS);
const NewSessionWizardSectionPresentationSchema = z.enum(NEW_SESSION_WIZARD_SECTION_PRESENTATIONS);

const NewSessionAgentPickerViewV1BackendSchema = z.object({
    kind: z.literal('backend'),
    backendTargetKey: BackendTargetKeySchema,
});

const NewSessionAgentPickerViewV1FavoriteModelsSchema = z.object({
    kind: z.literal('favoriteModels'),
});

export const NewSessionAgentPickerViewV1Schema = z.preprocess((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.kind === 'favoriteModels') {
        return { kind: 'favoriteModels' };
    }
    if (record.kind === 'backend' && BackendTargetKeySchema.safeParse(record.backendTargetKey).success) {
        return {
            kind: 'backend',
            backendTargetKey: record.backendTargetKey,
        };
    }
    return null;
}, z.union([
    NewSessionAgentPickerViewV1BackendSchema,
    NewSessionAgentPickerViewV1FavoriteModelsSchema,
]).nullable().default(null));

export type NewSessionAgentPickerViewV1 = z.infer<typeof NewSessionAgentPickerViewV1Schema>;

const NewSessionWizardSectionPresentationByIdSchema = z.preprocess((value) => {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};

    return Object.fromEntries(
        Object.entries(record).flatMap(([sectionId, raw]) => {
            if (!NewSessionWizardSelectionSectionIdSchema.safeParse(sectionId).success) return [];
            if (!NewSessionWizardSectionPresentationSchema.safeParse(raw).success) return [];
            return [[sectionId, raw]];
        }),
    ) as Partial<Record<NewSessionWizardSelectionSectionId, NewSessionWizardSectionPresentation>>;
}, z.partialRecord(NewSessionWizardSelectionSectionIdSchema, NewSessionWizardSectionPresentationSchema).default({}));

export function resolveNewSessionWizardSectionPresentation(
    setting: Partial<Record<NewSessionWizardSelectionSectionId, NewSessionWizardSectionPresentation>> | null | undefined,
    sectionId: NewSessionWizardSelectionSectionId,
): NewSessionWizardSectionPresentation {
    return setting?.[sectionId] ?? 'auto';
}

const SessionTranscriptStorageModeByTargetKeySchema = z.preprocess((value) => {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};

    const filtered = Object.fromEntries(
        Object.entries(record).flatMap(([targetKey, raw]) => {
            if (!BackendTargetKeySchema.safeParse(targetKey).success) return [];
            return raw === 'direct' || raw === 'persisted'
                ? [[targetKey, raw]]
                : [];
        }),
    ) as Record<string, SessionTranscriptStorageMode>;

    return filtered;
}, z.record(BackendTargetKeySchema, SessionTranscriptStorageModeSchema).default({}));

export const ACCOUNT_SESSION_CREATION_SETTING_DEFINITIONS = defineSettingDefinitions({
    lastUsedAgent: {
        schema: z.string().nullable(),
        default: null,
        description: 'Last selected agent type for new sessions',
        storageScope: 'local',
    },
    lastUsedBackendTarget: {
        schema: BackendTargetRefSchema.nullable(),
        default: null,
        description: 'Last selected backend target for new sessions',
        storageScope: 'local',
    },
    lastNewSessionAgentPickerViewV1: {
        schema: NewSessionAgentPickerViewV1Schema,
        default: null,
        description: 'Last explicitly focused view in the new-session engine picker',
        storageScope: 'local',
    },
    rememberLastProjectSessionSelections: {
        schema: z.boolean(),
        default: true,
        description: 'Use the newest session in a project to seed project new-session shortcuts',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'boolean',
            privacy: 'safe',
            identityScope: 'person',
        },
    },
    rememberLastEngineSelectionsV1: {
        schema: z.boolean(),
        default: true,
        description: 'Remember the last selected model, session mode, and config options for each new-session engine',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'boolean',
            privacy: 'safe',
            identityScope: 'person',
        },
    },
    lastEngineSelectionsByScopeV1: {
        schema: RememberedEngineSelectionsByScopeV1Schema,
        default: {} as Record<string, never>,
        description: 'Remembered new-session engine selections keyed by server and backend target',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: (value: unknown) => (
                value && typeof value === 'object' && !Array.isArray(value)
                    ? Object.keys(value as Record<string, unknown>).length
                    : 0
            ),
        },
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
    newSessionWizardSectionPresentationV1: {
        schema: NewSessionWizardSectionPresentationByIdSchema,
        default: {} as Partial<Record<NewSessionWizardSelectionSectionId, NewSessionWizardSectionPresentation>>,
        description: 'Per-section presentation mode for new-session wizard selectors',
        storageScope: 'account',
    },
    newSessionWizardColumnsEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Arrange new-session wizard selectors in columns on wide screens',
        storageScope: 'account',
    },
    newSessionDefaultCheckoutModeV1: {
        schema: NewSessionDefaultCheckoutModeV1Schema,
        default: 'current_path',
        description: 'Default checkout mode for new sessions in Git repositories',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'enum',
            privacy: 'safe',
            identityScope: 'person',
        },
    },
});

export const ACCOUNT_SESSION_CREATION_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_SESSION_CREATION_SETTING_DEFINITIONS);
