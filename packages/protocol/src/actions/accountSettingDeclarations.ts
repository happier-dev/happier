import { z } from 'zod';
import type { AccountSettings } from '../account/settings/accountSettings.js';
import { SessionAgentSpawnPolicyV1Schema, SessionAgentSpawnPolicyV1StrictSchema, type SessionAgentSpawnPolicyV1 } from '../account/settings/sessionAgentSpawnPolicyV1.js';
import { SessionAgentStartAllowListsV1Schema } from '../account/settings/sessionAgentStartAllowListsV1.js';
import { readBuiltInSettingDeclarationV1 } from './settings/settingsDeclarations.js';
import { BUILT_IN_SETTINGS_METADATA_V1 } from './settings/builtInSettingsMetadata.js';
export * from './settings/settingsDeclarations.js';

type CanonicalDeclaration = typeof BUILT_IN_SETTINGS_METADATA_V1[number];
type CanonicalDeclarationByAnchor = {
  [Declaration in CanonicalDeclaration as Declaration['anchor']]: Declaration;
};
function canonicalDeclaration<Anchor extends keyof CanonicalDeclarationByAnchor>(anchor: Anchor): CanonicalDeclarationByAnchor[Anchor] {
  const declaration = BUILT_IN_SETTINGS_METADATA_V1.find(row => row.anchor === anchor);
  if (!declaration) throw new Error(`Undeclared built-in setting: ${anchor}`);
  // The lookup preserves the authored literal declaration selected by the exact anchor.
  return declaration as CanonicalDeclarationByAnchor[Anchor];
}

type SpawnPolicyField = Exclude<keyof SessionAgentSpawnPolicyV1, 'v'>;
function spawnPolicySetting<Field extends SpawnPolicyField>(field: Field) {
  const declaration = canonicalDeclaration(`actions.createSession.${field}`);
  return { ...declaration,
    storage: { ...declaration.storage, field },
    parseValue: (value: unknown) => z.safeParse(SessionAgentSpawnPolicyV1StrictSchema.shape[field], value),
    readValue: (settings: Pick<AccountSettings, 'sessionAgentSpawnPolicyV1'>) => SessionAgentSpawnPolicyV1Schema.parse(settings.sessionAgentSpawnPolicyV1)[field],
    updateValue: (settings: Pick<AccountSettings, 'sessionAgentSpawnPolicyV1'>, value: unknown) =>
      SessionAgentSpawnPolicyV1StrictSchema.parse({ ...SessionAgentSpawnPolicyV1Schema.parse(settings.sessionAgentSpawnPolicyV1), [field]: value }),
  } as const;
}

function startAllowListSetting<Field extends 'allowedRoleIds' | 'allowedAgentTargetKeys'>(field: Field) {
  const declaration = canonicalDeclaration(`actions.createSession.${field}`);
  return { ...declaration,
    storage: { ...declaration.storage, field },
    // Persisted malformed lists recover fail closed; Action writes reject malformed values.
    parseValue: (value: unknown) => SessionAgentStartAllowListsV1Schema.removeCatch().shape[field].removeCatch().safeParse(value),
    readValue: (settings: Pick<AccountSettings, 'sessionAgentStartAllowListsV1'>) => SessionAgentStartAllowListsV1Schema.parse(settings.sessionAgentStartAllowListsV1)[field],
    updateValue: (settings: Pick<AccountSettings, 'sessionAgentStartAllowListsV1'>, value: unknown) =>
      SessionAgentStartAllowListsV1Schema.parse({ ...SessionAgentStartAllowListsV1Schema.parse(settings.sessionAgentStartAllowListsV1), [field]: value }),
  } as const;
}

/** The same nested bindings feed the UI page and replay-safe headless Account mutations. */
export const ACTIONS_SETTING_DECLARATIONS_V1 = {
  allowCustomDirectory: spawnPolicySetting('allowCustomDirectory'),
  allowCrossMachine: spawnPolicySetting('allowCrossMachine'),
  allowBackendTargetOverride: spawnPolicySetting('allowBackendTargetOverride'),
  allowModelOverride: spawnPolicySetting('allowModelOverride'),
  allowPermissionModeOverride: spawnPolicySetting('allowPermissionModeOverride'),
  allowAgentModeOverride: spawnPolicySetting('allowAgentModeOverride'),
  allowConfigOptionOverrides: spawnPolicySetting('allowConfigOptionOverrides'),
  allowProfileOverride: spawnPolicySetting('allowProfileOverride'),
  allowEnvironmentVariables: spawnPolicySetting('allowEnvironmentVariables'),
  allowConnectedServicesOverride: spawnPolicySetting('allowConnectedServicesOverride'),
  allowMcpSelectionOverride: spawnPolicySetting('allowMcpSelectionOverride'),
  allowTranscriptStorageOverride: spawnPolicySetting('allowTranscriptStorageOverride'),
  permissionCeiling: spawnPolicySetting('permissionCeiling'),
  allowedRoleIds: startAllowListSetting('allowedRoleIds'),
  allowedAgentTargetKeys: startAllowListSetting('allowedAgentTargetKeys'),
} as const;

/** Shared Account bindings consumed by the UI declaration and the headless Action host. */
export const DELEGATION_SETTING_DECLARATIONS_V1 = {
  approvalReviewerEnabled: canonicalDeclaration('delegation.approvalReviewerEnabled'),
  workDepthLimit: canonicalDeclaration('delegation.workDepthLimit'),
} as const;

export const ACCOUNT_SETTING_DECLARATIONS_V1 = {
  ...DELEGATION_SETTING_DECLARATIONS_V1,
  ...ACTIONS_SETTING_DECLARATIONS_V1,
  usageCoachPreferences: canonicalDeclaration('usage.coachPreferences'),
  usageModelPrices: canonicalDeclaration('usage.modelPrices'),
  memoryUseInNewSessions: canonicalDeclaration('prompts.context.memoryUseInNewSessions'),
  memoryUseInNewBots: canonicalDeclaration('prompts.context.memoryUseInNewBots'),
  memoryUpkeepInNewBots: canonicalDeclaration('prompts.context.memoryUpkeepInNewBots'),
  transcriptShowToolCalls: canonicalDeclaration('transcript.showToolCalls'),
} as const;

export function readAccountSettingDeclarationV1(anchor: unknown) {
  return Object.values(ACCOUNT_SETTING_DECLARATIONS_V1).find(declaration => declaration.anchor === anchor) ?? null;
}

export function isPresentUserSettingWriteV1(actionId: string, input: unknown): boolean {
  return ['settings.set', 'settings.reset', 'settings.invoke'].includes(actionId) && typeof input === 'object' && input !== null
    && 'anchor' in input && readBuiltInSettingDeclarationV1(input.anchor)?.presentUserOnly === true;
}

/** Human transcript choices never become autonomous preference mutations, even after an approval. */
export function isAccountSettingActionSurfaceAllowedV1(actionId: string, input: unknown, surface: unknown): boolean {
  if (!['settings.set', 'settings.reset', 'settings.invoke'].includes(actionId)) return true;
  if (surface !== 'agent' && surface !== 'mcp') return true;
  if (typeof input !== 'object' || input === null || !('anchor' in input)) return true;
  const declaration = readBuiltInSettingDeclarationV1(input.anchor);
  return declaration?.surfaces?.[surface] !== false;
}
