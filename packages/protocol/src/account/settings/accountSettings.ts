import { z } from 'zod';
import { GlassSurfaceMaterialsSchema } from './glassSurfaceMaterials.js';

import {
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  SessionAgentSpawnPolicyV1Schema,
  SessionAgentSpawnPolicyV1StrictSchema,
  type SessionAgentSpawnPolicyV1,
} from './sessionAgentSpawnPolicyV1.js';
export {
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  SessionAgentSpawnPolicyV1Schema,
  SessionAgentSpawnPolicyV1StrictSchema,
  type SessionAgentSpawnPolicyV1,
  type SessionAgentStartOverridesV1,
} from './sessionAgentSpawnPolicyV1.js';

import { AccountSettingsPersistedObjectSchema } from './accountSettingsPersistedObject.js';
import { LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS } from './legacyAuthoringMemorySettingsV1.js';
import { DEFAULT_SESSION_AGENT_START_ALLOW_LISTS_V1, SessionAgentStartAllowListsV1Schema } from './sessionAgentStartAllowListsV1.js';
export { DEFAULT_SESSION_AGENT_START_ALLOW_LISTS_V1, SessionAgentStartAllowListsV1Schema, type SessionAgentStartAllowListsV1 } from './sessionAgentStartAllowListsV1.js';
import { SessionReminderPresetsV1Schema } from './sessionReminderPresetsV1.js';
import { buildSettingArtifacts } from '../../settings/registry/buildSettingArtifacts.js';
import {
  BackendTargetKeyV2InputSchema,
  buildBackendTargetKeyV2,
  readBackendTargetRefV2,
  type BackendTargetRefV2Input,
} from '../../backends/targets/backendTargetRefV2.js';
import { LlmTaskRunnerConfigV1Schema } from '../../llm/tasks/llmTaskRunnerConfigV1.js';
import { InstallableAutoUpdateModeSchema } from '../../installables/descriptor.js';
import {
  SAVED_SECRET_COLLECTION_MAX_ENTRIES,
  SavedSecretSchema,
} from '../../profiles/backendProfileSchema.js';
import { ExternalSessionsSettingsV1Schema } from '../../sessions/external/followLifecycleV1.js';
import {
  DEFAULT_PLUGIN_UPDATE_REVIEW_MODE_V1,
  PluginUpdateReviewModeV1Schema,
} from '../../marketplace/pluginUpdatePolicyV1.js';
import {
  HappierReplayRecentMessagesCountSchema,
  HappierReplayWritableMaxSeedCharsSchema,
} from '../../sessions/replaySeedBudget.js';
import {
  buildQualifiedPluginContributionKey,
  PluginContributionIdentityV1Schema,
} from '../../plugins/contributionIdentity.js';
import { MAX_PLUGIN_IDENTIFIER_BYTES } from '../../plugins/pluginId.js';

import {
  ActionsSettingsV1Schema,
  tryNormalizeActionsSettingsV1,
  type ActionSettingsOverride,
  type ActionsSettingsV1,
} from '../../actions/actionSettings.js';
import { AcpCatalogSettingsV1Schema } from '../../acp/catalog/settingsV1.js';
import {
  CodingPromptBehaviorV1Schema,
  DEFAULT_CODING_PROMPT_BEHAVIOR_V1,
} from '../../prompts/codingPromptBehaviorV1.js';
import { ContextSelectionsV1Schema } from '../../prompts/library/contextSelectionsV1.js';
import { RolesV1Schema } from './rolesV1.js';
import { PromptExternalLinksV1Schema } from '../../prompts/library/promptExternalLinksV1.js';
import { PromptFoldersV1Schema } from '../../prompts/library/promptFoldersV1.js';
import { PromptInvocationsV1Schema } from '../../prompts/library/promptInvocationsV1.js';
import { PromptRegistrySourcesV1Schema } from '../../prompts/library/promptRegistriesV1.js';
import { PromptStacksV1Schema } from '../../prompts/library/promptStacksV1.js';
import {
  BuiltInLegacyConnectedServicesDefaultAuthByAgentIdV1IngressSchema,
  ConnectedServicesProviderStateSharingSettingsV1Schema,
  DEFAULT_CONNECTED_ACCOUNT_PURPOSE_BINDINGS_V1,
  DEFAULT_CONNECTED_SERVICES_DEFAULT_AUTH_BY_AGENT_ID_V1,
  DEFAULT_CONNECTED_SERVICES_PROVIDER_STATE_SHARING_SETTINGS_V1,
  type ConnectedServicesDefaultAuthByAgentIdV1,
  type ConnectedServicesProviderStateSharingSettingsV1,
} from './connectedServicesSettings.js';
import { QualifiedConnectedAccountPurposeBindingsV1Schema } from '../../connect/connectedAccountPurposeBindings.js';
import { WorkspaceRefV1Schema } from '../../workspaces/workspaceRefV1.js';
import { deriveWorkspaceSyncTopology } from '../../workspaces/workspaceSyncTopology.js';
import {
  WorkspaceSyncRelationshipV1Schema,
  areWorkspaceSyncRelationshipDefinitionsEqual,
} from '../../sessions/control/handoff/workspaceSyncSchemas.js';
import { normalizeSessionHandoffWorkspaceRootPath } from '../../sessions/control/handoff/workspaceTransferSourcePathSafety.js';
import {
  AttentionDeliveryPolicyV1Schema,
  DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
  type AttentionDeliveryPolicyV1,
  type AttentionDeliveryDecision,
  type ResolveAttentionDeliveryPolicyDecisionParams,
} from './attentionDeliveryPolicy.js';
import { resolveAttentionDeliveryPolicyDecision } from './attentionDeliveryPolicyDecision.js';
import { deriveAttentionDeliveryPolicyFromLegacySettings } from './attentionDeliveryPolicyLegacy.js';
import { ConnectedAccountServiceConfigurationsV1Schema } from './connectedAccountServiceConfigurationsV1.js';
import {
  DEFAULT_PEER_MEDIATION_PREFERENCES_V1,
  PeerMediationPreferencesV1Schema,
  type PeerMediationPreferencesV1,
} from './peerMediationPreferencesV1.js';
import {
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  NotificationChannelsV1Schema,
  deriveExpoPushNotificationChannelFromLegacySettings,
  type NotificationChannelV1,
  type NotificationChannelsV1,
} from './notificationChannels.js';
import {
  DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
  SessionPendingQueueDeliveryTimingSchema,
} from './sessionPendingQueueDeliveryTiming.js';
import { SESSION_PERMISSION_MODES } from '../../sessions/metadata/sessionPermissionModes.js';
import {
  DEFAULT_MACHINE_ADMINISTRATION_SELECTIONS_V1,
  MachineAdministrationSelectionsV1Schema,
} from './machineAdministrationSelectionsV1.js';
import {
  DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1,
  WorkspaceFileViewerPreferencesV1Schema,
} from './workspaceFileViewerPreferencesV1.js';
import {
  ACCOUNT_SETTINGS_MAX_PROVIDER_SUBTREE_BYTES,
  ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES,
  ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES,
  inspectAccountSettingValueBounds,
  withAccountSettingBounds,
  type AccountSettingStructuralBoundsOwner,
} from './catalog/accountSettingBounds.js';
import {
  defineAccountSettingDefinitions,
  type AccountSettingClassification,
} from './catalog/accountSettingDefinition.js';
import {
  BoundedLegacyJsonValueSchema,
  ProviderSettingsLegacySubtreeV1Schema,
} from './catalog/legacyJson.js';
import { ClientEncryptionRequirementSchema } from '../../encryption/clientEncryptionRequirement.js';

export { AccountSettingsPersistedObjectSchema } from './accountSettingsPersistedObject.js';
export type { AccountSettingsPersistedObject } from './accountSettingsPersistedObject.js';
export {
  DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
  SESSION_PENDING_QUEUE_DELIVERY_TIMINGS,
  SessionPendingQueueDeliveryTimingSchema,
  type SessionPendingQueueDeliveryTiming,
} from './sessionPendingQueueDeliveryTiming.js';

function rekeyLegacyBuiltInAgentMap<T>(
  raw: unknown,
  isValue: (value: unknown) => value is T,
): Record<string, T> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries: Array<[string, T]> = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = key.trim();
    if (normalizedKey.length === 0 || !isValue(value)) continue;
    entries.push([`agent:${normalizedKey}`, value]);
  }
  return Object.fromEntries(entries);
}

export const ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION = 7;

export const ForegroundBehaviorSchema = z.enum(['full', 'silent', 'off']);
export type ForegroundBehavior = z.infer<typeof ForegroundBehaviorSchema>;

function normalizeNotificationsSettingsV1Input(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (
    !Object.prototype.hasOwnProperty.call(record, 'connectedServiceQuotaRecovered')
    && record.connectedServiceQuotaBlocked === false
  ) {
    return {
      ...record,
      connectedServiceQuotaRecovered: false,
    };
  }
  return raw;
}

export const NotificationsSettingsV1Schema = z
  .preprocess(
    normalizeNotificationsSettingsV1Input,
    z.object({
      v: z.literal(1).default(1),
      pushEnabled: z.boolean().default(true),
      mutePhoneWhenComputerFocused: z.boolean().optional().catch(undefined),
      ready: z.boolean().default(true),
      readyIncludeMessageText: z.boolean().default(true),
      requestIncludeMessageText: z.boolean().default(true),
      permissionRequest: z.boolean().default(true),
      userActionRequest: z.boolean().default(true),
      connectedServiceAccountSwitch: z.boolean().default(true),
      connectedServiceQuotaBlocked: z.boolean().default(true),
      connectedServiceQuotaRecovered: z.boolean().default(true),
      foregroundBehavior: ForegroundBehaviorSchema.default('full'),
    }),
  )
  .catch({
    v: 1,
    pushEnabled: true,
    ready: true,
    readyIncludeMessageText: true,
    requestIncludeMessageText: true,
    permissionRequest: true,
    userActionRequest: true,
    connectedServiceAccountSwitch: true,
    connectedServiceQuotaBlocked: true,
    connectedServiceQuotaRecovered: true,
    foregroundBehavior: 'full',
  });

export type NotificationsSettingsV1 = z.infer<typeof NotificationsSettingsV1Schema>;

export const DEFAULT_NOTIFICATIONS_SETTINGS_V1: NotificationsSettingsV1 = NotificationsSettingsV1Schema.parse({});

export const DEFAULT_ACTIONS_SETTINGS_V1: ActionsSettingsV1 = ActionsSettingsV1Schema.parse({
  v: 1,
  actions: {
    // Agent-surface coordination is enabled by default; destructive or human-decision
    // actions stay opt-in as a product courtesy.
    'session.stop': { disabledSurfaces: ['agent'] },
    'session.archive': { disabledSurfaces: ['agent'] },
    'session.unarchive': { disabledSurfaces: ['agent'] },
    'session.usageLimit.consumeResetCredit': { disabledSurfaces: ['agent'] },
    'session.permission.respond': { disabledSurfaces: ['agent'] },
    'session.user_action.answer': { disabledSurfaces: ['agent'] },
  },
});

const CURRENT_DEFAULT_SESSION_AGENT_DISABLED_ACTION_IDS_V1 = Object.freeze([
  'session.stop',
  'session.archive',
  'session.unarchive',
  'session.usageLimit.consumeResetCredit',
  'session.permission.respond',
  'session.user_action.answer',
] as const satisfies readonly string[]);

const CURRENT_DEFAULT_SESSION_AGENT_DISABLED_ACTION_ID_SET_V1 = new Set<string>(
  CURRENT_DEFAULT_SESSION_AGENT_DISABLED_ACTION_IDS_V1,
);

export const UsageLimitRecoverySettingsV1Schema = z
  .object({
    v: z.literal(1).default(1),
    mode: z.enum(['ask', 'auto_wait']).default('ask'),
    promptMode: z.literal('standard').default('standard'),
    resumePromptMode: z.enum(['standard', 'off', 'custom']).default('standard'),
    /**
     * Account-level custom resume prompt text; only meaningful when
     * `resumePromptMode === 'custom'`. Empty/missing text fails safe to the
     * standard prompt (never silently off).
     */
    customResumePrompt: z.string().trim().max(2000).optional(),
  })
  .strict()
  .catch({
    v: 1,
    mode: 'ask',
    promptMode: 'standard',
    resumePromptMode: 'standard',
  });

export type UsageLimitRecoverySettingsV1 = z.infer<typeof UsageLimitRecoverySettingsV1Schema>;

export const DEFAULT_USAGE_LIMIT_RECOVERY_SETTINGS_V1: UsageLimitRecoverySettingsV1 = UsageLimitRecoverySettingsV1Schema.parse({});

export const SESSION_PENDING_QUEUE_DRAIN_MODES = ['one_at_a_time', 'drain_all'] as const;
export const DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE = 'one_at_a_time' as const;
export const SESSION_INACTIVE_RESUME_POLICY_VALUES = ['when_available', 'online_only', 'manual'] as const;
export const DEFAULT_SESSION_INACTIVE_RESUME_POLICY = 'online_only' as const;
export const SessionInactiveResumePolicySchema = z
  .enum(SESSION_INACTIVE_RESUME_POLICY_VALUES)
  .catch(DEFAULT_SESSION_INACTIVE_RESUME_POLICY);
export type SessionInactiveResumePolicy = z.infer<typeof SessionInactiveResumePolicySchema>;
export const SessionPendingQueueDrainModeSchema = z
  .enum(SESSION_PENDING_QUEUE_DRAIN_MODES)
  .catch(DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE);
export type SessionPendingQueueDrainMode = z.infer<typeof SessionPendingQueueDrainModeSchema>;

const LEGACY_DEFAULT_SESSION_AGENT_DISABLED_ACTION_IDS_V1 = Object.freeze([
  'session.stop',
  'session.title.set',
  'session.permission_mode.set',
  'session.model.set',
  'session.archive',
  'session.unarchive',
  'session.status.get',
  'session.history.get',
  'session.wait.idle',
  'session.message.send',
  'session.permission.respond',
  'session.user_action.answer',
  'session.mode.set',
  'session.list',
  'session.activity.get',
  'session.messages.recent.get',
] as const satisfies readonly string[]);

const LEGACY_DEFAULT_SESSION_AGENT_DISABLED_ACTION_ID_SET_V1 = new Set<string>(
  LEGACY_DEFAULT_SESSION_AGENT_DISABLED_ACTION_IDS_V1,
);

function isLegacyDefaultSessionAgentActionLockdownV1(settings: ActionsSettingsV1): boolean {
  const known = new Set<string>(LEGACY_DEFAULT_SESSION_AGENT_DISABLED_ACTION_IDS_V1);
  const actions: Partial<Record<string, ActionSettingsOverride>> = settings.actions;
  const keys = Object.keys(actions);
  if (keys.length !== LEGACY_DEFAULT_SESSION_AGENT_DISABLED_ACTION_IDS_V1.length) return false;

  for (const key of keys) {
    if (!known.has(key)) return false;
    const override = actions[key];
    if (!override || typeof override !== 'object' || Array.isArray(override)) return false;
    if (override.enabled === false) return false;
    const disabledSurfaces = Array.isArray(override.disabledSurfaces) ? override.disabledSurfaces : [];
    if (disabledSurfaces.length !== 1 || disabledSurfaces[0] !== 'agent') return false;
    const enabledPlacements = Array.isArray(override.enabledPlacements) ? override.enabledPlacements : [];
    if (enabledPlacements.length > 0) return false;
    const disabledPlacements = Array.isArray(override.disabledPlacements) ? override.disabledPlacements : [];
    if (disabledPlacements.length > 0) return false;
    const approvalRequiredSurfaces = Array.isArray(override.approvalRequiredSurfaces)
      ? override.approvalRequiredSurfaces
      : [];
    if (approvalRequiredSurfaces.length > 0) return false;
    const toolExposureModes = override.toolExposureModes && typeof override.toolExposureModes === 'object'
      ? Object.keys(override.toolExposureModes)
      : [];
    if (toolExposureModes.length > 0) return false;
  }
  return true;
}

function hasOnlyEmptyActionSettingsFieldsV1(override: Readonly<Record<string, unknown>>): boolean {
  const enabledPlacements = Array.isArray(override.enabledPlacements) ? override.enabledPlacements : [];
  const disabledSurfaces = Array.isArray(override.disabledSurfaces) ? override.disabledSurfaces : [];
  const disabledPlacements = Array.isArray(override.disabledPlacements) ? override.disabledPlacements : [];
  const approvalRequiredSurfaces = Array.isArray(override.approvalRequiredSurfaces)
    ? override.approvalRequiredSurfaces
    : [];
  const toolExposureModes = override.toolExposureModes && typeof override.toolExposureModes === 'object'
    ? override.toolExposureModes
    : {};
  return (
    override.enabled !== false &&
    disabledSurfaces.length === 0 &&
    enabledPlacements.length === 0 &&
    disabledPlacements.length === 0 &&
    approvalRequiredSurfaces.length === 0 &&
    Object.keys(toolExposureModes).length === 0
  );
}

function migrateLegacyDefaultActionsSettingsV1(settings: ActionsSettingsV1): ActionsSettingsV1 {
  const actions: Partial<Record<string, ActionSettingsOverride>> = { ...settings.actions };
  let changed = false;

  const shouldMigrateAllLegacyDefaults = isLegacyDefaultSessionAgentActionLockdownV1(settings);
  for (const id of Object.keys(actions)) {
    if (!shouldMigrateAllLegacyDefaults && !LEGACY_DEFAULT_SESSION_AGENT_DISABLED_ACTION_ID_SET_V1.has(id)) continue;
    if (CURRENT_DEFAULT_SESSION_AGENT_DISABLED_ACTION_ID_SET_V1.has(id)) continue;
    const existing = actions[id];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      delete actions[id];
      changed = true;
      continue;
    }

    const previousDisabledSurfaces = Array.isArray(existing.disabledSurfaces) ? existing.disabledSurfaces : [];
    const disabledSurfaces = previousDisabledSurfaces.filter((surface: unknown) => surface !== 'agent');
    if (disabledSurfaces.length === previousDisabledSurfaces.length) continue;

    changed = true;
    const next = {
      ...existing,
      disabledSurfaces,
    };
    if (hasOnlyEmptyActionSettingsFieldsV1(next as Record<string, unknown>)) {
      delete actions[id];
    } else {
      actions[id] = next;
    }
  }

  if (shouldMigrateAllLegacyDefaults) {
    for (const id of CURRENT_DEFAULT_SESSION_AGENT_DISABLED_ACTION_IDS_V1) {
      if (actions[id]) continue;
      const defaultOverride = DEFAULT_ACTIONS_SETTINGS_V1.actions[id as keyof typeof DEFAULT_ACTIONS_SETTINGS_V1.actions];
      if (!defaultOverride) continue;
      actions[id] = defaultOverride;
      changed = true;
    }
  }

  return changed ? { ...settings, actions: actions as ActionsSettingsV1['actions'] } : settings;
}

const BackendEnabledByTargetKeySchema = z.record(BackendTargetKeyV2InputSchema, z.boolean()).catch({});
const FeatureTogglesSchema = withAccountSettingBounds(
  z.record(z.string().max(256), z.boolean()),
  16 * 1024,
).catch({}).default({});
const BackendCliSourcePreferenceSchema = z.enum(['system-first', 'managed-first']);
const BackendCliSourcePreferenceByTargetKeySchema = z
  .record(BackendTargetKeyV2InputSchema, BackendCliSourcePreferenceSchema)
  .catch({});

/**
 * Root keys that can never name a settings root, however they arrived in a raw
 * persisted document. Exported beside the retired-root guard so every raw
 * restore/normalize corridor rejects them through this one owner.
 */
export const UNSAFE_ACCOUNT_SETTINGS_ROOT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Root keys that formerly participated in the Account blob but no longer have a
 * current persistence owner. Keep this classification beside the canonical
 * parser: a passthrough boundary preserves supported future roots, not retired
 * roots that current writers must never reintroduce.
 */
export const RETIRED_ACCOUNT_SETTINGS_SESSION_ONLY_KEYS = Object.freeze([
  'toolViewDetailLevelDefaultActivityFeed',
  'toolViewExpandedDetailLevelDefaultActivityFeed',
  'toolViewCardDensity',
] as const);

export const RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS = Object.freeze([
  'pinnedSessionKeysV1',
  'workspaceLabelsV1',
  'collapsedGroupKeysV1',
  'sessionTagsV1',
  'sessionListGroupOrderV1',
  'sessionWorkspaceOrderV1',
  'sessionFoldersV1',
] as const);

export const RETIRED_ACCOUNT_SETTINGS_ROOT_KEYS = Object.freeze([
  ...RETIRED_ACCOUNT_SETTINGS_SESSION_ONLY_KEYS,
  ...RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS,
  'defaultPermissionModeClaude',
  'defaultPermissionModeCodex',
  'defaultPermissionModeGemini',
  'experimentalAgents',
  'expCodexResume',
  'expCodexAcp',
  'codexResumeInstallSpec',
  'expVoiceAuthFlow',
  'codexAcpInstallSpec',
  'expUsageReporting',
  'expFileViewer',
  'expScmOperations',
  'expShowThinkingMessages',
  'expSessionType',
  'expAutomations',
  'expZen',
  'expInboxFriends',
  'experimentalFeatureToggles',
  'sessionMruOrderV1',
  'transcriptMessageTimestampsEnabled',
  'showEnvironmentBadge',
  'homeHubLayoutV1',
] as const);

const RETIRED_ACCOUNT_SETTINGS_ROOT_KEY_SET = new Set<string>(RETIRED_ACCOUNT_SETTINGS_ROOT_KEYS);

export function isRetiredAccountSettingsRootKey(key: string): boolean {
  if (RETIRED_ACCOUNT_SETTINGS_ROOT_KEY_SET.has(key)) return true;
  if (key.startsWith('multiServer')) return true;
  return key.startsWith('activeServerTarget') && (key.endsWith('Kind') || key.endsWith('Id'));
}

function readSafeAccountSettingsRoot(raw: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (UNSAFE_ACCOUNT_SETTINGS_ROOT_KEYS.has(key)) continue;
    if (isRetiredAccountSettingsRootKey(key)) continue;
    Object.defineProperty(safe, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return safe;
}

export function clearRetainedMachineTerminalHostAliases(raw: Record<string, unknown>): void {
  const legacyMap = raw.sessionTmuxByMachineId;
  if (!legacyMap || typeof legacyMap !== 'object' || Array.isArray(legacyMap)) return;
  // Resetting the additive preference must also remove its retained development
  // source. Keep the released tmux record and every unrecognized neighbor intact.
  raw.sessionTmuxByMachineId = Object.fromEntries(Object.entries(legacyMap).map(([machineId, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [machineId, value];
    const { terminalHost: _retiredDevelopmentHost, ...override } = value as Record<string, unknown>;
    return [machineId, override];
  }));
}

function backfillLegacyTargetKeyedAccountSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const source = readSafeAccountSettingsRoot(raw);
  const next = { ...source };

  // Normalize retained development-only nested terminal hosts at the persisted
  // boundary. Released UIs preserve the additive root when echoing their tmux map.
  if (!Object.prototype.hasOwnProperty.call(source, 'sessionTerminalHostByMachineId')) {
    const legacyMap = source.sessionTmuxByMachineId;
    if (legacyMap && typeof legacyMap === 'object' && !Array.isArray(legacyMap)) {
      next.sessionTerminalHostByMachineId = Object.fromEntries(
        Object.entries(legacyMap).flatMap(([machineId, value]) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const host = (value as Record<string, unknown>).terminalHost;
          return host === 'herdr' || host === 'zellij' ? [[machineId, host]] : [];
        }),
      );
    }
  }

  if (next.backendEnabledByTargetKey === undefined && source.backendEnabledById !== undefined) {
    next.backendEnabledByTargetKey = rekeyLegacyBuiltInAgentMap(
      source.backendEnabledById,
      (value): value is boolean => typeof value === 'boolean',
    );
  }

  if (next.backendCliSourcePreferenceByTargetKey === undefined && source.backendCliSourcePreferenceById !== undefined) {
    next.backendCliSourcePreferenceByTargetKey = rekeyLegacyBuiltInAgentMap(
      source.backendCliSourcePreferenceById,
      (value): value is 'system-first' | 'managed-first' => value === 'system-first' || value === 'managed-first',
    );
  }

  if (next.notificationChannelsV1 !== undefined) {
    const parsedChannels = NotificationChannelsV1Schema.safeParse(next.notificationChannelsV1);
    if (parsedChannels.success) {
      next.notificationChannelsV1 = parsedChannels.data;
    } else {
      next.notificationChannelsV1 = undefined;
    }
  }

  if (next.notificationChannelsV1 === undefined) {
    next.notificationChannelsV1 = [
      deriveExpoPushNotificationChannelFromLegacySettings(
        NotificationsSettingsV1Schema.parse(source.notificationsSettingsV1),
      ),
    ];
  }

  const parsedAttentionDeliveryPolicy = next.attentionDeliveryPolicyV1 === undefined
    ? null
    : AttentionDeliveryPolicyV1Schema.safeParse(next.attentionDeliveryPolicyV1);
  if (parsedAttentionDeliveryPolicy?.success === true) {
    next.attentionDeliveryPolicyV1 = parsedAttentionDeliveryPolicy.data;
    if (!Object.prototype.hasOwnProperty.call(next.attentionDeliveryPolicyV1, 'mutePhoneWhenComputerFocused')
      && !Object.prototype.hasOwnProperty.call(source.attentionDeliveryPolicyV1, 'mutePhoneWhenComputerFocused')) {
      const predecessor = NotificationsSettingsV1Schema.safeParse(source.notificationsSettingsV1);
      if (predecessor.success && predecessor.data.mutePhoneWhenComputerFocused === true) {
        next.attentionDeliveryPolicyV1 = { ...parsedAttentionDeliveryPolicy.data, mutePhoneWhenComputerFocused: true };
      }
    }
  }

  if (next.attentionDeliveryPolicyV1 === undefined || parsedAttentionDeliveryPolicy?.success === false) {
    next.attentionDeliveryPolicyV1 = deriveAttentionDeliveryPolicyFromLegacySettings({
      notificationsSettings: NotificationsSettingsV1Schema.parse(source.notificationsSettingsV1),
      notificationChannels: NotificationChannelsV1Schema.parse(next.notificationChannelsV1),
    });
  }

  if (next.actionsSettingsV1 && typeof next.actionsSettingsV1 === 'object' && !Array.isArray(next.actionsSettingsV1)) {
    const parsed = tryNormalizeActionsSettingsV1(next.actionsSettingsV1);
    if (parsed) {
      next.actionsSettingsV1 = migrateLegacyDefaultActionsSettingsV1(parsed);
    }
  }

  return next;
}

type AccountCatalogDefinitionOptions = Readonly<{
  semanticDomain: string;
  classification: AccountSettingClassification;
  maximumSerializedValueBytes: number;
  /**
   * Defaults to the Account document's generic node/entry/depth policy. Set to
   * `domainOwned` only when a named domain schema is the cardinality authority for
   * the whole subtree; the Account byte ceiling above still applies.
   */
  structuralBoundsOwner?: AccountSettingStructuralBoundsOwner;
  compatibility?: Readonly<{ provenance: string; removalCondition: string }>;
  /** Present malformed authority-bearing values must fail instead of recovering to a default. */
  recoverMalformed?: boolean;
}>;

/**
 * Why the catalog refused a value. The definition owner already knows this from
 * the bound inspector's typed reason and from Zod's issue code, so it reports
 * the classification directly instead of leaving callers to recover it by
 * matching refusal wording — a coupling that silently degrades every size
 * refusal to `invalidValue` the moment a message is reworded.
 */
export type AccountSettingValueRefusalReason = 'tooLarge' | 'tooDeep' | 'invalidValue';

function classifyAccountSettingSchemaIssues(
  issues: readonly Readonly<{ code: string }>[],
): AccountSettingValueRefusalReason {
  return issues.some((issue) => issue.code === 'too_big') ? 'tooLarge' : 'invalidValue';
}

export type AccountSettingValueParseResult =
  | Readonly<{ success: true; data: unknown }>
  | Readonly<{
    success: false;
    issues: readonly string[];
    reason: AccountSettingValueRefusalReason;
  }>;

function parseAccountSettingMutationValue(
  schema: z.core.$ZodType,
  value: unknown,
): AccountSettingValueParseResult {
  if (schema instanceof z.ZodCatch) {
    return parseAccountSettingMutationValue(schema.removeCatch(), value);
  }
  if (schema instanceof z.ZodDefault) {
    return parseAccountSettingMutationValue(schema.removeDefault(), value);
  }
  const parsed = z.safeParse(schema, value);
  return parsed.success
    ? { success: true, data: parsed.data }
    : {
      success: false,
      issues: parsed.error.issues.map((issue) => issue.message),
      reason: classifyAccountSettingSchemaIssues(parsed.error.issues),
    };
}

export function accountCatalogDefinition<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  defaultValue: z.input<TSchema>,
  options: AccountCatalogDefinitionOptions,
) {
  const structuralBoundsOwner = options.structuralBoundsOwner ?? 'accountGeneric';
  const boundedSchema = withAccountSettingBounds(
    schema,
    options.maximumSerializedValueBytes,
    structuralBoundsOwner,
  );
  const parsedDefault = boundedSchema.parse(defaultValue);
  const presentValueSchema = (options.recoverMalformed === false
    ? boundedSchema
    : boundedSchema.catch(parsedDefault)) as typeof boundedSchema;
  const missingValueDefaultSchema = z.undefined().transform(() => parsedDefault);
  const parseMutationValue = (value: unknown): AccountSettingValueParseResult => {
    const boundIssue = inspectAccountSettingValueBounds(
      value,
      options.maximumSerializedValueBytes,
      structuralBoundsOwner,
    );
    return boundIssue
      ? { success: false, issues: [boundIssue.message], reason: boundIssue.reason }
      : parseAccountSettingMutationValue(schema, value);
  };
  return {
    // Preserve Zod `.default(...)` semantics: a parsed transform result is returned as-is for
    // missing input. Definitions may opt out of malformed-value recovery when their value is
    // authoritative state that must never be reinterpreted as the default.
    schema: missingValueDefaultSchema.or(presentValueSchema),
    parseMutationValue,
    default: parsedDefault,
    description: `Account ${options.semanticDomain} setting`,
    storageScope: 'account' as const,
    semanticDomain: options.semanticDomain,
    classification: options.classification,
    maximumSerializedValueBytes: options.maximumSerializedValueBytes,
    structuralBoundsOwner,
    ...(options.compatibility ? { compatibility: options.compatibility } : {}),
  };
}

const LEGACY_COMPATIBILITY = Object.freeze({
  provenance: 'Pre-PEP Account Settings root retained while its named domain destination is not activated.',
  removalCondition: 'Remove only after the named domain activates its approved SET-08 transfer.',
});

function accountPreference<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  defaultValue: z.input<TSchema>,
  semanticDomain: string,
  maximumSerializedValueBytes = 4 * 1024,
) {
  return accountCatalogDefinition(schema, defaultValue, {
    semanticDomain,
    classification: 'preference',
    maximumSerializedValueBytes,
  });
}

function accountPolicy<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  defaultValue: z.input<TSchema>,
  semanticDomain: string,
  maximumSerializedValueBytes = 4 * 1024,
) {
  return accountCatalogDefinition(schema, defaultValue, {
    semanticDomain,
    classification: 'policy',
    maximumSerializedValueBytes,
  });
}

function accountLegacy<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  defaultValue: z.input<TSchema>,
  semanticDomain: string,
  maximumSerializedValueBytes = 64 * 1024,
  recoverMalformed = true,
) {
  return accountCatalogDefinition(schema, defaultValue, {
    semanticDomain,
    classification: 'legacy',
    maximumSerializedValueBytes,
    compatibility: LEGACY_COMPATIBILITY,
    recoverMalformed,
  });
}

const ACCOUNT_SETTING_MAX_NON_NEGATIVE_INTEGER = 2_147_483_647;

function accountNonNegativeInteger(maximum = ACCOUNT_SETTING_MAX_NON_NEGATIVE_INTEGER) {
  return z.number().int().min(0).max(maximum);
}

function accountBoundedString(maximum = 4 * 1024) {
  return z.string().max(maximum);
}

function normalizeScmBackendQualifiedId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;

  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return null;
  const parsed = PluginContributionIdentityV1Schema.safeParse({
    pluginId: trimmed.slice(0, separatorIndex),
    localId: trimmed.slice(separatorIndex + 1),
  });
  return parsed.success ? buildQualifiedPluginContributionKey(parsed.data) : null;
}

const ScmBackendQualifiedIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => normalizeScmBackendQualifiedId(value) === value);

export const TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES = [
  'hover_web_hidden_mobile',
  'hover_web_always_mobile',
  'always',
  'never',
] as const;
export type TranscriptMessageTimestampDisplayMode =
  typeof TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES[number];

export const DEFAULT_TRANSCRIPT_TOOL_CALLS_COLLAPSED_PREVIEW_COUNT = 3;

export const SessionTmuxMachineOverrideSchema = z
  .object({
    useTmux: z.boolean(),
    sessionName: accountBoundedString(256),
    isolated: z.boolean(),
    tmpDir: accountBoundedString(16 * 1024).nullable(),
  })
  .passthrough()
  .transform(({ terminalHost: _retiredDevelopmentHost, ...override }) => override);

const AccountInstallablePolicyOverrideSchema = z
  .object({
    autoInstallWhenNeeded: z.boolean().optional(),
    autoUpdateMode: InstallableAutoUpdateModeSchema.optional(),
  })
  .passthrough();

const AccountInstallablePoliciesByMachineIdSchema = z
  .record(
    accountBoundedString(1024),
    z.record(accountBoundedString(1024), AccountInstallablePolicyOverrideSchema).default({}),
  )
  .default({});

export type SessionHandoffDirectTargetMode = 'keep_direct' | 'convert_to_persisted';

const SESSION_HANDOFF_DEFAULT_KEYS = new Set([
  'v',
  'workspaceSyncMode',
  'workspaceSyncRelationshipId',
  'includeIgnoredMode',
  'ignoredIncludeGlobs',
  'directTargetMode',
]);

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasForbiddenSessionHandoffData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasForbiddenSessionHandoffData);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
    /(?:source|locator|resolved|working.?dir|path|payload|bearer|token|secret)/i.test(key)
    || hasForbiddenSessionHandoffData(child)
  ));
}

const SessionHandoffIgnoredIncludeGlobSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, ctx) => {
    if (utf8ByteLength(value) > 512) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be at most 512 UTF-8 bytes' });
    }
    if (
      value.includes('\u0000')
      || /^(?:[\\/]|~(?:[\\/]|$)|[A-Za-z]:[\\/]|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(value)
      || value.split(/[\\/]+/).includes('..')
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a relative glob' });
    }
  });

export const SessionHandoffDefaultsV1Schema = z
  .object({
    v: z.literal(1).default(1),
    // Keep updated is the recommended first-use outcome. Explicit persisted
    // choices remain authoritative, and relationship identity stays daemon-owned.
    workspaceSyncMode: z
      .enum(['none', 'copy_once', 'keep_synced', 'mirror_exactly', 'keep_both_in_sync'])
      .default('keep_synced'),
    // Reader-only tolerance for pre-A4 UI defaults. The transform deliberately
    // drops this retired UI-owned identity from all canonical writes.
    workspaceSyncRelationshipId: accountBoundedString(256).nullable().optional(),
    includeIgnoredMode: z.enum(['exclude', 'include_selected']).default('exclude'),
    ignoredIncludeGlobs: z.array(SessionHandoffIgnoredIncludeGlobSchema).max(64).superRefine((value, ctx) => {
      if (value.reduce((total, glob) => total + utf8ByteLength(glob), 0) > 16 * 1024) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be at most 16 KiB in aggregate' });
      }
    }).default([]),
    directTargetMode: z.enum(['keep_direct', 'convert_to_persisted']).default('keep_direct'),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const [key, child] of Object.entries(value)) {
      if (SESSION_HANDOFF_DEFAULT_KEYS.has(key)) continue;
      if (hasForbiddenSessionHandoffData({ [key]: child })) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'must not persist source, path, payload, or credential material',
        });
      }
    }
  })
  .transform((value) => ({
    v: 1 as const,
    workspaceSyncMode: value.workspaceSyncMode,
    includeIgnoredMode: value.includeIgnoredMode,
    ignoredIncludeGlobs: value.ignoredIncludeGlobs,
    directTargetMode: value.directTargetMode,
  }));

export type SessionHandoffDefaultsV1 = z.infer<typeof SessionHandoffDefaultsV1Schema>;

export const DEFAULT_SESSION_HANDOFF_DEFAULTS_V1: SessionHandoffDefaultsV1 = Object.freeze({
  v: 1,
  workspaceSyncMode: 'keep_synced',
  includeIgnoredMode: 'exclude',
  ignoredIncludeGlobs: [],
  directTargetMode: 'keep_direct',
});

const ACCOUNT_CORE_CATALOG_DEFINITIONS = {
  analyticsOptOut: accountPreference(z.boolean(), false, 'privacy'),
  crashReportsOptOut: accountPreference(z.boolean(), false, 'privacy'),
  experiments: accountPreference(z.boolean(), false, 'feature choices'),
  useEnhancedSessionWizard: accountPreference(z.boolean(), false, 'session authoring'),
  // Default ON. Replay is the only fork strategy available to an Agent whose
  // provider declares `sessionFork: unsupported` (Claude Code, among others),
  // and the fork gate is `native || replay` — so defaulting this off removed
  // the fork affordance entirely for exactly the sessions this setting exists
  // to serve. The same machinery is already default-on for the in-place Agent
  // switch. A user can still turn it off.
  sessionReplayEnabled: accountPreference(z.boolean(), true, 'session replay'),
  useProfiles: accountPreference(z.boolean(), false, 'profile presentation'),
  sessionPermissionModeApplyTiming: accountPolicy(
    z.enum(['immediate', 'next_prompt']),
    'immediate',
    'permission mediation',
  ),
  sessionUseTmux: accountPreference(z.boolean(), false, 'session terminal defaults'),
  sessionTerminalHost: accountPreference(
    z.enum(['legacy', 'none', 'tmux', 'zellij', 'herdr']),
    'legacy',
    'session terminal defaults',
  ),
  sessionWindowsRemoteSessionLaunchMode: accountPreference(
    z.enum(['hidden', 'windows_terminal', 'console']),
    'hidden',
    'session terminal defaults',
  ),
  sessionWindowsTerminalWindowName: accountPreference(
    z.string().max(256),
    'happier',
    'session terminal defaults',
  ),
  useMachinePickerSearch: accountPreference(z.boolean(), false, 'picker presentation'),
  usePathPickerSearch: accountPreference(z.boolean(), false, 'picker presentation'),
  agentInputEnterToSend: accountPreference(z.boolean(), true, 'composer presentation'),
  agentInputEnterToSendNative: accountPreference(z.boolean(), false, 'composer presentation'),
  alwaysShowContextSize: accountPreference(z.boolean(), false, 'composer presentation'),
  sessionComposerRememberBannerVisibility: accountPreference(z.boolean(), false, 'composer presentation'),
  visualEffectsLevel: accountPreference(z.enum(['full', 'subtle', 'minimal']), 'full', 'motion presentation'),
  contextGaugeStyle: accountPreference(z.enum(['gauge', 'text', 'hidden']), 'gauge', 'composer presentation'),
  animatedNumbers: accountPreference(z.boolean(), true, 'motion presentation'),
  agentInputHistoryScope: accountPreference(z.enum(['perSession', 'global']), 'perSession', 'composer history presentation'),
  agentInputActionBarLayout: accountPreference(z.enum(['auto', 'wrap', 'scroll', 'collapsed']), 'auto', 'composer presentation'),
  agentInputChipDensity: accountPreference(z.enum(['auto', 'labels', 'icons']), 'auto', 'composer presentation'),
  sessionListDensity: accountPreference(
    z.preprocess((raw) => raw === 'compact' ? 'cozy' : raw, z.enum(['detailed', 'cozy', 'narrow'])),
    'narrow',
    'session list presentation',
  ),
  sessionListIdentityDisplay: accountPreference(
    z.enum(['avatar', 'agentLogo', 'none']),
    'agentLogo',
    'session list presentation',
  ),
  sessionHeaderIdentityDisplay: accountPreference(
    z.enum(['avatar', 'agentLogo', 'none']),
    'avatar',
    'session header presentation',
  ),
  sessionListOrderingModeV1: accountPreference(z.enum(['custom', 'created', 'updated']), 'custom', 'session list presentation'),
  sessionListFolderSortModeV1: accountPreference(z.enum(['foldersFirst', 'mixed']), 'foldersFirst', 'session list presentation'),
  sessionListAttentionPromotionModeV1: accountPreference(
    z.enum(['off', 'global', 'withinGroups']),
    'off',
    'session list presentation',
  ),
  sessionListAttentionStandingDefaultV1: accountPreference(
    z.boolean(),
    false,
    'session list presentation',
  ),
  sessionListWorkingPlacementModeV1: accountPreference(
    z.enum(['off', 'global', 'withinGroups']),
    'off',
    'session list presentation',
  ),
  sessionListSeparateBackgroundWorkV1: accountPreference(z.boolean(), false, 'session list presentation'),
  sessionFolderViewModeV1: accountPreference(z.enum(['off', 'tree']), 'off', 'session list presentation'),
  sessionListNarrowWorkingIndicatorStyle: accountPreference(z.enum(['spinner', 'pulse']), 'spinner', 'session list presentation'),
  workspacePathDisplayModeV1: accountPreference(z.enum(['name', 'path']), 'name', 'session list presentation'),
  workspaceFaviconsEnabled: accountPreference(z.boolean(), true, 'session list presentation'),
  workspaceMachineSubtitlesEnabled: accountPreference(z.boolean(), true, 'session list presentation'),
  showFlavorIcons: accountPreference(z.boolean(), true, 'application chrome'),
  avatarStyle: accountPreference(z.enum(['pixelated', 'gradient', 'brutalist']), 'brutalist', 'avatar presentation'),
  hideInactiveSessions: accountPreference(z.boolean(), false, 'session list presentation'),
  groupInactiveSessionsByProject: accountPreference(z.boolean(), false, 'session list presentation'),
  sessionListActiveGroupingV1: accountPreference(z.enum(['project', 'date']), 'project', 'session list presentation'),
  sessionListInactiveGroupingV1: accountPreference(z.enum(['project', 'date']), 'date', 'session list presentation'),
  sessionListSectionModeV1: accountPreference(z.enum(['activity', 'single']), 'single', 'session list presentation'),
  sessionListActiveColorModeV1: accountPreference(
    z.enum(['activityAndAttention', 'attentionOnly', 'allActive']),
    'activityAndAttention',
    'session list presentation',
  ),
  sessionMessageSendMode: accountPolicy(
    z.enum(['agent_queue', 'interrupt', 'server_pending']),
    'server_pending',
    'message delivery',
  ),
  sessionBusySteerSendPolicy: accountPolicy(
    z.enum(['steer_immediately', 'server_pending']),
    'steer_immediately',
    'message delivery',
  ),
  sessionNonSteerableSendPrompt: accountPreference(z.enum(['on', 'off']), 'on', 'message delivery'),
  sessionProviderUsageGaugeMode: accountPreference(z.enum(['auto', 'hidden']), 'auto', 'usage presentation'),
  sessionUsageGaugeLabels: accountPreference(z.boolean(), false, 'usage presentation'),
  sessionProviderUsageGaugeWindowMode: accountPreference(
    z.enum(['most_constrained', 'daily', 'weekly', 'primary', 'secondary', 'session']),
    'most_constrained',
    'usage presentation',
  ),
} as const;

const ACCOUNT_DISPLAY_CATALOG_DEFINITIONS = {
  sessionThinkingDisplayMode: accountPreference(z.enum(['inline', 'tool', 'hidden']), 'inline', 'transcript presentation'),
  sessionThinkingInlinePresentation: accountPreference(z.enum(['full', 'summary']), 'summary', 'transcript presentation'),
  sessionThinkingInlineChrome: accountPreference(z.enum(['plain', 'card']), 'plain', 'transcript presentation'),
  showLineNumbers: accountPreference(z.boolean(), true, 'code presentation'),
  showLineNumbersInToolViews: accountPreference(z.boolean(), false, 'tool presentation'),
  wrapLinesInDiffs: accountPreference(z.boolean(), false, 'code presentation'),
  sessionReplayStrategy: accountPreference(
    z.enum(['recent_messages', 'summary_plus_recent']),
    'recent_messages',
    'session replay',
  ),
  // Bounds come from the one Replay-budget owner. A stored value outside them
  // recovers to the default: a budget below the floor produced no seed at all.
  sessionReplayRecentMessagesCount: accountPreference(HappierReplayRecentMessagesCountSchema, 250, 'session replay'),
  sessionReplayMaxSeedChars: accountPreference(HappierReplayWritableMaxSeedCharsSchema, 120_000, 'session replay'),
  executionRunsGuidanceEnabled: accountPreference(z.boolean(), true, 'execution guidance'),
  executionRunsNotifyParentOnCompletionDefault: accountPreference(z.boolean(), false, 'execution guidance'),
  executionRunsGuidanceMaxChars: accountPreference(z.number().int().min(1).max(64 * 1024), 4_000, 'execution guidance'),
  attachmentsUploadsUploadLocation: accountPreference(z.enum(['workspace', 'os_temp']), 'workspace', 'attachment uploads'),
  attachmentsUploadsWorkspaceRelativeDir: accountPreference(z.string().min(1).max(4 * 1024), '.happier/uploads', 'attachment uploads'),
  attachmentsUploadsVcsIgnoreStrategy: accountPreference(
    z.enum(['git_info_exclude', 'gitignore', 'none']),
    'git_info_exclude',
    'attachment uploads',
  ),
  attachmentsUploadsVcsIgnoreWritesEnabled: accountPreference(z.boolean(), true, 'attachment uploads'),
  attachmentsUploadsMaxFileBytes: accountPolicy(z.number().int().min(1).max(512 * 1024 * 1024), 25 * 1024 * 1024, 'attachment uploads'),
  sessionTagsEnabled: accountPreference(z.boolean(), true, 'session list presentation'),
  sessionListWorkingStatusAnimatedTextEnabled: accountPreference(z.boolean(), true, 'session list presentation'),
  mobileWorkspaceExperienceV1: accountPreference(z.enum(['classic', 'cockpit']), 'cockpit', 'mobile workspace presentation'),
  workspaceTabsSyncEnabled: accountPreference(z.boolean(), true, 'workspace open tabs'),
  sessionCockpitSwipeNavigationEnabled: accountPreference(z.boolean(), true, 'mobile workspace presentation'),
  sessionCockpitSwipeAlwaysSessionsEnabled: accountPreference(z.boolean(), false, 'mobile workspace presentation'),
  sessionCockpitSwipeSource: accountPreference(z.enum(['list', 'recent']), 'list', 'mobile workspace presentation'),
  sessionSwitcherDragUpEnabled: accountPreference(z.boolean(), true, 'mobile workspace presentation'),
  sessionSwitcherDragUpSource: accountPreference(z.enum(['recent', 'list']), 'recent', 'mobile workspace presentation'),
  sessionSwitcherFlickEnabled: accountPreference(z.boolean(), true, 'mobile workspace presentation'),
  sessionSwitcherHoldToDockEnabled: accountPreference(z.boolean(), true, 'mobile workspace presentation'),
  sessionHeaderPullAllTabsEnabled: accountPreference(z.boolean(), true, 'mobile workspace presentation'),
  tabBarGitBadgeMode: accountPreference(z.enum(['changedFiles', 'diffLines', 'off']), 'changedFiles', 'application chrome'),
  tabBarFriendsBadgeEnabled: accountPreference(z.boolean(), true, 'application chrome'),
  tabBarInboxBadgeEnabled: accountPreference(z.boolean(), true, 'application chrome'),
  tabBarSessionsBadgeEnabled: accountPreference(z.boolean(), true, 'application chrome'),
  tabBarOpenTabsBadgeEnabled: accountPreference(z.boolean(), true, 'application chrome'),
  tabBarShowLabels: accountPreference(z.boolean(), false, 'application chrome'),
  tabBarSize: accountPreference(z.enum(['compact', 'regular', 'large']), 'regular', 'application chrome'),
  glassBlurEnabled: accountPreference(z.boolean(), true, 'application chrome'),
  glassBlurIntensity: accountPreference(z.enum(['light', 'regular', 'strong']), 'regular', 'application chrome'),
  glassSurfaceMaterials: accountPreference(GlassSurfaceMaterialsSchema.nullable(), null, 'application chrome'),
  composerSurfaceStyle: accountPreference(z.enum(['standard', 'glass']), 'glass', 'composer presentation'),
} as const;

const BoundedLegacyArraySchema = z.array(BoundedLegacyJsonValueSchema).max(256);
const BoundedLegacyRecordSchema = z.record(z.string().max(64 * 1024), BoundedLegacyJsonValueSchema);

const SavedSecretsSchema = z.preprocess((value) => {
  if (!Array.isArray(value)) return [];

  return value.slice(0, SAVED_SECRET_COLLECTION_MAX_ENTRIES).flatMap((candidate) => {
    const parsed = SavedSecretSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}, z.array(SavedSecretSchema).max(SAVED_SECRET_COLLECTION_MAX_ENTRIES));

const ACCOUNT_LEGACY_ROOT_CATALOG_DEFINITIONS = {
  profiles: accountLegacy(BoundedLegacyArraySchema, [], 'profile entities', 128 * 1024),
  profileEnabledById: accountLegacy(BoundedLegacyRecordSchema, {}, 'profile entity state', 32 * 1024),
  secrets: accountLegacy(
    SavedSecretsSchema,
    [],
    'saved-secret records',
    ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES,
  ),
  secretBindingsByProfileId: accountLegacy(BoundedLegacyRecordSchema, {}, 'profile secret bindings', 32 * 1024),
  connectedAccountServiceConfigurationsV1: accountLegacy(
    ConnectedAccountServiceConfigurationsV1Schema,
    { v: 1, entries: [] },
    'connected account service configurations',
    256 * 1024,
  ),
  mcpServersSettingsV1: accountLegacy(
    BoundedLegacyJsonValueSchema,
    { v: 1, strictMode: false, servers: [], bindings: [] },
    'MCP server entities and bindings',
    128 * 1024,
  ),
  promptStacksV1: accountLegacy(
    PromptStacksV1Schema,
    PromptStacksV1Schema.parse({}),
    'prompt stack entities',
    128 * 1024,
  ),
  rolesV1: accountLegacy(RolesV1Schema, { overrides: {} }, 'role overrides', ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES),
  promptFoldersV1: accountLegacy(
    PromptFoldersV1Schema,
    PromptFoldersV1Schema.parse({ v: 1 }),
    'prompt folder entities',
    64 * 1024,
  ),
  promptInvocationsV1: accountLegacy(
    PromptInvocationsV1Schema,
    PromptInvocationsV1Schema.parse({}),
    'prompt invocation entities',
    128 * 1024,
  ),
  promptExternalLinksV1: accountLegacy(
    PromptExternalLinksV1Schema,
    PromptExternalLinksV1Schema.parse({ v: 1 }),
    'prompt external links',
    64 * 1024,
  ),
  promptRegistrySourcesV1: accountLegacy(
    PromptRegistrySourcesV1Schema,
    PromptRegistrySourcesV1Schema.parse({}),
    'prompt registry sources',
    64 * 1024,
  ),
  contextSelectionsV1: accountLegacy(
    ContextSelectionsV1Schema,
    ContextSelectionsV1Schema.parse({}),
    'prompt context selections',
    64 * 1024,
  ),
  remoteHostsV1: accountLegacy(BoundedLegacyArraySchema, [], 'remote host entities', 128 * 1024),
  acpCatalogSettingsV1: accountLegacy(
    AcpCatalogSettingsV1Schema.catch({ v: 2, backends: [] }).default({ v: 2, backends: [] }),
    { v: 2, backends: [] },
    'configured ACP backends',
    128 * 1024,
  ),
  executionRunsGuidanceEntries: accountLegacy(BoundedLegacyArraySchema, [], 'execution guidance records', 128 * 1024),
  workspaceRefsV1: accountLegacy(
    z.array(WorkspaceRefV1Schema).default([]),
    [],
    'workspace references',
    64 * 1024,
    false,
  ),
  workspaceSyncRelationshipsV1: accountLegacy(
    z.array(WorkspaceSyncRelationshipV1Schema).default([]),
    [],
    'workspace sync relationships',
    128 * 1024,
    false,
  ),
  pinnedWorkspaceRefIdsV1: accountLegacy(z.array(z.string().max(1024)).max(256), [], 'workspace pins', 32 * 1024),
  pinnedSessionKeysV1: accountLegacy(z.array(z.string().max(1024)).max(256), [], 'session organization pins', 32 * 1024),
  workspaceLabelsV1: accountLegacy(BoundedLegacyRecordSchema, {}, 'workspace labels', 32 * 1024),
  sessionTagsV1: accountLegacy(BoundedLegacyRecordSchema, {}, 'session tags', 64 * 1024),
  sessionListGroupOrderV1: accountLegacy(BoundedLegacyRecordSchema, {}, 'session organization ordering', 64 * 1024),
  sessionWorkspaceOrderV1: accountLegacy(BoundedLegacyRecordSchema, {}, 'session organization ordering', 64 * 1024),
  sessionFoldersV1: accountLegacy(BoundedLegacyJsonValueSchema, { v: 1, folders: [] }, 'session folder entities', 128 * 1024),
  notificationChannelsV1: accountLegacy(
    NotificationChannelsV1Schema.default([
      deriveExpoPushNotificationChannelFromLegacySettings(DEFAULT_NOTIFICATIONS_SETTINGS_V1),
    ]),
    [deriveExpoPushNotificationChannelFromLegacySettings(DEFAULT_NOTIFICATIONS_SETTINGS_V1)],
    'notification channel entities',
    64 * 1024,
  ),
  voiceSettingsV1: accountLegacy(BoundedLegacyJsonValueSchema, {}, 'voice configuration', 128 * 1024),
  voice: accountLegacy(BoundedLegacyJsonValueSchema, {}, 'legacy voice configuration', 128 * 1024),
  voiceDiagnosticsV1: accountLegacy(BoundedLegacyJsonValueSchema, {}, 'voice diagnostics', 64 * 1024),
} as const;

const ACCOUNT_CONNECTED_SERVICES_CATALOG_DEFINITIONS = {
  connectedServicesDefaultProfileByServiceId: accountPreference(
    z.record(z.string().max(1024), z.string().max(1024)),
    {},
    'connected service defaults',
    32 * 1024,
  ),
  connectedServicesProfileLabelByKey: accountPreference(
    z.record(z.string().max(1024), z.string().max(4 * 1024)),
    {},
    'connected service presentation',
    64 * 1024,
  ),
  connectedServicesQuotaPinnedMeterIdsByKey: accountPreference(
    z.record(z.string().max(1024), z.array(z.string().max(1024)).max(256)),
    {},
    'connected service presentation',
    64 * 1024,
  ),
  connectedServicesCollapsedItemKeysV1: accountPreference(
    z.record(z.string().max(1024), z.boolean()),
    {},
    'connected service presentation',
    32 * 1024,
  ),
  connectedServicesQuotaSummaryStrategyByKey: accountPreference(
    z.record(z.string().max(1024), z.enum(['primary', 'min_remaining'])),
    {},
    'connected service presentation',
    32 * 1024,
  ),
  connectedServicesDefaultAuthPoolAdoptionDismissedByKey: accountPreference(
    z.record(z.string().max(1024), z.boolean()),
    {},
    'connected service presentation',
    32 * 1024,
  ),
} as const;

const ACCOUNT_SIMPLE_COLLECTION_CATALOG_DEFINITIONS = {
  favoriteDirectories: accountPreference(z.array(z.string().max(16 * 1024)).max(256), [], 'favorite directories', 128 * 1024),
  favoriteMachines: accountPreference(z.array(z.string().max(1024)).max(256), [], 'favorite machines', 32 * 1024),
  favoriteProfiles: accountPreference(z.array(z.string().max(1024)).max(256), [], 'favorite profiles', 32 * 1024),
  favoriteModelSelectionsV1: accountPreference(BoundedLegacyArraySchema, [], 'favorite model selections', 64 * 1024),
  favoriteBackendTargetKeysV1: accountPreference(z.array(z.string().max(1024)).max(256), [], 'favorite backend targets', 32 * 1024),
  dismissedCLIWarnings: accountPreference(
    z.object({
      perMachine: z.record(z.string().max(1024), z.record(z.string().max(1024), z.boolean())),
      global: z.record(z.string().max(1024), z.boolean()),
    }).strict(),
    { perMachine: {}, global: {} },
    'dismissed warnings',
    64 * 1024,
  ),
} as const;

const KeyboardShortcutRuleSchema = z.object({
  binding: z.string().trim().min(1).max(256),
  platforms: z.array(z.enum(['macos', 'ios', 'windows', 'linux', 'android', 'web'])).max(6).optional(),
  blockedSurfaces: z.array(z.enum(['native', 'web'])).max(2).optional(),
  allowInEditable: z.boolean().optional(),
  nativeConsumable: z.boolean().optional(),
  conflictScope: z.string().trim().min(1).max(256).optional(),
});

const KeyboardShortcutCommandIdSchema = z.string().trim().min(1).max(256);

const KeyboardShortcutOverridesSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const normalized: Record<string, unknown> = {};
  for (const [rawCommandId, rawRules] of Object.entries(value).slice(0, 256)) {
    const commandId = KeyboardShortcutCommandIdSchema.safeParse(rawCommandId);
    if (!commandId.success || !Array.isArray(rawRules)) continue;

    const rules = rawRules.slice(0, 32).flatMap((candidate) => {
      const parsed = KeyboardShortcutRuleSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });
    if (rules.length === 0) continue;

    Object.defineProperty(normalized, commandId.data, {
      value: rules,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return normalized;
}, z.record(
  KeyboardShortcutCommandIdSchema,
  z.array(KeyboardShortcutRuleSchema).min(1).max(32),
));

const KeyboardShortcutDisabledCommandIdsSchema = z.preprocess((value) => {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 256).flatMap((candidate) => {
    const parsed = KeyboardShortcutCommandIdSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}, z.array(KeyboardShortcutCommandIdSchema).max(256));

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

export const NEW_SESSION_PRESENTATION_MODES = [
  'auto',
  'screen',
  'modal',
] as const;

export const NEW_SESSION_DRAFT_ENTRY_MODES = [
  'resumePrevious',
  'alwaysFresh',
] as const;

export type NewSessionWizardSelectionSectionId = typeof NEW_SESSION_WIZARD_SELECTION_SECTION_IDS[number];
export type NewSessionWizardSectionPresentation = typeof NEW_SESSION_WIZARD_SECTION_PRESENTATIONS[number];
export type NewSessionPresentationModeV1 = typeof NEW_SESSION_PRESENTATION_MODES[number];
export type NewSessionDraftEntryMode = typeof NEW_SESSION_DRAFT_ENTRY_MODES[number];

const NewSessionWizardSectionIdSchema = z.enum(NEW_SESSION_WIZARD_SELECTION_SECTION_IDS);
const NewSessionWizardSectionPresentationSchema = z.enum(NEW_SESSION_WIZARD_SECTION_PRESENTATIONS);

export function resolveNewSessionWizardSectionPresentation(
  setting: Partial<Record<NewSessionWizardSelectionSectionId, NewSessionWizardSectionPresentation>> | null | undefined,
  sectionId: NewSessionWizardSelectionSectionId,
): NewSessionWizardSectionPresentation {
  return setting?.[sectionId] ?? 'auto';
}

const NewSessionWizardSectionPresentationByIdSchema = z.preprocess((value) => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  return Object.fromEntries(
    Object.entries(record).flatMap(([sectionId, presentation]) => {
      if (!NewSessionWizardSectionIdSchema.safeParse(sectionId).success) return [];
      if (!NewSessionWizardSectionPresentationSchema.safeParse(presentation).success) return [];
      return [[sectionId, presentation]];
    }),
  );
}, z.partialRecord(
  NewSessionWizardSectionIdSchema,
  NewSessionWizardSectionPresentationSchema,
).default({}));

const ACCOUNT_SESSION_AUTHORING_CATALOG_DEFINITIONS = {
  sessionDefaultPermissionModeByTargetKey: accountPolicy(
    z.record(BackendTargetKeyV2InputSchema, z.enum(SESSION_PERMISSION_MODES)),
    {},
    'default permission mode',
    32 * 1024,
  ),
  newSessionDefaultPersistenceModeV1: accountPreference(
    z.enum(['direct', 'persisted']),
    'persisted',
    'session authoring',
  ),
  newSessionDefaultPersistenceModeByTargetKeyV1: accountPreference(
    z.record(BackendTargetKeyV2InputSchema, z.enum(['direct', 'persisted'])),
    {},
    'session authoring',
    32 * 1024,
  ),
  newSessionDraftEntryMode: accountPreference(
    z.enum(NEW_SESSION_DRAFT_ENTRY_MODES),
    'resumePrevious',
    'session authoring',
  ),
  rememberLastProjectSessionSelections: accountPreference(z.boolean(), true, 'session authoring'),
  rememberLastEngineSelectionsV1: accountPreference(z.boolean(), true, 'session authoring'),
  newSessionPresentationModeV1: accountPreference(z.enum(NEW_SESSION_PRESENTATION_MODES), 'auto', 'session authoring'),
  newSessionWizardSectionPresentationV1: accountPreference(
    NewSessionWizardSectionPresentationByIdSchema,
    {},
    'session authoring',
  ),
  newSessionWizardColumnsEnabled: accountPreference(z.boolean(), false, 'session authoring'),
  commandPaletteEnabled: accountPreference(z.boolean(), false, 'keyboard shortcuts'),
  keyboardShortcutsV2Enabled: accountPreference(z.boolean(), false, 'keyboard shortcuts'),
  keyboardSingleKeyShortcutsEnabled: accountPreference(z.boolean(), false, 'keyboard shortcuts'),
  keyboardShortcutOverridesV1: accountPreference(KeyboardShortcutOverridesSchema, {}, 'keyboard shortcuts', 64 * 1024),
  keyboardShortcutDisabledCommandIdsV1: accountPreference(
    KeyboardShortcutDisabledCommandIdsSchema,
    [],
    'keyboard shortcuts',
    32 * 1024,
  ),
  petsEnabled: accountPreference(z.boolean(), false, 'pet preferences'),
  petsSelectedPetRef: accountPreference(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('builtIn'), petId: z.string().min(1).max(256) }).strict(),
      z.object({ kind: z.literal('accountPet'), accountPetId: z.string().min(1).max(256) }).strict(),
    ]),
    { kind: 'builtIn', petId: 'blink' },
    'pet preferences',
  ),
  petsDesktopOverlayDefaultEnabled: accountPreference(z.boolean(), true, 'pet preferences'),
  petsDesktopOverlayDefaultVisibilityMode: accountPreference(
    z.enum(['attentionOrActive', 'alwaysWhenEnabled', 'attentionOnly']),
    'alwaysWhenEnabled',
    'pet preferences',
  ),
} as const;

const ACCOUNT_SCM_AND_FILES_CATALOG_DEFINITIONS = {
  scmCommitStrategy: accountPreference(
    z.enum(['atomic', 'git_staging']),
    'atomic',
    'source control',
  ),
  scmGitRepoPreferredBackend: accountPreference(
    z.enum(['git', 'sapling']),
    'git',
    'source control',
  ),
  scmGitRepoPreferredBackendQualifiedId: accountPreference(
    ScmBackendQualifiedIdSchema.nullable(),
    null,
    'source control',
  ),
  scmRemoteConfirmPolicy: accountPreference(
    z.enum(['always', 'pull_only', 'push_only', 'never']),
    'always',
    'source control',
  ),
  scmPushRejectPolicy: accountPreference(
    z.enum(['prompt_fetch', 'auto_fetch', 'manual']),
    'prompt_fetch',
    'source control',
  ),
  scmUncommittedChangesStrategy: accountPreference(
    z.enum(['ask', 'always_bring', 'always_stash']),
    'ask',
    'source control',
  ),
  scmDefaultDiffModeByBackend: accountPreference(
    z.record(accountBoundedString(256), z.enum(['included', 'pending', 'both'])).default({}),
    {},
    'source control',
    32 * 1024,
  ),
  scmAskBeforeOverwritingBranchStash: accountPreference(z.boolean(), true, 'source control'),
  scmReviewMaxFiles: accountPreference(accountNonNegativeInteger(), 25, 'source control'),
  scmReviewMaxChangedLines: accountPreference(accountNonNegativeInteger(), 2_000, 'source control'),
  scmDiffCacheMaxEntries: accountPreference(accountNonNegativeInteger(), 30, 'source control'),
  scmDiffCacheMaxTotalBytes: accountPreference(accountNonNegativeInteger(), 20 * 1024 * 1024, 'source control'),
  scmReviewPrefetchAheadCountWeb: accountPreference(accountNonNegativeInteger(), 14, 'source control'),
  scmReviewPrefetchBehindCountWeb: accountPreference(accountNonNegativeInteger(), 8, 'source control'),
  scmReviewPrefetchAheadCountNative: accountPreference(accountNonNegativeInteger(), 8, 'source control'),
  scmReviewPrefetchBehindCountNative: accountPreference(accountNonNegativeInteger(), 4, 'source control'),
  scmReviewPrefetchConcurrency: accountPreference(accountNonNegativeInteger(), 3, 'source control'),
  scmReviewPrefetchDebounceMs: accountPreference(accountNonNegativeInteger(), 150, 'source control'),
  scmSessionAutoRefreshIntervalMs: accountPreference(accountNonNegativeInteger(), 300_000, 'source control'),
  scmFilesAutoRefreshIntervalMs: accountPreference(accountNonNegativeInteger(), 60_000, 'source control'),
  scmCommitMessageGeneratorEnabled: accountPreference(z.boolean(), true, 'source control'),
  scmCommitMessageGeneratorBackendId: accountPreference(
    accountBoundedString(256),
    'claude',
    'source control',
  ),
  scmCommitMessageGeneratorInstructions: accountPreference(
    accountBoundedString(16 * 1024),
    '',
    'source control',
    16 * 1024,
  ),
  'scm.diffSummary.enabled': accountPreference(z.boolean(), true, 'source control'),
  'scm.diffSummary.prefetch': accountPreference(z.boolean(), false, 'source control'),
  'scm.diffSummary.modelProfileOverride': accountPreference(
    accountBoundedString(256),
    '',
    'source control',
  ),
  filesDiffSyntaxHighlightingMode: accountPreference(
    z.enum(['off', 'simple', 'advanced']),
    'simple',
    'file presentation',
  ),
  filesDiffRendererMode: accountPreference(
    z.enum(['happier', 'pierre']),
    'pierre',
    'file presentation',
  ),
  filesDiffPresentationStyle: accountPreference(
    z.enum(['unified', 'split']),
    'unified',
    'file presentation',
  ),
  filesDiffFileListVirtualizationMinFiles: accountPreference(accountNonNegativeInteger(), 20, 'file presentation'),
  filesDiffInlineVirtualizationLineThreshold: accountPreference(accountNonNegativeInteger(), 400, 'file presentation'),
  filesDiffReviewCommentsInlineVirtualizationLineThreshold: accountPreference(accountNonNegativeInteger(), 120, 'file presentation'),
  filesDiffInlineVirtualizationByteThreshold: accountPreference(accountNonNegativeInteger(), 120_000, 'file presentation'),
  filesChangedFilesRowDensity: accountPreference(
    z.enum(['comfortable', 'compact']),
    'comfortable',
    'file presentation',
  ),
  /** The session Git pane: one scroll (changes → commit → timeline) or two views (Changes | History). */
  scmGitPaneLayout: accountPreference(z.enum(['unified', 'tabs']), 'unified', 'file presentation'),
  /** Changed files in the Git pane as a flat list or a folder tree. */
  scmChangedFilesLayout: accountPreference(z.enum(['list', 'tree']), 'list', 'file presentation'),
  /** Where a new pull request form opens: in the Git sidebar, or as a Details pane. */
  scmPullRequestPlacement: accountPreference(z.enum(['sidebar', 'details']), 'sidebar', 'file presentation'),
  filesDiffFoldingEnabled: accountPreference(z.boolean(), true, 'file presentation'),
  filesDiffFoldingContextThreshold: accountPreference(accountNonNegativeInteger(), 12, 'file presentation'),
  filesDiffFoldingContextRadius: accountPreference(accountNonNegativeInteger(), 3, 'file presentation'),
  filesDiffIntraLineWordDiffEnabled: accountPreference(z.boolean(), true, 'file presentation'),
  filesDiffIntraLineWordDiffMaxPatchLines: accountPreference(accountNonNegativeInteger(), 2_000, 'file presentation'),
  filesDiffIntraLineWordDiffMaxPairs: accountPreference(accountNonNegativeInteger(), 500, 'file presentation'),
  filesDiffIntraLineWordDiffMaxLineLength: accountPreference(accountNonNegativeInteger(), 800, 'file presentation'),
  filesDiffTokenizationMaxBytes: accountPreference(accountNonNegativeInteger(), 250_000, 'file presentation'),
  filesDiffTokenizationMaxLines: accountPreference(accountNonNegativeInteger(), 5_000, 'file presentation'),
  filesDiffTokenizationMaxLineLength: accountPreference(accountNonNegativeInteger(), 2_000, 'file presentation'),
  filesCodeViewJsonInferenceMaxBytes: accountPreference(accountNonNegativeInteger(), 40_000, 'file presentation'),
  filesRepositoryTreeWarmCacheEnabled: accountPreference(z.boolean(), true, 'file presentation'),
  filesImagePreviewCacheMaxEntries: accountPreference(accountNonNegativeInteger(), 32, 'file presentation'),
  filesImagePreviewCacheMaxTotalBytes: accountPreference(accountNonNegativeInteger(), 96 * 1024 * 1024, 'file presentation'),
  filesImagePreviewMaxBytes: accountPreference(accountNonNegativeInteger(), 16 * 1024 * 1024, 'file presentation'),
  filesEditorAutoSave: accountPreference(z.boolean(), false, 'file editing'),
  markdownDefaultEditMode: accountPreference(z.enum(['raw', 'rich']), 'rich', 'file editing'),
  filesMarkdownRichEditorMaxBytes: accountPreference(accountNonNegativeInteger(), 256_000, 'file editing'),
  filesMarkdownRichEditorHtmlRoundTripMaxBytes: accountPreference(accountNonNegativeInteger(), 50_000, 'file editing'),
  filesEditorChangeDebounceMs: accountPreference(accountNonNegativeInteger(), 250, 'file editing'),
  filesEditorMaxFileBytes: accountPreference(accountNonNegativeInteger(), 2_500_000, 'file editing'),
  filesEditorBridgeMaxChunkBytes: accountPreference(accountNonNegativeInteger(), 64_000, 'file editing'),
  filesEditorWebMonacoEnabled: accountPreference(z.boolean(), true, 'file editing'),
  filesEditorNativeCodeMirrorEnabled: accountPreference(z.boolean(), true, 'file editing'),
} as const;

const ACCOUNT_TRANSCRIPT_AND_TOOL_CATALOG_DEFINITIONS = {
  toolViewDetailLevelDefault: accountPreference(
    z.enum(['default', 'title', 'compact', 'summary', 'full']),
    'default',
    'tool presentation',
  ),
  toolViewDetailLevelDefaultLocalControl: accountPreference(
    z.enum(['title', 'compact', 'summary', 'full']),
    'title',
    'tool presentation',
  ),
  toolViewShowDebugByDefault: accountPreference(z.boolean(), false, 'tool presentation'),
  toolViewTapAction: accountPreference(z.enum(['expand', 'open']), 'expand', 'tool presentation'),
  toolViewExpandedDetailLevelDefault: accountPreference(
    z.enum(['default', 'summary', 'full']),
    'default',
    'tool presentation',
  ),
  toolViewDetailLevelByToolName: accountPreference(
    z.record(accountBoundedString(1024), z.enum(['title', 'compact', 'summary', 'full'])).default({}),
    {},
    'tool presentation',
    32 * 1024,
  ),
  toolViewExpandedDetailLevelByToolName: accountPreference(
    z.record(accountBoundedString(1024), z.enum(['summary', 'full'])).default({}),
    {},
    'tool presentation',
    32 * 1024,
  ),
  transcriptGroupingMode: accountPreference(z.enum(['linear', 'turns']), 'turns', 'transcript presentation'),
  transcriptGroupToolCalls: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptTurnToolCallsGroupStrategy: accountPreference(
    z.enum(['consecutive_tools', 'all_tools_in_turn']),
    'consecutive_tools',
    'transcript presentation',
  ),
  transcriptToolCallsCollapsedPreviewCount: accountPreference(
    z.preprocess(
      (value) => typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.min(15, Math.trunc(value)))
        : value,
      accountNonNegativeInteger(15),
    ),
    DEFAULT_TRANSCRIPT_TOOL_CALLS_COLLAPSED_PREVIEW_COUNT,
    'transcript presentation',
  ),
  transcriptToolCallsGroupShowBackground: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptMessageTimestampDisplayMode: accountPreference(
    z.enum(TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES),
    'hover_web_hidden_mobile',
    'transcript presentation',
  ),
  transcriptMessageSelectionEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptMessageCopyActionEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptMessageForkActionEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptMessageRollbackActionEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptMessagePinActionEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptMessageSavePromptActionEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptMessageMakeRepeatableActionEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptMessagePluginActionsEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  composerPromptLibraryButtonEnabled: accountPreference(z.boolean(), true, 'composer presentation'),
  transcriptMessageSendToSessionEnabled: accountPreference(z.boolean(), false, 'transcript presentation'),
  transcriptMessageSendToSessionTemplate: accountPreference(
    accountBoundedString(2_000),
    '{{MESSAGES}}',
    'transcript presentation',
  ),
  transcriptBulkCopyFormat: accountPreference(
    z.enum(['markdown_labeled', 'plain']),
    'markdown_labeled',
    'transcript presentation',
  ),
  transcriptPendingQueueMaxHeightPx: accountPreference(accountNonNegativeInteger(), 80, 'transcript presentation'),
  transcriptPendingQueueExpandedMaxHeightPx: accountPreference(accountNonNegativeInteger(), 520, 'transcript presentation'),
  transcriptPendingQueueReorderRowHeightPx: accountPreference(accountNonNegativeInteger(), 72, 'transcript presentation'),
  transcriptPendingMessageCollapseThresholdChars: accountPreference(accountNonNegativeInteger(), 160, 'transcript presentation'),
  transcriptPendingMessageCollapsedLines: accountPreference(accountNonNegativeInteger(), 2, 'transcript presentation'),
  transcriptStreamingCoalesceEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptStreamingCoalesceWindowMs: accountPreference(accountNonNegativeInteger(), 16, 'transcript presentation'),
  transcriptStreamingCoalesceMaxBatchSize: accountPreference(accountNonNegativeInteger(), 200, 'transcript presentation'),
  transcriptThinkingPulseStaleMs: accountPreference(accountNonNegativeInteger(), 120_000, 'transcript presentation'),
  toolViewTimelineChromeMode: accountPreference(
    z.enum(['cards', 'activity_feed']),
    'activity_feed',
    'tool presentation',
  ),
  toolViewTimelineFeedDefaultExpanded: accountPreference(z.boolean(), false, 'tool presentation'),
  transcriptMotionPreset: accountPreference(z.enum(['off', 'subtle', 'full']), 'subtle', 'transcript presentation'),
  transcriptMotionFreshnessMs: accountPreference(accountNonNegativeInteger(), 60_000, 'transcript presentation'),
  transcriptAnimateNewItemsEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptAnimateToolExpandCollapseEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptAnimateToolExpandCollapseFreshOnly: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptAnimateThinkingEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptStreamingSmoothingEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptStreamingSettleDelayMs: accountPreference(accountNonNegativeInteger(), 250, 'transcript presentation'),
  transcriptStreamingPartialOutputEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptStreamingMarkdownRenderingEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptScrollPinEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptScrollPinOffsetThresholdPx: accountPreference(accountNonNegativeInteger(), 72, 'transcript presentation'),
  transcriptScrollAutoFollowWhenPinned: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptScrollJumpToBottomEnabled: accountPreference(z.boolean(), true, 'transcript presentation'),
  transcriptScrollJumpToBottomMinNewCount: accountPreference(accountNonNegativeInteger(), 1, 'transcript presentation'),
  transcriptScrollJumpToBottomRevealViewportRatio: accountPreference(
    z.number().min(0).max(1),
    0.4,
    'transcript presentation',
  ),
  transcriptScrollJumpToBottomAnimateScroll: accountPreference(z.boolean(), true, 'transcript presentation'),
  permissionPromptSurface: accountPreference(
    z.enum(['composer', 'transcript', 'both']),
    'composer',
    'permission mediation',
  ),
} as const;

const ACCOUNT_RUNTIME_AND_WORKFLOW_CATALOG_DEFINITIONS = {
  sessionReminderPresetsV1: accountPreference(
    SessionReminderPresetsV1Schema,
    [],
    'session reminders',
    16 * 1024,
  ),
  externalSessionsSettingsV1: accountPreference(
    ExternalSessionsSettingsV1Schema,
    ExternalSessionsSettingsV1Schema.parse({}),
    'external session policy',
    64 * 1024,
  ),
  pluginUpdateReviewModeV1: accountPreference(
    PluginUpdateReviewModeV1Schema,
    DEFAULT_PLUGIN_UPDATE_REVIEW_MODE_V1,
    'plugin update review',
  ),
  preferredLanguage: accountPreference(accountBoundedString(256).nullable(), null, 'language preference'),
  sessionHandoffDefaultsV1: accountPreference(
    SessionHandoffDefaultsV1Schema,
    DEFAULT_SESSION_HANDOFF_DEFAULTS_V1,
    'session handoff defaults',
    32 * 1024,
  ),
  sessionReplaySummaryRunnerV1: accountPreference(
    LlmTaskRunnerConfigV1Schema.nullable(),
    null,
    'session replay',
    64 * 1024,
  ),
  sessionTmuxByMachineId: accountPreference(
    z.record(accountBoundedString(1024), SessionTmuxMachineOverrideSchema).default({}),
    {},
    'session terminal defaults',
    64 * 1024,
  ),
  sessionTerminalHostByMachineId: accountPreference(
    z.record(accountBoundedString(1024), z.enum(['zellij', 'herdr'])).default({}),
    {},
    'session terminal defaults',
    64 * 1024,
  ),
  sessionTmuxSessionName: accountPreference(accountBoundedString(256), 'happy', 'session terminal defaults'),
  sessionTmuxIsolated: accountPreference(z.boolean(), true, 'session terminal defaults'),
  sessionTmuxTmpDir: accountPreference(
    accountBoundedString(16 * 1024).nullable(),
    null,
    'session terminal defaults',
    16 * 1024,
  ),
  installablesPolicyByMachineId: accountPolicy(
    AccountInstallablePoliciesByMachineIdSchema,
    {},
    'installable policy',
    64 * 1024,
  ),
} as const;

const ACCOUNT_HISTORICAL_PREFERENCE_CATALOG_DEFINITIONS = {
  viewInline: accountLegacy(z.boolean().optional(), false, 'deprecated tool presentation'),
  inferenceOpenAIKey: accountLegacy(z.string().max(64 * 1024).nullish(), null, 'deprecated inference credential'),
  expandTodos: accountLegacy(z.boolean().optional(), true, 'deprecated task presentation'),
  usePickerSearch: accountLegacy(z.boolean(), false, 'deprecated picker presentation'),
  compactSessionView: accountLegacy(z.boolean(), true, 'deprecated session list presentation'),
  compactSessionViewMinimal: accountLegacy(z.boolean(), true, 'deprecated session list presentation'),
  reviewPromptAnswered: accountLegacy(z.boolean(), false, 'deprecated review prompt'),
  reviewPromptLikedApp: accountLegacy(z.boolean().nullish(), null, 'deprecated review prompt'),
  lastUsedPermissionMode: accountLegacy(z.string().max(256).nullable(), null, 'deprecated session authoring'),
  lastUsedModelMode: accountLegacy(z.string().max(256).nullable(), null, 'deprecated session authoring'),
} as const;

export const ACCOUNT_SETTING_DEFINITIONS = defineAccountSettingDefinitions({
  ...ACCOUNT_CORE_CATALOG_DEFINITIONS,
  ...ACCOUNT_DISPLAY_CATALOG_DEFINITIONS,
  ...ACCOUNT_LEGACY_ROOT_CATALOG_DEFINITIONS,
  ...ACCOUNT_CONNECTED_SERVICES_CATALOG_DEFINITIONS,
  ...ACCOUNT_SIMPLE_COLLECTION_CATALOG_DEFINITIONS,
  ...ACCOUNT_SESSION_AUTHORING_CATALOG_DEFINITIONS,
  ...ACCOUNT_SCM_AND_FILES_CATALOG_DEFINITIONS,
  ...ACCOUNT_TRANSCRIPT_AND_TOOL_CATALOG_DEFINITIONS,
  ...ACCOUNT_RUNTIME_AND_WORKFLOW_CATALOG_DEFINITIONS,
  ...ACCOUNT_HISTORICAL_PREFERENCE_CATALOG_DEFINITIONS,
  schemaVersion: accountCatalogDefinition(
    z.number().int().min(0).catch(ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION)
      .default(ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION),
    ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
    { semanticDomain: 'settings compatibility', classification: 'policy', maximumSerializedValueBytes: 32 },
  ),
  clientEncryptionRequirementV1: accountCatalogDefinition(
    ClientEncryptionRequirementSchema,
    'follow_account',
    { semanticDomain: 'client encryption policy', classification: 'policy', maximumSerializedValueBytes: 32 },
  ),
  featureToggles: accountCatalogDefinition(
    FeatureTogglesSchema,
    {},
    { semanticDomain: 'feature choices', classification: 'preference', maximumSerializedValueBytes: 16 * 1024 },
  ),
  backendEnabledByTargetKey: accountCatalogDefinition(
    BackendEnabledByTargetKeySchema.default({}),
    {},
    { semanticDomain: 'backend availability', classification: 'preference', maximumSerializedValueBytes: 16 * 1024 },
  ),
  backendCliSourcePreferenceByTargetKey: accountCatalogDefinition(
    BackendCliSourcePreferenceByTargetKeySchema,
    {},
    { semanticDomain: 'backend installation policy', classification: 'preference', maximumSerializedValueBytes: 16 * 1024 },
  ),
  scmIncludeCoAuthoredBy: accountCatalogDefinition(
    z.boolean().optional().catch(undefined),
    undefined,
    { semanticDomain: 'source control', classification: 'preference', maximumSerializedValueBytes: 8 },
  ),
  actionsSettingsV1: accountCatalogDefinition(
    z.preprocess(
      (value) => tryNormalizeActionsSettingsV1(value) ?? DEFAULT_ACTIONS_SETTINGS_V1,
      ActionsSettingsV1Schema,
    ),
    DEFAULT_ACTIONS_SETTINGS_V1,
    { semanticDomain: 'action policy', classification: 'policy', maximumSerializedValueBytes: 64 * 1024 },
  ),
  notificationsSettingsV1: accountCatalogDefinition(
    NotificationsSettingsV1Schema.default(DEFAULT_NOTIFICATIONS_SETTINGS_V1),
    DEFAULT_NOTIFICATIONS_SETTINGS_V1,
    {
      semanticDomain: 'legacy notification preferences',
      classification: 'legacy',
      maximumSerializedValueBytes: 4 * 1024,
      compatibility: LEGACY_COMPATIBILITY,
    },
  ),
  codingPromptBehaviorV1: accountCatalogDefinition(
    CodingPromptBehaviorV1Schema.default(DEFAULT_CODING_PROMPT_BEHAVIOR_V1),
    DEFAULT_CODING_PROMPT_BEHAVIOR_V1,
    { semanticDomain: 'coding prompts', classification: 'preference', maximumSerializedValueBytes: 4 * 1024 },
  ),
  sessionRemoteAlertsEnabled: accountCatalogDefinition(
    z.boolean().default(false).catch(false),
    false,
    { semanticDomain: 'remote alert policy disclosure', classification: 'policy', maximumSerializedValueBytes: 5 },
  ),
  attentionDeliveryPolicyV1: accountCatalogDefinition(
    AttentionDeliveryPolicyV1Schema.catch(DEFAULT_ATTENTION_DELIVERY_POLICY_V1)
      .default(DEFAULT_ATTENTION_DELIVERY_POLICY_V1),
    DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
    { semanticDomain: 'attention delivery', classification: 'policy', maximumSerializedValueBytes: 32 * 1024 },
  ),
  peerMediationPreferencesV1: accountCatalogDefinition(
    PeerMediationPreferencesV1Schema.catch(DEFAULT_PEER_MEDIATION_PREFERENCES_V1)
      .default(DEFAULT_PEER_MEDIATION_PREFERENCES_V1),
    DEFAULT_PEER_MEDIATION_PREFERENCES_V1,
    { semanticDomain: 'peer mediation', classification: 'policy', maximumSerializedValueBytes: 32 * 1024 },
  ),
  usageLimitRecoverySettingsV1: accountCatalogDefinition(
    UsageLimitRecoverySettingsV1Schema.default(DEFAULT_USAGE_LIMIT_RECOVERY_SETTINGS_V1),
    DEFAULT_USAGE_LIMIT_RECOVERY_SETTINGS_V1,
    { semanticDomain: 'usage recovery', classification: 'policy', maximumSerializedValueBytes: 8 * 1024 },
  ),
  sessionPendingQueueDrainMode: accountCatalogDefinition(
    SessionPendingQueueDrainModeSchema.default(DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE),
    DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE,
    { semanticDomain: 'pending queue delivery', classification: 'policy', maximumSerializedValueBytes: 64 },
  ),
  sessionInactiveResumePolicy: accountCatalogDefinition(
    SessionInactiveResumePolicySchema.default(DEFAULT_SESSION_INACTIVE_RESUME_POLICY),
    DEFAULT_SESSION_INACTIVE_RESUME_POLICY,
    { semanticDomain: 'pending queue activation', classification: 'preference', maximumSerializedValueBytes: 32 },
  ),
  sessionPendingQueueDeliveryTiming: accountCatalogDefinition(
    SessionPendingQueueDeliveryTimingSchema.default(DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING),
    DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
    { semanticDomain: 'pending queue delivery', classification: 'policy', maximumSerializedValueBytes: 64 },
  ),
  sessionAgentSpawnPolicyV1: accountCatalogDefinition(
    SessionAgentSpawnPolicyV1Schema.default(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1),
    DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
    { semanticDomain: 'agent spawn policy', classification: 'policy', maximumSerializedValueBytes: 8 * 1024, recoverMalformed: false },
  ),
  sessionAgentStartAllowListsV1: accountCatalogDefinition(
    SessionAgentStartAllowListsV1Schema.default(DEFAULT_SESSION_AGENT_START_ALLOW_LISTS_V1),
    DEFAULT_SESSION_AGENT_START_ALLOW_LISTS_V1,
    { semanticDomain: 'agent start allow-lists', classification: 'policy', maximumSerializedValueBytes: 8 * 1024, recoverMalformed: false },
  ),
  approvalReviewerEnabled: accountCatalogDefinition(
    z.boolean().default(false).catch(false),
    false,
    { semanticDomain: 'approval reviewer', classification: 'policy', maximumSerializedValueBytes: 64 },
  ),
  workDepthLimit: accountCatalogDefinition(
    z.number().int().nonnegative().default(4).catch(4),
    4,
    { semanticDomain: 'agent delegation depth', classification: 'policy', maximumSerializedValueBytes: 64 },
  ),
  connectedServicesDefaultAuthByAgentIdV1: accountCatalogDefinition(
    BuiltInLegacyConnectedServicesDefaultAuthByAgentIdV1IngressSchema.default(DEFAULT_CONNECTED_SERVICES_DEFAULT_AUTH_BY_AGENT_ID_V1),
    DEFAULT_CONNECTED_SERVICES_DEFAULT_AUTH_BY_AGENT_ID_V1,
    { semanticDomain: 'connected service defaults', classification: 'preference', maximumSerializedValueBytes: 16 * 1024 },
  ),
  connectedAccountPurposeBindingsV1: accountCatalogDefinition(
    QualifiedConnectedAccountPurposeBindingsV1Schema.default(DEFAULT_CONNECTED_ACCOUNT_PURPOSE_BINDINGS_V1),
    DEFAULT_CONNECTED_ACCOUNT_PURPOSE_BINDINGS_V1,
    {
      semanticDomain: 'connected account purpose bindings',
      classification: 'legacy',
      maximumSerializedValueBytes: 32 * 1024,
      compatibility: LEGACY_COMPATIBILITY,
    },
  ),
  connectedServicesProviderStateSharingSettingsV1: accountCatalogDefinition(
    ConnectedServicesProviderStateSharingSettingsV1Schema.default(
      DEFAULT_CONNECTED_SERVICES_PROVIDER_STATE_SHARING_SETTINGS_V1,
    ),
    DEFAULT_CONNECTED_SERVICES_PROVIDER_STATE_SHARING_SETTINGS_V1,
    { semanticDomain: 'connected service state sharing', classification: 'policy', maximumSerializedValueBytes: 16 * 1024 },
  ),
  providerSettingsV1: accountCatalogDefinition(
    ProviderSettingsLegacySubtreeV1Schema,
    undefined,
    {
      semanticDomain: 'provider connection state',
      classification: 'legacy',
      maximumSerializedValueBytes: ACCOUNT_SETTINGS_MAX_PROVIDER_SUBTREE_BYTES,
      // `packages/protocol/src/providers/settings/v1.ts` is the cardinality authority for
      // this subtree. Applying the Account document's generic 256-entry node policy here
      // reinterprets Provider-internal nodes and drops a configuration Provider validation
      // already accepted and the server already persisted.
      structuralBoundsOwner: 'domainOwned',
      compatibility: LEGACY_COMPATIBILITY,
    },
  ),
  machineAdministrationSelectionsV1: accountCatalogDefinition(
    MachineAdministrationSelectionsV1Schema.default(DEFAULT_MACHINE_ADMINISTRATION_SELECTIONS_V1),
    DEFAULT_MACHINE_ADMINISTRATION_SELECTIONS_V1,
    { semanticDomain: 'machine administration selections', classification: 'preference', maximumSerializedValueBytes: 64 * 1024 },
  ),
  workspaceFileViewerPreferencesV1: accountCatalogDefinition(
    WorkspaceFileViewerPreferencesV1Schema.catch(DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1)
      .default(DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1),
    DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1,
    { semanticDomain: 'workspace file viewing', classification: 'preference', maximumSerializedValueBytes: 16 * 1024 },
  ),
});

export const ACCOUNT_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_SETTING_DEFINITIONS);
export const ACCOUNT_SETTING_KEYS = Object.freeze(Object.keys(ACCOUNT_SETTING_DEFINITIONS));
export type AccountSettingKey = keyof typeof ACCOUNT_SETTING_DEFINITIONS;
export type AccountSettingsDefaults = typeof ACCOUNT_SETTING_ARTIFACTS.defaults;

// This is the canonical, forward-compatible schema for the server-synced account settings blob.
// It MUST preserve unknown keys so newer clients can add fields without breaking older ones.
export const AccountSettingsSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const effective = backfillLegacyTargetKeyedAccountSettings(raw as Record<string, unknown>);
    // Effective readers no longer own these values. Raw persisted baselines must
    // retain them until the destination-first reserved-row importer commits.
    for (const key of LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS) delete effective[key];
    return effective;
  },
  z
    .object(ACCOUNT_SETTING_ARTIFACTS.shape)
    .passthrough()
    .superRefine((settings, context) => {
      const refsById = new Map<string, (typeof settings.workspaceRefsV1)[number]>();
      const refScopes = new Set<string>();
      for (const [index, ref] of settings.workspaceRefsV1.entries()) {
        if (refsById.has(ref.id)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaceRefsV1', index, 'id'], message: 'workspace reference id must be unique' });
        } else {
          refsById.set(ref.id, ref);
        }
        const scope = JSON.stringify([
          ref.serverId.trim(),
          ref.machineId.trim(),
          normalizeSessionHandoffWorkspaceRootPath(ref.rootPath) ?? ref.rootPath.trim(),
        ]);
        if (refScopes.has(scope)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaceRefsV1', index], message: 'workspace reference scope must be unique' });
        } else {
          refScopes.add(scope);
        }
      }

      const relationshipIds = new Set<string>();
      for (const [index, relationship] of settings.workspaceSyncRelationshipsV1.entries()) {
        if (relationshipIds.has(relationship.relationshipId)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaceSyncRelationshipsV1', index, 'relationshipId'], message: 'workspace relationship id must be unique' });
        } else {
          relationshipIds.add(relationship.relationshipId);
        }
        const alpha = refsById.get(relationship.alphaWorkspaceRefId);
        const beta = refsById.get(relationship.betaWorkspaceRefId);
        if (!alpha) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaceSyncRelationshipsV1', index, 'alphaWorkspaceRefId'], message: 'workspace relationship reference must exist' });
        }
        if (!beta) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaceSyncRelationshipsV1', index, 'betaWorkspaceRefId'], message: 'workspace relationship reference must exist' });
        }
      }
    }),
);

export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

export function accountSettingsParse(raw: unknown): AccountSettings {
  return AccountSettingsSchema.parse(raw);
}

/**
 * Enforces the immutable workspace identities at the Account Settings write
 * boundary. Snapshot validation proves internal integrity; this transition
 * check additionally prevents an existing id from being rebound in place.
 */
export function assertAccountWorkspaceSettingsTransition(
  previousRaw: unknown,
  nextRaw: unknown,
): void {
  const previous = accountSettingsParse(previousRaw);
  const next = accountSettingsParse(nextRaw);
  const nextRefs = new Map(next.workspaceRefsV1.map((ref) => [ref.id, ref] as const));

  for (const previousRef of previous.workspaceRefsV1) {
    const nextRef = nextRefs.get(previousRef.id);
    if (nextRef && (
      nextRef.serverId !== previousRef.serverId
      || nextRef.machineId !== previousRef.machineId
      || nextRef.rootPath !== previousRef.rootPath
    )) {
      throw Object.assign(new Error('Workspace identity cannot be rebound'), {
        code: 'workspace_ref_in_use',
      });
    }
  }

  const previousRelationships = new Map(
    previous.workspaceSyncRelationshipsV1.map((relationship) => [relationship.relationshipId, relationship] as const),
  );
  for (const relationship of next.workspaceSyncRelationshipsV1) {
    const prior = previousRelationships.get(relationship.relationshipId);
    if (prior && !areWorkspaceSyncRelationshipDefinitionsEqual(prior, relationship)) {
      throw Object.assign(new Error('Workspace relationship immutable definition cannot change'), {
        code: 'relationship_definition_conflict',
      });
    }
  }

  const relationshipsRequiringAdmission = new Set(next.workspaceSyncRelationshipsV1.flatMap((relationship) => {
    const prior = previousRelationships.get(relationship.relationshipId);
    return !prior || (!prior.enabled && relationship.enabled)
      ? [relationship.relationshipId]
      : [];
  }));
  if (relationshipsRequiringAdmission.size > 0) {
    const topology = deriveWorkspaceSyncTopology({
      workspaceRefs: next.workspaceRefsV1,
      relationships: next.workspaceSyncRelationshipsV1,
    });
    const nextByRef = new Map<string, Set<string>>();
    for (const relationship of next.workspaceSyncRelationshipsV1) {
      for (const refId of [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]) {
        const ids = nextByRef.get(refId) ?? new Set<string>();
        ids.add(relationship.relationshipId);
        nextByRef.set(refId, ids);
      }
    }
    const affected = new Set(relationshipsRequiringAdmission);
    const pending = [...relationshipsRequiringAdmission];
    while (pending.length > 0) {
      const id = pending.shift()!;
      const relationship = next.workspaceSyncRelationshipsV1.find((candidate) => candidate.relationshipId === id);
      if (!relationship) continue;
      for (const refId of [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]) {
        for (const adjacentId of nextByRef.get(refId) ?? []) {
          if (affected.has(adjacentId)) continue;
          affected.add(adjacentId);
          pending.push(adjacentId);
        }
      }
    }
    const issues = topology.issues.filter((issue) => issue.relationshipIds.some((id) => affected.has(id)));
    if (issues.length > 0) {
      throw Object.assign(new Error('Workspace sync topology is unsupported'), {
        code: 'workspace_sync_topology_invalid',
        issues,
      });
    }
  }
}

function readAccountSettingTargetKey(target: BackendTargetRefV2Input): string {
  // Preferences address identities, not executable routes. An external Agent
  // key must remain readable without a host catalog that can route it.
  if (typeof target === 'string') return BackendTargetKeyV2InputSchema.parse(target);
  if (target.kind === 'agent') return buildBackendTargetKeyV2(target);
  return buildBackendTargetKeyV2(readBackendTargetRefV2(target));
}

/**
 * Reads one entry out of a target-keyed Account setting map.
 *
 * Every such map is stored under the canonical V2 target key, and
 * `accountSettingsParse` rewrites a legacy `agent:<id>` / `acpBackend:<id>` key
 * into that spelling. A reader that builds a legacy key and indexes the parsed
 * projection therefore always misses, and silently reports "no preference" for
 * a preference the user actually set. Every reader consults this one owner so
 * the key vocabulary cannot diverge again; the legacy spelling is still honored
 * because an unparsed document may carry it.
 */
export function readAccountSettingValueForBackendTarget(
  settingsLike: unknown,
  settingKey: AccountSettingKey,
  target: BackendTargetRefV2Input,
): unknown {
  const record = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? (settingsLike as Record<string, unknown>)[settingKey]
    : null;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const byKey = record as Record<string, unknown>;

  let canonicalKey: string;
  try {
    canonicalKey = readAccountSettingTargetKey(target);
  } catch {
    return undefined;
  }
  if (Object.hasOwn(byKey, canonicalKey)) return byKey[canonicalKey];

  // An unparsed document may still hold the legacy spelling the catalog would
  // rewrite on its next read.
  for (const [key, value] of Object.entries(byKey)) {
    try {
      if (readAccountSettingTargetKey(key as BackendTargetRefV2Input) === canonicalKey) {
        return value;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Canonical answer to "did the user turn this backend target off in Account Settings". */
export function isBackendTargetDisabledByAccountSettings(
  settingsLike: unknown,
  target: BackendTargetRefV2Input,
): boolean {
  return readAccountSettingValueForBackendTarget(
    settingsLike,
    'backendEnabledByTargetKey',
    target,
  ) === false;
}

export function getNotificationsSettingsV1FromAccountSettings(settingsLike: unknown): NotificationsSettingsV1 {
  const rec = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? (settingsLike as Record<string, unknown>)
    : null;
  return NotificationsSettingsV1Schema.parse(rec?.notificationsSettingsV1);
}

/**
 * Canonical answer to "may this account receive Expo push notifications at all".
 *
 * Reads the attention delivery policy, which is this repository's canonical delivery owner and
 * already derives `channels.expo_push.enabled` from the legacy `notificationsSettingsV1.pushEnabled`
 * flag. Client-side token registration and OS permission prompting must consume this so the setting
 * a user can see cannot diverge from the behavior it describes.
 */
export function isExpoPushNotificationChannelEnabled(settingsLike: unknown): boolean {
  return accountSettingsParse(settingsLike).attentionDeliveryPolicyV1.channels.expo_push.enabled !== false;
}

export function resolveNotificationChannelsV1FromAccountSettings(settingsLike: unknown): NotificationChannelsV1 {
  const rec = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? (settingsLike as Record<string, unknown>)
    : null;
  const explicit = NotificationChannelsV1Schema.parse(rec?.notificationChannelsV1);
  if (rec && Object.prototype.hasOwnProperty.call(rec, 'notificationChannelsV1')) return explicit;
  return [deriveExpoPushNotificationChannelFromLegacySettings(getNotificationsSettingsV1FromAccountSettings(rec))];
}

export { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID };
export type {
  ConnectedServicesDefaultAuthByAgentIdV1,
  ConnectedServicesProviderStateSharingSettingsV1,
  NotificationChannelV1,
  NotificationChannelsV1,
};
export {
  AttentionDeliveryPolicyV1Schema,
  DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
  deriveAttentionDeliveryPolicyFromLegacySettings,
  resolveAttentionDeliveryPolicyDecision,
};
export type {
  AttentionDeliveryPolicyV1,
  AttentionDeliveryDecision,
  PeerMediationPreferencesV1,
  ResolveAttentionDeliveryPolicyDecisionParams,
};
