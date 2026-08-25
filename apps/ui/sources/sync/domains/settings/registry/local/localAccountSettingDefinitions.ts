import {
    BackendTargetKeyV2Schema,
    BackendTargetRefV2InputSchema,
    SessionDraftAddressV1Schema,
    buildSettingArtifacts,
    defineSettingDefinitions,
    readBackendTargetRefV2,
    writePersistedBackendTargetRefV2,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { normalizeAccountSettingsServerSelection } from '@/sync/domains/settings/parse/accountSettingsServerSelectionNormalization';

const NewSessionAgentPickerViewV1BackendSchema = z.object({
    kind: z.literal('backend'),
    backendTargetKey: BackendTargetKeyV2Schema,
});

const NewSessionAgentPickerViewV1FavoriteModelsSchema = z.object({
    kind: z.literal('favoriteModels'),
});

export const NewSessionAgentPickerViewV1Schema = z.preprocess((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.kind === 'favoriteModels') return { kind: 'favoriteModels' };
    if (record.kind === 'backend' && BackendTargetKeyV2Schema.safeParse(record.backendTargetKey).success) {
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

export const NewSessionOrdinaryEntryDraftIdSchema = z.string().refine(
    (draftId) => SessionDraftAddressV1Schema.safeParse({ kind: 'newSession', draftId }).success,
    'Expected a canonical new-session draft UUID',
);

const LastUsedBackendTargetSchema = z.union([
    BackendTargetRefV2InputSchema,
    z.null(),
]).transform((value) => {
    if (value === null) return null;
    return writePersistedBackendTargetRefV2(readBackendTargetRefV2(value));
});

export const ServerSelectionGroupSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    serverIds: z.array(z.string()).default([]),
    presentation: z.enum(['grouped', 'flat-with-badge']).default('grouped'),
});

/**
 * These values participate in the account-settings UI state but are persisted only on this
 * device. They deliberately live outside the Protocol Account Settings catalog so they cannot
 * be emitted by account-settings writers.
 */
export const LOCAL_ACCOUNT_SETTING_DEFINITIONS = defineSettingDefinitions({
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
    lastNewSessionAgentPickerViewV1: {
        schema: NewSessionAgentPickerViewV1Schema,
        default: null,
        description: 'Last explicitly focused view in the new-session engine picker',
        storageScope: 'local',
    },
    newSessionOrdinaryEntryDraftId: {
        schema: NewSessionOrdinaryEntryDraftIdSchema.nullable(),
        default: null,
        description: 'Ordinary-entry new-session draft identity for this device and Account/server scope',
        storageScope: 'local',
    },
    serverSelectionGroups: {
        schema: z.array(ServerSelectionGroupSchema),
        default: [],
        description: 'Saved server selection groups',
        storageScope: 'local',
    },
    serverSelectionActiveTargetKind: {
        schema: z.enum(['server', 'group']).nullable(),
        default: null,
        description: 'Explicit active server selection target kind',
        storageScope: 'local',
    },
    serverSelectionActiveTargetId: {
        schema: z.string().nullable(),
        default: null,
        description: 'Explicit active server selection target id',
        storageScope: 'local',
    },
    terminalConnectLegacySecretExportEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Allow terminal connect to export its legacy compatibility secret',
        storageScope: 'local',
    },
});

export const LOCAL_ACCOUNT_SETTING_ARTIFACTS = buildSettingArtifacts(LOCAL_ACCOUNT_SETTING_DEFINITIONS);

export const LOCAL_ACCOUNT_SETTING_KEYS = [
    'lastUsedAgent',
    'lastUsedBackendTarget',
    'lastNewSessionAgentPickerViewV1',
    'newSessionOrdinaryEntryDraftId',
    'serverSelectionGroups',
    'serverSelectionActiveTargetKind',
    'serverSelectionActiveTargetId',
    'terminalConnectLegacySecretExportEnabled',
] as const satisfies readonly (keyof typeof LOCAL_ACCOUNT_SETTING_DEFINITIONS)[];

export type LocalAccountSettingKey = typeof LOCAL_ACCOUNT_SETTING_KEYS[number];
export type LocalAccountSettings = typeof LOCAL_ACCOUNT_SETTING_ARTIFACTS.defaults;

function parseLocalSetting<TSchema extends z.ZodTypeAny>(
    definition: Readonly<{ schema: TSchema; default: z.input<TSchema> }>,
    value: unknown,
): z.output<TSchema> {
    const parsed = definition.schema.safeParse(value);
    return parsed.success ? parsed.data : definition.schema.parse(definition.default);
}

/** Parse field-by-field so one stale device value does not discard the rest of the local state. */
export function parseLocalAccountSettings(input: unknown): LocalAccountSettings {
    const record = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
    const definitions = LOCAL_ACCOUNT_SETTING_DEFINITIONS;
    const parsed = {
        lastUsedAgent: parseLocalSetting(definitions.lastUsedAgent, record.lastUsedAgent),
        lastUsedBackendTarget: parseLocalSetting(definitions.lastUsedBackendTarget, record.lastUsedBackendTarget),
        lastNewSessionAgentPickerViewV1: parseLocalSetting(definitions.lastNewSessionAgentPickerViewV1, record.lastNewSessionAgentPickerViewV1),
        newSessionOrdinaryEntryDraftId: parseLocalSetting(definitions.newSessionOrdinaryEntryDraftId, record.newSessionOrdinaryEntryDraftId),
        serverSelectionGroups: parseLocalSetting(definitions.serverSelectionGroups, record.serverSelectionGroups),
        serverSelectionActiveTargetKind: parseLocalSetting(definitions.serverSelectionActiveTargetKind, record.serverSelectionActiveTargetKind),
        serverSelectionActiveTargetId: parseLocalSetting(definitions.serverSelectionActiveTargetId, record.serverSelectionActiveTargetId),
        terminalConnectLegacySecretExportEnabled: parseLocalSetting(definitions.terminalConnectLegacySecretExportEnabled, record.terminalConnectLegacySecretExportEnabled),
    };
    return normalizeAccountSettingsServerSelection(parsed);
}
