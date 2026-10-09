import { z } from 'zod';
import type { AccountSettings } from '../account/settings/accountSettings.js';
import { SessionAgentSpawnPolicyV1Schema, SessionAgentSpawnPolicyV1StrictSchema, type SessionAgentSpawnPolicyV1 } from '../account/settings/sessionAgentSpawnPolicyV1.js';
import { SessionAgentStartAllowListsV1Schema } from '../account/settings/sessionAgentStartAllowListsV1.js';

type SpawnPolicyField = Exclude<keyof SessionAgentSpawnPolicyV1, 'v'>;
function spawnPolicySetting<Field extends SpawnPolicyField, Title extends `settingsActions.spawnPolicy.${string}`, Description extends `settingsActions.spawnPolicy.${string}`>(field: Field,
  titleKey: Title, descriptionKey: Description) {
  return { anchor: `actions.createSession.${field}`, pageId: 'actions', titleKey, descriptionKey,
    storage: { scope: 'account', key: 'sessionAgentSpawnPolicyV1', field, access: 'read_write' },
    presentUserOnly: false,
    parseValue: (value: unknown) => z.safeParse(SessionAgentSpawnPolicyV1StrictSchema.shape[field], value),
    readValue: (settings: Pick<AccountSettings, 'sessionAgentSpawnPolicyV1'>) => SessionAgentSpawnPolicyV1Schema.parse(settings.sessionAgentSpawnPolicyV1)[field],
    updateValue: (settings: Pick<AccountSettings, 'sessionAgentSpawnPolicyV1'>, value: unknown) =>
      SessionAgentSpawnPolicyV1StrictSchema.parse({ ...SessionAgentSpawnPolicyV1Schema.parse(settings.sessionAgentSpawnPolicyV1), [field]: value }),
  } as const;
}

function startAllowListSetting<Field extends 'allowedRoleIds' | 'allowedAgentTargetKeys', Title extends `settingsActions.spawnPolicy.${string}`, Description extends `settingsActions.spawnPolicy.${string}`>(field: Field,
  titleKey: Title, descriptionKey: Description) {
  return { anchor: `actions.createSession.${field}`, pageId: 'actions', titleKey, descriptionKey,
    storage: { scope: 'account', key: 'sessionAgentStartAllowListsV1', field, access: 'read_write' },
    presentUserOnly: false,
    // Persisted malformed lists recover fail closed; Action writes reject malformed values.
    parseValue: (value: unknown) => SessionAgentStartAllowListsV1Schema.removeCatch().shape[field].removeCatch().safeParse(value),
    readValue: (settings: Pick<AccountSettings, 'sessionAgentStartAllowListsV1'>) => SessionAgentStartAllowListsV1Schema.parse(settings.sessionAgentStartAllowListsV1)[field],
    updateValue: (settings: Pick<AccountSettings, 'sessionAgentStartAllowListsV1'>, value: unknown) =>
      SessionAgentStartAllowListsV1Schema.parse({ ...SessionAgentStartAllowListsV1Schema.parse(settings.sessionAgentStartAllowListsV1), [field]: value }),
  } as const;
}

/** The same nested bindings feed the UI page and replay-safe headless Account mutations. */
export const ACTIONS_SETTING_DECLARATIONS_V1 = {
  allowCustomDirectory: spawnPolicySetting('allowCustomDirectory', 'settingsActions.spawnPolicy.toggles.allowCustomDirectory.title', 'settingsActions.spawnPolicy.toggles.allowCustomDirectory.subtitle'),
  allowCrossMachine: spawnPolicySetting('allowCrossMachine', 'settingsActions.spawnPolicy.toggles.allowCrossMachine.title', 'settingsActions.spawnPolicy.toggles.allowCrossMachine.subtitle'),
  allowBackendTargetOverride: spawnPolicySetting('allowBackendTargetOverride', 'settingsActions.spawnPolicy.toggles.allowBackendTargetOverride.title', 'settingsActions.spawnPolicy.toggles.allowBackendTargetOverride.subtitle'),
  allowModelOverride: spawnPolicySetting('allowModelOverride', 'settingsActions.spawnPolicy.toggles.allowModelOverride.title', 'settingsActions.spawnPolicy.toggles.allowModelOverride.subtitle'),
  allowPermissionModeOverride: spawnPolicySetting('allowPermissionModeOverride', 'settingsActions.spawnPolicy.toggles.allowPermissionModeOverride.title', 'settingsActions.spawnPolicy.toggles.allowPermissionModeOverride.subtitle'),
  allowAgentModeOverride: spawnPolicySetting('allowAgentModeOverride', 'settingsActions.spawnPolicy.toggles.allowAgentModeOverride.title', 'settingsActions.spawnPolicy.toggles.allowAgentModeOverride.subtitle'),
  allowConfigOptionOverrides: spawnPolicySetting('allowConfigOptionOverrides', 'settingsActions.spawnPolicy.toggles.allowConfigOptionOverrides.title', 'settingsActions.spawnPolicy.toggles.allowConfigOptionOverrides.subtitle'),
  allowProfileOverride: spawnPolicySetting('allowProfileOverride', 'settingsActions.spawnPolicy.toggles.allowProfileOverride.title', 'settingsActions.spawnPolicy.toggles.allowProfileOverride.subtitle'),
  allowEnvironmentVariables: spawnPolicySetting('allowEnvironmentVariables', 'settingsActions.spawnPolicy.toggles.allowEnvironmentVariables.title', 'settingsActions.spawnPolicy.toggles.allowEnvironmentVariables.subtitle'),
  allowConnectedServicesOverride: spawnPolicySetting('allowConnectedServicesOverride', 'settingsActions.spawnPolicy.toggles.allowConnectedServicesOverride.title', 'settingsActions.spawnPolicy.toggles.allowConnectedServicesOverride.subtitle'),
  allowMcpSelectionOverride: spawnPolicySetting('allowMcpSelectionOverride', 'settingsActions.spawnPolicy.toggles.allowMcpSelectionOverride.title', 'settingsActions.spawnPolicy.toggles.allowMcpSelectionOverride.subtitle'),
  allowTranscriptStorageOverride: spawnPolicySetting('allowTranscriptStorageOverride', 'settingsActions.spawnPolicy.toggles.allowTranscriptStorageOverride.title', 'settingsActions.spawnPolicy.toggles.allowTranscriptStorageOverride.subtitle'),
  permissionCeiling: spawnPolicySetting('permissionCeiling', 'settingsActions.spawnPolicy.permissionCeiling.title', 'settingsActions.spawnPolicy.permissionCeiling.subtitle'),
  allowedRoleIds: startAllowListSetting('allowedRoleIds', 'settingsActions.spawnPolicy.allowLists.rolesTitle', 'settingsActions.spawnPolicy.allowLists.rolesSubtitle'),
  allowedAgentTargetKeys: startAllowListSetting('allowedAgentTargetKeys', 'settingsActions.spawnPolicy.allowLists.agentsTitle', 'settingsActions.spawnPolicy.allowLists.agentsSubtitle'),
} as const;

/** Shared Account bindings consumed by the UI declaration and the headless Action host. */
export const DELEGATION_SETTING_DECLARATIONS_V1 = {
  approvalReviewerEnabled: {
    anchor: 'delegation.approvalReviewerEnabled', pageId: 'delegation',
    storage: { scope: 'account', key: 'approvalReviewerEnabled', access: 'read_write' },
    titleKey: 'roles.delegation.approvalReviewer',
    descriptionKey: 'roles.delegation.approvalReviewerDescription',
    presentUserOnly: true,
  },
  workDepthLimit: {
    anchor: 'delegation.workDepthLimit', pageId: 'delegation',
    storage: { scope: 'account', key: 'workDepthLimit', access: 'read_write' },
    titleKey: 'roles.delegation.depthSetting',
    keywordKeys: ['roles.delegation.ladderRefused'],
    presentUserOnly: false,
  },
} as const;

export const ACCOUNT_SETTING_DECLARATIONS_V1 = {
  ...DELEGATION_SETTING_DECLARATIONS_V1,
  ...ACTIONS_SETTING_DECLARATIONS_V1,
  memoryUseInNewSessions: {
    anchor: 'prompts.context.memoryUseInNewSessions', pageId: 'prompts',
    storage: { scope: 'account', key: 'memoryUseInNewSessions', access: 'read_write' },
    titleKey: 'promptLibrary.memoryUseInNewSessionsTitle',
    descriptionKey: 'promptLibrary.memoryUseInNewSessionsDescription',
    presentUserOnly: false,
  },
  memoryUseInNewBots: {
    anchor: 'prompts.context.memoryUseInNewBots', pageId: 'prompts',
    storage: { scope: 'account', key: 'memoryUseInNewBots', access: 'read_write' },
    titleKey: 'promptLibrary.memoryUseInNewBotsTitle',
    descriptionKey: 'promptLibrary.memoryUseInNewBotsDescription',
    presentUserOnly: false,
  },
  memoryUpkeepInNewBots: {
    anchor: 'prompts.context.memoryUpkeepInNewBots', pageId: 'prompts',
    storage: { scope: 'account', key: 'memoryUpkeepInNewBots', access: 'read_write' },
    titleKey: 'promptLibrary.memoryUpkeepInNewBotsTitle',
    descriptionKey: 'promptLibrary.memoryUpkeepInNewBotsDescription',
    presentUserOnly: false,
  },
  transcriptShowToolCalls: {
    anchor: 'transcript.showToolCalls', pageId: 'transcript',
    storage: { scope: 'account', key: 'transcriptShowToolCalls', access: 'read_write' },
    titleKey: 'settingsSession.transcript.showToolCallsTitle',
    descriptionKey: 'settingsSession.transcript.showToolCallsSubtitle',
    presentUserOnly: true,
    surfaces: { agent: false, mcp: false },
  },
} as const;

export function readAccountSettingDeclarationV1(anchor: unknown) {
  return Object.values(ACCOUNT_SETTING_DECLARATIONS_V1).find(declaration => declaration.anchor === anchor) ?? null;
}

export function isPresentUserSettingWriteV1(actionId: string, input: unknown): boolean {
  return ['settings.set', 'settings.reset', 'settings.invoke'].includes(actionId) && typeof input === 'object' && input !== null
    && 'anchor' in input && readAccountSettingDeclarationV1(input.anchor)?.presentUserOnly === true;
}

/** Human transcript choices never become autonomous preference mutations, even after an approval. */
export function isAccountSettingActionSurfaceAllowedV1(actionId: string, input: unknown, surface: unknown): boolean {
  if (!['settings.set', 'settings.reset', 'settings.invoke'].includes(actionId)) return true;
  if (surface !== 'agent' && surface !== 'mcp') return true;
  if (typeof input !== 'object' || input === null || !('anchor' in input)) return true;
  const declaration = readAccountSettingDeclarationV1(input.anchor);
  return !declaration || !('surfaces' in declaration) || declaration.surfaces[surface] !== false;
}
