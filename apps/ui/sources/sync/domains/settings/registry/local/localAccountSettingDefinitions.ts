import { BackendTargetRefV2InputSchema, PersistedAgentTargetRefV1Schema, PersistedBackendTargetRefV2Schema, readBackendTargetRefV2, writePersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ClientEncryptionRequirementSchema } from '@happier-dev/protocol/encryption/clientEncryptionRequirement';
import { MachineAdministrationTargetsV1Schema } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { buildSettingArtifacts } from '@happier-dev/protocol/settings/registry/buildSettingArtifacts';
import { defineSettingDefinitions } from '@happier-dev/protocol/settings/registry/settingDefinition';
import { z } from 'zod/mini';
import * as zMini from 'zod/mini';
import { createStoredReadSchema, defineStoredReadProjection } from '@happier-dev/protocol/json/storedReadSchema';

import { normalizeAccountSettingsServerSelection } from '@/sync/domains/settings/parse/accountSettingsServerSelectionNormalization';

function normalizeLastUsedBackendTarget(value: unknown, storedRead = false) {
    if (value === null || value === undefined) return null;

    // Installed Agents persist their exact contribution identity. Resolving
    // that identity into the legacy flat backend id belongs to the current
    // projected catalog, not this projection-independent local-settings
    // reader. Preserve it until that owner can resolve or retire it.
    const persistedAgent = zMini.safeParse(storedRead ? createStoredReadSchema(PersistedAgentTargetRefV1Schema) : PersistedAgentTargetRefV1Schema, value);
    if (persistedAgent.success) return persistedAgent.data;

    const backendInput = zMini.safeParse(storedRead ? createStoredReadSchema(BackendTargetRefV2InputSchema) : BackendTargetRefV2InputSchema, value);
    if (!backendInput.success) return null;
    try {
        return writePersistedBackendTargetRefV2(
            readBackendTargetRefV2(backendInput.data),
        );
    } catch {
        return null;
    }
}

const LastUsedBackendTargetSchema = defineStoredReadProjection(
    (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => normalizeLastUsedBackendTarget(value)), zMini.nullable(PersistedBackendTargetRefV2Schema)),
    () => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => normalizeLastUsedBackendTarget(value, true)), zMini.nullable(createStoredReadSchema(PersistedBackendTargetRefV2Schema))),
);

export const ServerSelectionGroupSchema = z.object({
    id: z.string().check(z.minLength(1)),
    name: z.string().check(z.minLength(1), z.maxLength(100)),
    serverIds: z._default(z.array(z.string()), []),
    presentation: z._default(z.enum(['grouped', 'flat-with-badge']), 'grouped'),
});

/**
 * These values participate in the account-settings UI state but are persisted only on this
 * device. They deliberately live outside the Protocol Account Settings catalog so they cannot
 * be emitted by account-settings writers.
 */
const localAccountSettingInputs = {
    machineAdministrationTargetsLocalV1: {
        schema: z.pipe(MachineAdministrationTargetsV1Schema, z.transform(targets => Object.fromEntries(
            Object.entries(targets).filter(([key]) => key !== 'machines.managed' && !key.startsWith('plugin.lastRunOn:')),
        ))),
        default: {},
        description: 'Remembered Administration targets on this device, scoped to the Account and Home',
        storageScope: 'local',
    },
    lastUsedAgent: {
        schema: z.nullable(z.string()),
        default: null,
        description: 'Read-only predecessor seed for device-local New Session Agent memory',
        storageScope: 'local',
    },
    lastUsedBackendTarget: {
        schema: LastUsedBackendTargetSchema,
        default: null,
        description: 'Read-only predecessor seed for device-local New Session target memory',
        storageScope: 'local',
    },
    serverSelectionGroups: {
        schema: z.array(ServerSelectionGroupSchema),
        default: [],
        description: 'Saved server selection groups',
        storageScope: 'local',
    },
    serverSelectionActiveTargetKind: {
        schema: z.nullable(z.enum(['server', 'group'])),
        default: null,
        description: 'Explicit active server selection target kind',
        storageScope: 'local',
    },
    serverSelectionActiveTargetId: {
        schema: z.nullable(z.string()),
        default: null,
        description: 'Explicit active server selection target id',
        storageScope: 'local',
    },
    terminalConnectLegacySecretExportEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Retired terminal-connect field retained only to read and isolate existing local settings',
        storageScope: 'local',
    },
    clientEncryptionRequirementLocalV1: {
        schema: ClientEncryptionRequirementSchema,
        default: 'follow_account',
        description: 'Trusted device-local minimum Account and Session encryption policy',
        storageScope: 'local',
    },
} as const;

export const LOCAL_ACCOUNT_SETTING_DEFINITIONS: ReturnType<typeof defineSettingDefinitions<typeof localAccountSettingInputs>> = defineSettingDefinitions(localAccountSettingInputs);

export const LOCAL_ACCOUNT_SETTING_ARTIFACTS: ReturnType<typeof buildSettingArtifacts<typeof LOCAL_ACCOUNT_SETTING_DEFINITIONS>> = buildSettingArtifacts(LOCAL_ACCOUNT_SETTING_DEFINITIONS);

export const LOCAL_ACCOUNT_SETTING_KEYS = [
    'machineAdministrationTargetsLocalV1',
    'lastUsedAgent',
    'lastUsedBackendTarget',
    'serverSelectionGroups',
    'serverSelectionActiveTargetKind',
    'serverSelectionActiveTargetId',
    'terminalConnectLegacySecretExportEnabled',
    'clientEncryptionRequirementLocalV1',
] as const satisfies readonly (keyof typeof LOCAL_ACCOUNT_SETTING_DEFINITIONS)[];

export type LocalAccountSettingKey = typeof LOCAL_ACCOUNT_SETTING_KEYS[number];
export type LocalAccountSettings = typeof LOCAL_ACCOUNT_SETTING_ARTIFACTS.defaults;

function parseLocalSetting<TSchema extends zMini.core.$ZodType>(
    definition: Readonly<{ schema: TSchema; default: zMini.core.input<TSchema> }>,
    value: unknown,
): zMini.core.output<TSchema> {
    const parsed = zMini.safeParse(createStoredReadSchema(definition.schema), value);
    return parsed.success ? parsed.data : zMini.parse(definition.schema, definition.default);
}

/** Parse field-by-field so one stale device value does not discard the rest of the local state. */
export function parseLocalAccountSettings(input: unknown): LocalAccountSettings {
    const record = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
    const definitions = LOCAL_ACCOUNT_SETTING_DEFINITIONS;
    const parsed = {
        machineAdministrationTargetsLocalV1: parseLocalSetting(definitions.machineAdministrationTargetsLocalV1, record.machineAdministrationTargetsLocalV1),
        lastUsedAgent: parseLocalSetting(definitions.lastUsedAgent, record.lastUsedAgent),
        lastUsedBackendTarget: parseLocalSetting(definitions.lastUsedBackendTarget, record.lastUsedBackendTarget),
        serverSelectionGroups: parseLocalSetting(definitions.serverSelectionGroups, record.serverSelectionGroups),
        serverSelectionActiveTargetKind: parseLocalSetting(definitions.serverSelectionActiveTargetKind, record.serverSelectionActiveTargetKind),
        serverSelectionActiveTargetId: parseLocalSetting(definitions.serverSelectionActiveTargetId, record.serverSelectionActiveTargetId),
        terminalConnectLegacySecretExportEnabled: parseLocalSetting(definitions.terminalConnectLegacySecretExportEnabled, record.terminalConnectLegacySecretExportEnabled),
        clientEncryptionRequirementLocalV1: parseLocalSetting(definitions.clientEncryptionRequirementLocalV1, record.clientEncryptionRequirementLocalV1),
    };
    return normalizeAccountSettingsServerSelection(parsed);
}
