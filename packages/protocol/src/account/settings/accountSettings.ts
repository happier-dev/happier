import { ActionToolExposureModeSchema, ActionToolExposureSchema, ActionToolExposureSurfaceSchema, type ActionToolExposureMode, type ActionToolExposureSurface } from '../../actions/metadata.js';
import type { SettingAnalyticsMetadata } from '../../settings/registry/settingDefinition.js';
import { ScmGitIdentitySchema } from '../../scm/gitIdentity.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION, migrateAccountSettingsFeaturePreferences } from './featurePreferenceMigration.js';
export { ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION, migrateAccountSettingsFeaturePreferences } from './featurePreferenceMigration.js';
import { MAX_IDLE_COMPACTION_CACHE_WINDOW_MS } from './idleCompactionPreferences.js';
export { MAX_IDLE_COMPACTION_CACHE_WINDOW_MS, resolveIdleCompactionPreference, type IdleCompactionPreference } from './idleCompactionPreferences.js';
import { backfillClaudeUnifiedTerminalResponseLocations } from '../../agents/claude/settingsPolicy.js';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { normalizeScmBackendQualifiedId } from '../../scm/backendIdentity.js';
import * as z from '../../zodRuntimePolicy.js';
import { z as classicZ } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { GlassSurfaceMaterialsSchema, GlassSurfaceMaterialsStoredSchema } from './glassSurfaceMaterials.js';
import { DEFAULT_GLASS_TINT_INTENSITY, GlassTintIntensitySchema } from './glassTint.js';
import { HomeAtmosphereSchema, DEFAULT_HOME_ATMOSPHERE, HOME_BACKGROUND_FIELD_MODES } from './homeAtmosphere.js';
import { FilesEditorAiSuggestionsV1Schema, DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1 } from './filesEditorAiSuggestionsV1.js';
export { FilesEditorAiSuggestionsV1Schema, DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1, resolveFilesEditorAiSuggestionDelayMs, resolveFilesEditorAiSuggestionPolicy, resolveFilesEditorAiSuggestionModelId, type FilesEditorAiSuggestionsV1, type FilesEditorAiSuggestionOperation } from './filesEditorAiSuggestionsV1.js';
export { ATMOSPHERE_PLACES, ATMOSPHERE_PLANET_INTENSITIES, HOME_BACKGROUND_FIELD_MODES, AtmosphereShowOnSchema, defaultAtmosphereShowOn, applyAtmosphereLayoutDefault, type AtmospherePlace, HomeAtmosphereSchema, ProjectAtmosphereSchema, AtmospherePresentationSchema, atmospherePresentation, DEFAULT_HOME_ATMOSPHERE, type HomeAtmosphere, type ProjectAtmosphere, type AtmospherePresentation, type AtmosphereLookOverride } from './homeAtmosphere.js';
import { DEFAULT_MACHINE_RETENTION_DEFAULTS_V1, MachineRetentionDefaultsV1Schema } from './machineRetentionDefaultsV1.js';
import { DeploymentCreationDefaultsV1Schema } from '../../projects/deploymentCreationDefaultsV1.js';
import { DEFAULT_MACHINE_OFFLINE_ALERTS_V1, MachineOfflineAlertsV1Schema } from './machineOfflineAlertsV1.js';
import { UsagePacingTargetsV1Schema, UsageQuotaNotificationsV1Schema, DEFAULT_USAGE_QUOTA_NOTIFICATIONS_V1 } from './usagePacingPreferencesV1.js';
import { UsageCoachPreferencesV1Schema, UsageCoachPreferenceMutationV1Schema, DEFAULT_USAGE_COACH_PREFERENCES_V1 } from './usageCoachPreferencesV1.js';
import { UsageModelPriceOverridesV1Schema } from '../../usage/usageModelPriceSchemas.js';
import { UsageNightHoursV1Schema } from '../../usage/usageWorkIntervals.js';
import { PetAccountReferenceV1Schema } from '../../pets/selection.js';
import { DEFAULT_ATTACHMENT_UPLOAD_MAX_FILE_BYTES_V1, MAX_ATTACHMENT_UPLOAD_FILE_BYTES_V1 } from '../../transfers/attachments/attachmentLimitsV1.js';
import { normalizeAttachmentRelativePathV1 } from '../../transfers/attachments/attachmentPathV1.js';
import { BotFaceStyleSchema } from '../../sessions/identity/sessionBotFaceV1.js';

export const BotMotionSchema = z.enum(['lively', 'reactions', 'still']);
export type BotMotion = z.infer<typeof BotMotionSchema>;

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
import { ReviewQualityAggregationV1Schema } from '../../reviews/reviewQualityAggregationV1.js';
import { DEFAULT_SESSION_AGENT_START_ALLOW_LISTS_V1, SessionAgentStartAllowListsV1Schema, SessionAgentStartAllowListsV1StrictSchema } from './sessionAgentStartAllowListsV1.js';
export { DEFAULT_SESSION_AGENT_START_ALLOW_LISTS_V1, SessionAgentStartAllowListsV1Schema, type SessionAgentStartAllowListsV1 } from './sessionAgentStartAllowListsV1.js';
import { SessionReminderPresetsV1Schema } from './sessionReminderPresetsV1.js';
import type { SettingArtifacts } from '../../settings/registry/buildSettingArtifacts.js';
import {
  BackendTargetKeyV2Schema,
  BackendTargetKeyV2InputSchema,
  buildBackendTargetKeyV2,
  readBackendTargetRefV2,
  readBackendTargetKeyV2,
  type BackendTargetRefV2Input,
} from '../../backends/targets/backendTargetRefV2.js';
import { LlmTaskRunnerChoiceV1Schema } from '../../llm/tasks/llmTaskRunnerConfigV1.js';
import { InstallableAutoUpdateModeSchema } from '../../installables/descriptor.js';
import { ComputerUseByMachineIdV1Schema } from '../../computer/v1.js';
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
  HappierReplayWireMaxSeedCharsSchema,
  HappierReplayWritableMaxSeedCharsSchema,
} from '../../sessions/replaySeedBudget.js';
import { MAX_PLUGIN_IDENTIFIER_BYTES } from '../../plugins/pluginId.js';

import {
  tryNormalizeActionsSettingsV1,
  type ActionSettingsOverride,
  type ActionsSettingsV1,
} from '../../actions/actionSettings.js';
import {
  CodingPromptBehaviorV1Schema,
  DEFAULT_CODING_PROMPT_BEHAVIOR_V1,
} from '../../prompts/codingPromptBehaviorV1.js';
import { ContextSelectionsV1Schema } from '../../prompts/library/contextSelectionsV1.js';
import { RolesV1Schema } from './rolesV1.js';
import { CONNECTED_ACCOUNT_CATALOG_TRANSFERRED_ROOTS_V1 } from '../../connect/connectedAccountConfigurationRowsV1.js';
import { PromptExternalLinksV1Schema } from '../../prompts/library/promptExternalLinksV1.js';
import { PromptFoldersV1Schema } from '../../prompts/library/promptFoldersV1.js';
import { PromptInvocationsV1Schema } from '../../prompts/library/promptInvocationsV1.js';
import { PromptStacksV1Schema } from '../../prompts/library/promptStacksV1.js';
import {
  ConnectedServicesProviderStateSharingSettingsV1Schema,
  DEFAULT_CONNECTED_SERVICES_PROVIDER_STATE_SHARING_SETTINGS_V1,
  type ConnectedServicesDefaultAuthByAgentIdV1,
  type ConnectedServicesProviderStateSharingSettingsV1,
} from './connectedServicesSettings.js';
import {
  AttentionDeliveryPolicyV1Schema,
  DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
  type AttentionDeliveryPolicyV1,
  type AttentionDeliveryDecision,
  type ResolveAttentionDeliveryPolicyDecisionParams,
} from './attentionDeliveryPolicy.js';
import { resolveAttentionDeliveryPolicyDecision } from './attentionDeliveryPolicyDecision.js';
import { deriveAttentionDeliveryPolicyFromLegacySettings } from './attentionDeliveryPolicyLegacy.js';
import { readAccountAttentionDeliveryPolicy } from './attentionPolicyIngress.js';
export { readAccountAttentionDeliveryPolicy } from './attentionPolicyIngress.js';
import { NotificationsSettingsV1Schema, DEFAULT_NOTIFICATIONS_SETTINGS_V1, type NotificationsSettingsV1 } from './legacyNotifications.js';
export { ForegroundBehaviorSchema, NotificationsSettingsV1Schema, DEFAULT_NOTIFICATIONS_SETTINGS_V1 } from './legacyNotifications.js';
export type { ForegroundBehavior, NotificationsSettingsV1 } from './legacyNotifications.js';
import {
  DEFAULT_PEER_MEDIATION_PREFERENCES_V1,
  PeerMediationPreferencesV1Schema,
  type PeerMediationPreferencesV1,
} from './peerMediationPreferencesV1.js';
import {
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  type NotificationChannelV1,
  type NotificationChannelsV1,
} from './notificationChannels.js';
import {
  DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
  SessionPendingQueueDeliveryTimingSchema,
} from './sessionPendingQueueDeliveryTiming.js';
import { SESSION_PERMISSION_MODES } from '../../sessions/metadata/sessionPermissionModes.js';
import {
  DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1,
  WORKSPACE_FILE_VIEWER_PREFERENCES_V1_MAX_ENCODED_BYTES,
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
  buildAccountSettingArtifacts,
  type AccountSettingClassification,
} from './catalog/accountSettingDefinition.js';
import { BoundedLegacyJsonValueSchema } from './catalog/legacyJson.js';
import { ClientEncryptionRequirementSchema } from '../../encryption/clientEncryptionRequirement.js';
import { ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema } from '../../providers/selection/v1.js';
import { CollectionSpacesV1Schema } from '../../collections/spaces/collectionSpacesV1.js';
import { CollectionSpacesEnabledV1Schema } from '../../collections/spaces/collectionSpaceEnablementV1.js';
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

/** Shared picker recovery and favorite ordering; incoming writes validate every target first. */
export const FavoriteBackendTargetKeysV1Schema = lazyZodSchema(() => z.pipe(z.transform((value) => {
  const values = Array.isArray(value) ? value : [];
  const uniqueKeys: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!BackendTargetKeyV2Schema.safeParse(key).success || seen.has(key)) continue;
    seen.add(key);
    uniqueKeys.push(key);
  }
  return uniqueKeys;
}), z.array(BackendTargetKeyV2Schema)));
export type FavoriteBackendTargetKeysV1 = z.infer<typeof FavoriteBackendTargetKeysV1Schema>;

/** The upload-folder control and its Action admit the same workspace-relative directory. */
export function normalizeAttachmentsUploadsWorkspaceRelativeDir(input: string): string | null {
  return normalizeAttachmentRelativePathV1(input);
}

function defaultAgentDisabledActionSettings(): ActionSettingsOverride {
  return {
    enabledPlacements: [],
    disabledSurfaces: ['agent'],
    disabledPlacements: [],
    approvalRequiredSurfaces: [],
    toolExposureModes: {},
  };
}

export const DEFAULT_ACTIONS_SETTINGS_V1: ActionsSettingsV1 = {
  v: 1,
  actions: {
    // Agent-surface coordination is enabled by default; destructive or human-decision
    // actions stay opt-in as a product courtesy.
    'session.stop': defaultAgentDisabledActionSettings(),
    'session.archive': defaultAgentDisabledActionSettings(),
    'session.unarchive': defaultAgentDisabledActionSettings(),
    'session.usageLimit.consumeResetCredit': defaultAgentDisabledActionSettings(),
    'session.permission.respond': defaultAgentDisabledActionSettings(),
  },
};

const CURRENT_DEFAULT_SESSION_AGENT_DISABLED_ACTION_IDS_V1 = Object.freeze([
  'session.stop',
  'session.archive',
  'session.unarchive',
  'session.usageLimit.consumeResetCredit',
  'session.permission.respond',
] as const satisfies readonly string[]);

const CURRENT_DEFAULT_SESSION_AGENT_DISABLED_ACTION_ID_SET_V1 = new Set<string>(
  CURRENT_DEFAULT_SESSION_AGENT_DISABLED_ACTION_IDS_V1,
);
export const UsageLimitRecoverySettingsV1Schema = lazyZodSchema(() => classicZ.catch(z.strictObject({
    v: z._default(z.literal(1), 1),
    mode: z._default(z.enum(['ask', 'auto_wait']), 'ask'),
    promptMode: z._default(z.literal('standard'), 'standard'),
    resumePromptMode: z._default(z.enum(['standard', 'off', 'custom']), 'standard'),
    /**
     * Account-level custom resume prompt text; only meaningful when
     * `resumePromptMode === 'custom'`. Empty/missing text fails safe to the
     * standard prompt (never silently off).
     */
    customResumePrompt: z.optional(z.string().check(z.trim())),
}), {
    v: 1,
    mode: 'ask',
    promptMode: 'standard',
    resumePromptMode: 'standard',
}));

export type UsageLimitRecoverySettingsV1 = z.infer<typeof UsageLimitRecoverySettingsV1Schema>;

export const DEFAULT_USAGE_LIMIT_RECOVERY_SETTINGS_V1: UsageLimitRecoverySettingsV1 = UsageLimitRecoverySettingsV1Schema.parse({});

export const SESSION_PENDING_QUEUE_DRAIN_MODES = ['one_at_a_time', 'drain_all'] as const;
export const DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE = 'one_at_a_time' as const;
export const SESSION_LIST_BACKGROUND_WORK_ATTENTION_MODE_VALUES = ['keepWorking', 'keepWorkingUnread', 'showUnread'] as const;
export type SessionListBackgroundWorkAttentionMode = typeof SESSION_LIST_BACKGROUND_WORK_ATTENTION_MODE_VALUES[number];
export const SESSION_INACTIVE_RESUME_POLICY_VALUES = ['when_available', 'online_only', 'manual'] as const;
export const DEFAULT_SESSION_INACTIVE_RESUME_POLICY = 'online_only' as const;
export const SessionInactiveResumePolicySchema = lazyZodSchema(() => classicZ.catch(z
    .enum(SESSION_INACTIVE_RESUME_POLICY_VALUES), DEFAULT_SESSION_INACTIVE_RESUME_POLICY));
export type SessionInactiveResumePolicy = z.infer<typeof SessionInactiveResumePolicySchema>;
export const SessionPendingQueueDrainModeSchema = lazyZodSchema(() => classicZ.catch(z
    .enum(SESSION_PENDING_QUEUE_DRAIN_MODES), DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE));
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
    // The new default opens question-owner admission, not execution authority.
    // A saved answer override may be deliberate even in the old full vector;
    // without preference provenance, never silently remove that choice.
    if (id === 'session.user_action.answer') continue;
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
const BackendEnabledByTargetKeySchema = lazyDefinition(() => z.catch(z.record(BackendTargetKeyV2InputSchema, z.boolean()), {}));
const FeatureTogglesSchema = lazyDefinition(() => z._default(z.catch(withAccountSettingBounds(classicZ.record(z.string().check(z.maxLength(256)), z.boolean()), 16 * 1024), {}), {}));
const BackendCliSourcePreferenceSchema = lazyDefinition(() => z.enum(['system-first', 'managed-first']));
const BackendCliSourcePreferenceByTargetKeySchema = lazyDefinition(() => z.catch(z
    .record(BackendTargetKeyV2InputSchema, BackendCliSourcePreferenceSchema), {}));

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
  'composerPromptLibraryButtonEnabled',
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
  'viewInline',
  'expandTodos',
  'usePickerSearch',
  'compactSessionView',
  'compactSessionViewMinimal',
  'reviewPromptAnswered',
  'reviewPromptLikedApp',
  'lastUsedPermissionMode',
  'lastUsedModelMode',
  // 0.3 development summary-model string; read once into scm.diffSummary.runnerV1.
  'scm.diffSummary.modelProfileOverride',
  'scmCommitMessageGeneratorBackendId',
] as const);

const RETIRED_ACCOUNT_SETTINGS_ROOT_KEY_SET = new Set<string>(RETIRED_ACCOUNT_SETTINGS_ROOT_KEYS);

export function isRetiredAccountSettingsRootKey(key: string): boolean {
  if (RETIRED_ACCOUNT_SETTINGS_ROOT_KEY_SET.has(key)) return true;
  if (RETIRED_SESSION_LIST_SETTING_KEYS.has(key)) return true;
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

function canonicalizeStoredBackendTargetMap(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const aliases: Array<readonly [string, unknown]> = [];
  const canonical: Array<readonly [string, unknown]> = [];
  for (const [key, entry] of Object.entries(value)) {
    const targetKey = readBackendTargetKeyV2(key);
    if (targetKey !== null) (targetKey === key ? canonical : aliases).push([targetKey, entry]);
  }
  // A retained alias cannot override an explicitly authored canonical entry.
  return Object.fromEntries([...aliases, ...canonical]);
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

  for (const key of ['backendEnabledByTargetKey', 'backendCliSourcePreferenceByTargetKey',
    'sessionDefaultPermissionModeByTargetKey', 'newSessionDefaultPersistenceModeByTargetKeyV1',
    'sessionIdleCompactionEnabledByTargetKey', 'sessionIdleCompactionMinContextTokensByTargetKey',
    'sessionIdleCompactionCacheWindowOverrideMsByTargetKey'] as const) {
    if (Object.hasOwn(next, key)) next[key] = canonicalizeStoredBackendTargetMap(next[key]);
  }

  next.attentionDeliveryPolicyV1 = readAccountAttentionDeliveryPolicy(source);

  // Read from the raw document: the retired string key never reaches `source`.
  if (next['scm.diffSummary.runnerV1'] === undefined) {
    const runner = migrateLegacyScmDiffSummaryModel(raw['scm.diffSummary.modelProfileOverride']);
    if (runner) next['scm.diffSummary.runnerV1'] = runner;
  }

  return next;
}

/**
 * 0.2 stored only an Agent id, defaulting to 'claude'. That default (or empty)
 * carries no evidence of a choice, so it stays Auto; any other Agent becomes an
 * explicit runner on its default model. Commit generation is never tool-capable.
 */
export function migrateLegacyScmCommitMessageRunner(raw: Record<string, unknown>): void {
  if (!Object.hasOwn(raw, 'scmCommitMessageGeneratorBackendId')) return;
  const legacy = raw.scmCommitMessageGeneratorBackendId;
  delete raw.scmCommitMessageGeneratorBackendId;
  if (raw.scmCommitMessageGeneratorRunnerV1 !== undefined || typeof legacy !== 'string' || !legacy.trim()) return;
  const agentTargetKey = readBackendTargetKeyV2({ kind: 'builtInAgent', agentId: legacy.trim() });
  const releasedDefaultTargetKey = readBackendTargetKeyV2({ kind: 'builtInAgent', agentId: 'claude' });
  if (agentTargetKey && agentTargetKey !== releasedDefaultTargetKey) {
    raw.scmCommitMessageGeneratorRunnerV1 = { v: 1,
      modelSelection: { agentTargetKey, providerConnectionId: null, modelId: 'default' }, permissionMode: 'no_tools' };
  }
}

/**
 * The retired summary-model string: '' was Auto, `model:{…}` an explicit model
 * selection with its connected route. Anything unreadable stays Auto.
 */
function migrateLegacyScmDiffSummaryModel(raw: unknown): unknown {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value.startsWith('model:')) return null;
  try {
    const { connectedServices, agentTargetKey, providerConnectionId, modelId } = JSON.parse(value.slice('model:'.length)) as Record<string, unknown>;
    const runner = LlmTaskRunnerChoiceV1Schema.safeParse({ v: 1, modelSelection: { agentTargetKey, providerConnectionId, modelId },
      ...(connectedServices !== undefined ? { connectedServices } : {}) });
    return runner.success ? runner.data : null;
  } catch {
    return null;
  }
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
  /** Use the canonical additive stored projection while mutation admission stays strict. */
  storedRead?: boolean;
  /** Strict write admission when the stored schema deliberately recovers malformed fields. */
  mutationSchema?: z.core.$ZodType;
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
  issues: readonly Readonly<{ code: string; params?: Readonly<Record<string, unknown>> }>[],
): AccountSettingValueRefusalReason {
  for (const issue of issues) {
    if (issue.code === 'too_big') return 'tooLarge';
    const boundReason = issue.code === 'custom' ? issue.params?.accountSettingBoundsReason : undefined;
    if (boundReason === 'tooLarge' || boundReason === 'tooDeep') return boundReason;
  }
  return 'invalidValue';
}

export type AccountSettingValueParseResult =
  | Readonly<{ success: true; data: unknown }>
  | Readonly<{
    success: false;
    issues: readonly string[];
    reason: AccountSettingValueRefusalReason;
  }>;
function parseAccountSettingMutationValue(schema: z.core.$ZodType, value: unknown, storedRead = false): AccountSettingValueParseResult {
    if (schema._zod.def.type === 'catch') {
        return parseAccountSettingMutationValue((schema as z.core.$ZodCatch)._zod.def.innerType, value, storedRead);
    }
    if (schema._zod.def.type === 'default') {
        return parseAccountSettingMutationValue((schema as z.core.$ZodDefault)._zod.def.innerType, value, storedRead);
    }
    const parsed = classicZ.safeParse(storedRead ? createStoredReadSchema(schema) : schema, value);
    return parsed.success
        ? { success: true, data: parsed.data }
        : {
            success: false,
            issues: parsed.error.issues.map((issue) => issue.message),
            reason: classifyAccountSettingSchemaIssues(parsed.error.issues),
        };
}
export function accountCatalogDefinition<TSchema extends z.core.$ZodType>(schema: TSchema, defaultValue: z.input<TSchema>, options: AccountCatalogDefinitionOptions) {
    const structuralBoundsOwner = options.structuralBoundsOwner ?? 'accountGeneric';
    const storedSchema = createStoredReadSchema(schema);
    const prepared = lazyDefinition(() => {
        // Stored objects project known fields. New inputs use the strict schema;
        // sparse changes must not treat retained additive fields as new inputs.
        const parsedDefault = classicZ.parse(storedSchema, defaultValue);
        const presentValueSchema = (options.recoverMalformed === false
            ? storedSchema
            : z.catch(storedSchema, parsedDefault)) as typeof storedSchema;
        const missingValueDefaultSchema = z.pipe(z.undefined(), z.transform(() => parsedDefault));
        return { schema: classicZ.union([missingValueDefaultSchema, presentValueSchema]), default: parsedDefault };
    });
    const parseValue = (value: unknown, storedRead = false): AccountSettingValueParseResult => {
        const stored = storedRead ? parseAccountSettingMutationValue(schema, value, true) : undefined;
        if (stored && !stored.success) return stored;
        const boundIssue = inspectAccountSettingValueBounds(stored?.success ? stored.data : value, options.maximumSerializedValueBytes, structuralBoundsOwner);
        return boundIssue
            ? { success: false, issues: [boundIssue.message], reason: boundIssue.reason }
            : stored ?? parseAccountSettingMutationValue(options.mutationSchema ?? schema, value);
    };
    return {
        // Preserve Zod `.default(...)` semantics: a parsed transform result is returned as-is for
        // missing input. Definitions may opt out of malformed-value recovery when their value is
        // authoritative state that must never be reinterpreted as the default.
        schema: lazyZodSchema(() => prepared.schema),
        parseMutationValue: (value: unknown) => parseValue(value),
        parseStoredValue: (value: unknown) => parseValue(value, true),
        get default() { return prepared.default; },
        resolveParsedDefault: () => prepared.default,
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
function accountPreference<TSchema extends z.core.$ZodType>(schema: TSchema, defaultValue: z.input<TSchema>, semanticDomain: string, maximumSerializedValueBytes = 4 * 1024) {
    return accountCatalogDefinition(schema, defaultValue, {
        semanticDomain,
        classification: 'preference',
        maximumSerializedValueBytes,
    });
}
function accountPolicy<TSchema extends z.core.$ZodType>(schema: TSchema, defaultValue: z.input<TSchema>, semanticDomain: string, maximumSerializedValueBytes = 4 * 1024) {
    return accountCatalogDefinition(schema, defaultValue, {
        semanticDomain,
        classification: 'policy',
        maximumSerializedValueBytes,
    });
}

const AgentInputActionBarLayoutSchema = z.enum(['auto', 'wrap', 'scroll']);
export const AvatarStyleSchema = z.enum(['pixelated', 'gradient', 'brutalist', 'planet']);
export const SessionListIdentityDisplaySchema = z.enum([
    'auto', 'agentLogo', 'project', 'projectWithAgent', 'agentWithTrailingProject', 'avatar', 'none',
]);
export type SessionListIdentityDisplay = z.infer<typeof SessionListIdentityDisplaySchema>;
defineStoredReadProjection(AgentInputActionBarLayoutSchema, () => z.pipe(
    z.transform((raw) => raw === 'collapsed' ? 'auto' : raw),
    AgentInputActionBarLayoutSchema,
));
function accountLegacy<TSchema extends z.core.$ZodType>(schema: TSchema, defaultValue: z.input<TSchema>, semanticDomain: string, maximumSerializedValueBytes = 64 * 1024, recoverMalformed = true) {
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
    return z.number().check(z.int(), z.minimum(0), z.maximum(maximum));
}
function accountBoundedString(maximum = 4 * 1024) {
    return z.string().check(z.maxLength(maximum));
}

const ScmBackendQualifiedIdSchema = lazyDefinition(() => z
    .string().check(z.trim(), z.minLength(1), z.maxLength(256), z.refine((value) => normalizeScmBackendQualifiedId(value) === value)));

export const TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES = [
  'hover_web_hidden_mobile',
  'hover_web_always_mobile',
  'always',
  'never',
] as const;
export type TranscriptMessageTimestampDisplayMode =
  typeof TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES[number];

export const COORDINATOR_KEEP_VALUES = ['list_pin', 'none'] as const;
export const COORDINATOR_KEEP_DEFAULT_VALUES = ['suggest', ...COORDINATOR_KEEP_VALUES] as const;
export type CoordinatorKeepDefault = typeof COORDINATOR_KEEP_DEFAULT_VALUES[number];

export function resolveCoordinatorKeepDefault(preference: CoordinatorKeepDefault): typeof COORDINATOR_KEEP_VALUES[number] {
    return preference === 'suggest' ? 'list_pin' : preference;
}

export const DEFAULT_TRANSCRIPT_TOOL_CALLS_COLLAPSED_PREVIEW_COUNT = 3;
export const SessionTmuxMachineOverrideSchema = lazyZodSchema(() => classicZ.pipe(z.looseObject({
    useTmux: z.boolean(),
    sessionName: accountBoundedString(256),
    isolated: z.boolean(),
    tmpDir: z.nullable(accountBoundedString(16 * 1024)),
}), z.transform(({ terminalHost: _retiredDevelopmentHost, ...override }) => override)));
const AccountInstallablePolicyOverrideSchema = lazyDefinition(() => z.looseObject({
    autoInstallWhenNeeded: z.optional(z.boolean()),
    autoUpdateMode: z.optional(InstallableAutoUpdateModeSchema),
}));
const AccountInstallablePoliciesByMachineIdSchema = lazyDefinition(() => z._default(z
    .record(accountBoundedString(1024), z._default(z.record(accountBoundedString(1024), AccountInstallablePolicyOverrideSchema), {})), {}));

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
const SessionHandoffIgnoredIncludeGlobSchema = lazyDefinition(() => z
    .string().check(z.trim(), z.minLength(1), z.superRefine((value, ctx) => {
    if (utf8ByteLength(value) > 512) {
        ctx.addIssue({ code: "custom", message: 'must be at most 512 UTF-8 bytes' });
    }
    if (value.includes('\u0000')
        || /^(?:[\\/]|~(?:[\\/]|$)|[A-Za-z]:[\\/]|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(value)
        || value.split(/[\\/]+/).includes('..')) {
        ctx.addIssue({ code: "custom", message: 'must be a relative glob' });
    }
})));
export const SessionHandoffDefaultsV1Schema = lazyZodSchema(() => classicZ.pipe(z.looseObject({
    v: z._default(z.literal(1), 1),
    // Keep updated is the recommended first-use outcome. Explicit persisted
    // choices remain authoritative, and relationship identity stays daemon-owned.
    workspaceSyncMode: z._default(z
        .enum(['none', 'copy_once', 'keep_synced', 'mirror_exactly', 'keep_both_in_sync']), 'keep_synced'),
    // Reader-only tolerance for pre-A4 UI defaults. The transform deliberately
    // drops this retired UI-owned identity from all canonical writes.
    workspaceSyncRelationshipId: z.optional(z.nullable(accountBoundedString(256))),
    includeIgnoredMode: z._default(z.enum(['exclude', 'include_selected']), 'exclude'),
    ignoredIncludeGlobs: z._default(z.array(SessionHandoffIgnoredIncludeGlobSchema).check(z.maxLength(64), z.superRefine((value, ctx) => {
        if (value.reduce((total, glob) => total + utf8ByteLength(glob), 0) > 16 * 1024) {
            ctx.addIssue({ code: "custom", message: 'must be at most 16 KiB in aggregate' });
        }
    })), []),
    directTargetMode: z._default(z.enum(['keep_direct', 'convert_to_persisted']), 'keep_direct'),
}).check(z.superRefine((value, ctx) => {
    for (const [key, child] of Object.entries(value)) {
        if (SESSION_HANDOFF_DEFAULT_KEYS.has(key))
            continue;
        if (hasForbiddenSessionHandoffData({ [key]: child })) {
            ctx.addIssue({
                code: "custom",
                path: [key],
                message: 'must not persist source, path, payload, or credential material',
            });
        }
    }
})), z.transform((value) => ({
    v: 1 as const,
    workspaceSyncMode: value.workspaceSyncMode,
    includeIgnoredMode: value.includeIgnoredMode,
    ignoredIncludeGlobs: value.ignoredIncludeGlobs,
    directTargetMode: value.directTargetMode,
}))));

export type SessionHandoffDefaultsV1 = z.infer<typeof SessionHandoffDefaultsV1Schema>;

export const DEFAULT_SESSION_HANDOFF_DEFAULTS_V1: SessionHandoffDefaultsV1 = Object.freeze({
  v: 1,
  workspaceSyncMode: 'keep_synced',
  includeIgnoredMode: 'exclude',
  ignoredIncludeGlobs: [],
  directTargetMode: 'keep_direct',
});

export const SESSION_PROVIDER_USAGE_GAUGE_WINDOW_MODES = ['most_constrained', 'daily', 'weekly', 'primary', 'secondary', 'session'] as const;
export const CollectionTableCardPresentationSchema = lazyZodSchema(() => z.enum(['table', 'grid']));
export type CollectionTableCardPresentation = z.infer<typeof CollectionTableCardPresentationSchema>;

export const CollectionArtifactPresentationSchema = lazyZodSchema(() => z.enum(['grid', 'list', 'folders']));
export type CollectionArtifactPresentation = z.infer<typeof CollectionArtifactPresentationSchema>;
export const CollectionWorkflowGroupingSchema = lazyZodSchema(() => z.enum(['source', 'project']));
export type CollectionWorkflowGrouping = z.infer<typeof CollectionWorkflowGroupingSchema>;
export const CollectionWorkflowRunGroupingSchema = lazyZodSchema(() => z.enum(['date', 'project', 'workflow']));
export type CollectionWorkflowRunGrouping = z.infer<typeof CollectionWorkflowRunGroupingSchema>;
export const CollectionLinesSchema = lazyZodSchema(() => z.union([z.literal(1), z.literal(2), z.literal(3)]));
export type CollectionLines = z.infer<typeof CollectionLinesSchema>;
export const SessionCollectionRowDetailsSchema = lazyZodSchema(() => z.strictObject({
    currentWork: z.optional(z.boolean()),
    progress: z.optional(z.boolean()),
    project: z.optional(z.boolean()),
    machine: z.optional(z.boolean()),
    branch: z.optional(z.boolean()),
    pullRequest: z.optional(z.boolean()),
    changes: z.optional(z.boolean()),
}));
export type SessionCollectionRowDetails = Readonly<Required<z.infer<typeof SessionCollectionRowDetailsSchema>>>;
export const CollectionPluginDetailPreferencesSchema = lazyZodSchema(() => z.record(z.string(), z.boolean()));

function withAccountSettingAnalytics<TDefinition extends object>(definition: TDefinition, analytics: SettingAnalyticsMetadata) {
    return Object.assign(definition, { analytics });
}

// Runtime registries supply the projected properties on the UI. A context-free
// read can emit no properties from these settings.
const emptyRuntimeSettingProperties = () => ({});

const trackAccountBoolean = { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' } satisfies SettingAnalyticsMetadata;
const trackAccountEnum = { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' } satisfies SettingAnalyticsMetadata;

type ActionSettingsOverrideLike = Readonly<{
    enabled?: boolean;
    enabledPlacements?: ReadonlyArray<unknown>;
    disabledSurfaces?: ReadonlyArray<unknown>;
    disabledPlacements?: ReadonlyArray<unknown>;
    approvalRequiredSurfaces?: ReadonlyArray<unknown>;
    toolExposureModes?: unknown;
}>;

type NormalizedActionSettingsOverride = Readonly<{
    enabled: boolean | null;
    enabledPlacements: ReadonlyArray<string>;
    disabledSurfaces: ReadonlyArray<string>;
    disabledPlacements: ReadonlyArray<string>;
    approvalRequiredSurfaces: ReadonlyArray<string>;
    toolExposureModes: Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>>;
}>;

const readActionToolExposureSurfaces = lazyDefinition(() =>
    Object.keys(ActionToolExposureSchema.shape) as ActionToolExposureSurface[]);

function normalizeStringSet(raw: ReadonlyArray<unknown> | undefined): ReadonlyArray<string> {
    if (!Array.isArray(raw) || raw.length === 0)
        return [];
    const out = new Set<string>();
    for (const entry of raw) {
        if (typeof entry !== 'string')
            continue;
        const trimmed = entry.trim();
        if (!trimmed)
            continue;
        out.add(trimmed);
    }
    return Array.from(out).sort();
}

function normalizeToolExposureModes(raw: unknown): Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    const next: Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>> = {};
    for (const [surface, mode] of Object.entries(raw as Record<string, unknown>)) {
        if (!ActionToolExposureSurfaceSchema.safeParse(surface).success)
            continue;
        const parsed = ActionToolExposureModeSchema.safeParse(mode);
        if (!parsed.success)
            continue;
        next[surface as ActionToolExposureSurface] = parsed.data;
    }
    return next;
}

function normalizeOverride(raw: unknown): NormalizedActionSettingsOverride {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ActionSettingsOverrideLike) : null;
    const enabled = typeof value?.enabled === 'boolean' ? value.enabled : null;
    return {
        enabled,
        enabledPlacements: normalizeStringSet(value?.enabledPlacements),
        disabledSurfaces: normalizeStringSet(value?.disabledSurfaces),
        disabledPlacements: normalizeStringSet(value?.disabledPlacements),
        approvalRequiredSurfaces: normalizeStringSet(value?.approvalRequiredSurfaces),
        toolExposureModes: normalizeToolExposureModes(value?.toolExposureModes),
    };
}

function areOverridesEqual(a: NormalizedActionSettingsOverride, b: NormalizedActionSettingsOverride): boolean {
    if (a.enabled !== b.enabled)
        return false;
    if (a.enabledPlacements.length !== b.enabledPlacements.length)
        return false;
    if (a.disabledSurfaces.length !== b.disabledSurfaces.length)
        return false;
    if (a.disabledPlacements.length !== b.disabledPlacements.length)
        return false;
    if (a.approvalRequiredSurfaces.length !== b.approvalRequiredSurfaces.length)
        return false;
    for (let i = 0; i < a.enabledPlacements.length; i += 1) {
        if (a.enabledPlacements[i] !== b.enabledPlacements[i])
            return false;
    }
    for (let i = 0; i < a.disabledSurfaces.length; i += 1) {
        if (a.disabledSurfaces[i] !== b.disabledSurfaces[i])
            return false;
    }
    for (let i = 0; i < a.disabledPlacements.length; i += 1) {
        if (a.disabledPlacements[i] !== b.disabledPlacements[i])
            return false;
    }
    for (let i = 0; i < a.approvalRequiredSurfaces.length; i += 1) {
        if (a.approvalRequiredSurfaces[i] !== b.approvalRequiredSurfaces[i])
            return false;
    }
    for (const surface of readActionToolExposureSurfaces) {
        if (a.toolExposureModes[surface] !== b.toolExposureModes[surface])
            return false;
    }
    return true;
}

function countAddedStrings(current: ReadonlyArray<string>, base: ReadonlyArray<string>): number {
    if (current.length === 0)
        return 0;
    if (base.length === 0)
        return current.length;
    const baseSet = new Set(base);
    let count = 0;
    for (const entry of current) {
        if (!baseSet.has(entry))
            count += 1;
    }
    return count;
}

function countToolExposureOverrides(current: Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>>, base: Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>>): number {
    let count = 0;
    for (const surface of readActionToolExposureSurfaces) {
        const mode = current[surface];
        if (mode === base[surface])
            continue;
        count += 1;
    }
    return count;
}

function buildActionsSettingsSummaryProperties(value: unknown): Record<string, number> {
    const actions = value && typeof value === 'object' && !Array.isArray(value) && 'actions' in (value as Record<string, unknown>)
        ? (value as {
            actions?: Record<string, {
                enabled?: boolean;
                enabledPlacements?: ReadonlyArray<unknown>;
                disabledSurfaces?: ReadonlyArray<unknown>;
                disabledPlacements?: ReadonlyArray<unknown>;
                approvalRequiredSurfaces?: ReadonlyArray<unknown>;
                toolExposureModes?: unknown;
            }>;
        }).actions ?? {}
        : {};
    const defaultActions = DEFAULT_ACTIONS_SETTINGS_V1.actions ?? {};
    let enabledOverrideCount = 0;
    let enabledPlacementCount = 0;
    let disabledSurfaceCount = 0;
    let disabledPlacementCount = 0;
    let approvalRequiredSurfaceCount = 0;
    let toolExposureOverrideCount = 0;
    let overrideCount = 0;
    for (const [actionId, rawOverride] of Object.entries(actions)) {
        const normalized = normalizeOverride(rawOverride);
        const normalizedDefault = normalizeOverride((defaultActions as Record<string, unknown>)[actionId]);
        const isOverride = !areOverridesEqual(normalized, normalizedDefault);
        if (!isOverride)
            continue;
        overrideCount += 1;
        if (normalized.enabled !== null && normalized.enabled !== normalizedDefault.enabled) {
            enabledOverrideCount += 1;
        }
        enabledPlacementCount += countAddedStrings(normalized.enabledPlacements, normalizedDefault.enabledPlacements);
        disabledSurfaceCount += countAddedStrings(normalized.disabledSurfaces, normalizedDefault.disabledSurfaces);
        disabledPlacementCount += countAddedStrings(normalized.disabledPlacements, normalizedDefault.disabledPlacements);
        approvalRequiredSurfaceCount += countAddedStrings(normalized.approvalRequiredSurfaces, normalizedDefault.approvalRequiredSurfaces);
        toolExposureOverrideCount += countToolExposureOverrides(normalized.toolExposureModes, normalizedDefault.toolExposureModes);
    }
    return {
        overrideCount,
        enabledOverrideCount,
        enabledPlacementCount,
        disabledSurfaceCount,
        disabledPlacementCount,
        approvalRequiredSurfaceCount,
        toolExposureOverrideCount,
    };
}

function buildSessionAgentSpawnPolicySummaryProperties(value: unknown): Record<string, number> {
    const parsed = SessionAgentSpawnPolicyV1Schema.safeParse(value);
    const policy: SessionAgentSpawnPolicyV1 = parsed.success
        ? parsed.data
        : DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1;
    const booleanEntries = Object.entries(policy).filter(([, entry]) => typeof entry === 'boolean') as Array<[
        string,
        boolean
    ]>;
    return {
        disabledOverrideCount: booleanEntries.filter(([, entry]) => entry === false).length,
        hasPermissionCeiling: policy.permissionCeiling ? 1 : 0,
    };
}

function arrayCount(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function objectKeyCount(value: unknown): number {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value as Record<string, unknown>).length
        : 0;
}

function buildPinnedMeterSummaryProperties(value: unknown): Record<string, number> {
    const entries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value as Record<string, unknown>)
        : [];
    let profilesWithPinsCount = 0;
    let totalPinnedMeterCount = 0;
    for (const [, pinnedMeterIds] of entries) {
        if (!Array.isArray(pinnedMeterIds))
            continue;
        profilesWithPinsCount += 1;
        totalPinnedMeterCount += pinnedMeterIds.length;
    }
    return {
        profilesWithPinsCount,
        totalPinnedMeterCount,
    };
}

function buildQuotaSummaryStrategyProperties(value: unknown): Record<string, number> {
    const entries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.values(value as Record<string, unknown>)
        : [];
    let primaryCount = 0;
    let minRemainingCount = 0;
    for (const strategy of entries) {
        if (strategy === 'primary')
            primaryCount += 1;
        if (strategy === 'min_remaining')
            minRemainingCount += 1;
    }
    return {
        primaryCount,
        minRemainingCount,
    };
}

function bucketNumericSetting(value: number, smallMax: number, mediumMax: number): 'small' | 'medium' | 'large' {
    if (value <= smallMax)
        return 'small';
    if (value <= mediumMax)
        return 'medium';
    return 'large';
}

function buildProfileEnabledSummaryProperties(value: unknown): Record<string, number> {
    const entries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.values(value as Record<string, unknown>)
        : [];
    return {
        overrideCount: entries.length,
        enabledOverrideCount: entries.filter((entry) => entry === true).length,
        disabledOverrideCount: entries.filter((entry) => entry === false).length,
    };
}

function buildSessionTmuxOverrideSummaryProperties(value: unknown): Record<string, number> {
    const entries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.values(value as Record<string, unknown>)
        : [];

    let useTmuxCount = 0;
    let isolatedCount = 0;
    let customTmpDirCount = 0;

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;

        if (record.useTmux === true) useTmuxCount += 1;
        if (record.isolated === true) isolatedCount += 1;
        if (typeof record.tmpDir === 'string' && record.tmpDir.length > 0) customTmpDirCount += 1;
    }

    return {
        overrideCount: entries.length,
        useTmuxCount,
        isolatedCount,
        customTmpDirCount,
    };
}

function buildInstallablesPolicySummaryProperties(value: unknown): Record<string, number> {
    const machineEntries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.values(value as Record<string, unknown>)
        : [];

    let totalInstallableOverrideCount = 0;
    let autoInstallOverrideCount = 0;
    let autoUpdateOffCount = 0;
    let autoUpdateNotifyCount = 0;
    let autoUpdateAutoCount = 0;

    for (const machineEntry of machineEntries) {
        if (!machineEntry || typeof machineEntry !== 'object' || Array.isArray(machineEntry)) continue;
        const installableEntries = Object.values(machineEntry as Record<string, unknown>);

        totalInstallableOverrideCount += installableEntries.length;

        for (const installableEntry of installableEntries) {
            if (!installableEntry || typeof installableEntry !== 'object' || Array.isArray(installableEntry)) continue;
            const record = installableEntry as Record<string, unknown>;

            if (record.autoInstallWhenNeeded === true) autoInstallOverrideCount += 1;
            if (record.autoUpdateMode === 'off') autoUpdateOffCount += 1;
            if (record.autoUpdateMode === 'notify') autoUpdateNotifyCount += 1;
            if (record.autoUpdateMode === 'auto') autoUpdateAutoCount += 1;
        }
    }

    return {
        machineCount: machineEntries.length,
        totalInstallableOverrideCount,
        autoInstallOverrideCount,
        autoUpdateOffCount,
        autoUpdateNotifyCount,
        autoUpdateAutoCount,
    };
}

function buildPeerMediationPreferencesSummaryProperties(value: unknown): Record<string, number> {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as { byMachineId?: unknown; flows?: unknown }
        : {};
    const accountFlows = record.flows && typeof record.flows === 'object' && !Array.isArray(record.flows)
        ? Object.values(record.flows as Record<string, unknown>)
        : [];
    const machineEntries = record.byMachineId && typeof record.byMachineId === 'object' && !Array.isArray(record.byMachineId)
        ? Object.values(record.byMachineId as Record<string, unknown>)
        : [];

    let accountDirectOverrideCount = 0;
    let machineDirectOverrideCount = 0;
    let directEnabledCount = 0;
    let directDisabledCount = 0;

    const countFlowPreference = (entry: unknown, scope: 'account' | 'machine') => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
        const direct = (entry as Record<string, unknown>).direct;
        if (direct !== 'enabled' && direct !== 'disabled') return;
        if (scope === 'account') {
            accountDirectOverrideCount += 1;
        } else {
            machineDirectOverrideCount += 1;
        }
        if (direct === 'enabled') directEnabledCount += 1;
        if (direct === 'disabled') directDisabledCount += 1;
    };

    for (const entry of accountFlows) countFlowPreference(entry, 'account');
    for (const machineEntry of machineEntries) {
        if (!machineEntry || typeof machineEntry !== 'object' || Array.isArray(machineEntry)) continue;
        const flows = (machineEntry as Record<string, unknown>).flows;
        if (!flows || typeof flows !== 'object' || Array.isArray(flows)) continue;
        for (const entry of Object.values(flows as Record<string, unknown>)) {
            countFlowPreference(entry, 'machine');
        }
    }

    return {
        machineCount: machineEntries.length,
        accountDirectOverrideCount,
        machineDirectOverrideCount,
        directEnabledCount,
        directDisabledCount,
    };
}

function serializeNumericSettingBucket(smallMax: number, mediumMax: number) {
    return (value: number) => bucketNumericSetting(value, smallMax, mediumMax);
}

function buildOverrideCountSummaryProperties(value: unknown): Record<string, number> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { overrideCount: 0 };
    }
    return { overrideCount: Object.keys(value as Record<string, unknown>).length };
}

const ACCOUNT_CORE_CATALOG_DEFINITIONS = {
    analyticsOptOut: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'privacy'), trackAccountBoolean),
    crashReportsOptOut: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'privacy'), trackAccountBoolean),
    experiments: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'feature choices'), trackAccountBoolean),
    useEnhancedSessionWizard: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'session authoring'), trackAccountBoolean),
    memoryUseInNewSessions: accountPreference(z.boolean(), false, 'memory creation defaults'),
    memoryUpkeepInNewBots: accountPreference(z.boolean(), true, 'memory creation defaults'),
    memoryUseInNewBots: accountPreference(z.boolean(), true, 'memory creation defaults'),
    // Default ON. Replay is the only fork strategy available to an Agent whose
    // provider declares `sessionFork: unsupported` (Claude Code, among others),
    // and the fork gate is `native || replay` — so defaulting this off removed
    // the fork affordance entirely for exactly the sessions this setting exists
    // to serve. The same machinery is already default-on for the in-place Agent
    // switch. A user can still turn it off.
    sessionReplayEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'session replay'), trackAccountBoolean),
    useProfiles: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'profile presentation'), trackAccountBoolean),
    sessionPermissionModeApplyTiming: withAccountSettingAnalytics(accountPolicy(z.enum(['immediate', 'next_prompt']), 'immediate', 'permission mediation'), trackAccountEnum),
    sessionUseTmux: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'session terminal defaults'), trackAccountBoolean),
    sessionTerminalHost: withAccountSettingAnalytics(accountPreference(z.enum(['legacy', 'none', 'tmux', 'zellij', 'herdr']), 'legacy', 'session terminal defaults'), trackAccountEnum),
    sessionWindowsRemoteSessionLaunchMode: withAccountSettingAnalytics(accountPreference(z.enum(['hidden', 'windows_terminal', 'console']), 'hidden', 'session terminal defaults'), trackAccountEnum),
    sessionWindowsTerminalWindowName: accountPreference(z.string().check(z.maxLength(256)), 'happier', 'session terminal defaults'),
    // Machine lists run to dozens of machines; the picker leads with search (lab m-pick).
    useMachinePickerSearch: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'picker presentation'), trackAccountBoolean),
    usePathPickerSearch: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'picker presentation'), trackAccountBoolean),
    agentInputEnterToSend: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'composer presentation'), trackAccountBoolean),
    agentInputEnterToSendNative: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'composer presentation'), trackAccountBoolean),
    alwaysShowContextSize: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'composer presentation'), trackAccountBoolean),
    sessionComposerRememberBannerVisibility: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'composer presentation'), trackAccountBoolean),
    visualEffectsLevel: withAccountSettingAnalytics(accountPreference(z.enum(['full', 'subtle', 'minimal']), 'full', 'motion presentation'), trackAccountEnum),
    contextGaugeStyle: withAccountSettingAnalytics(accountPreference(z.enum(['gauge', 'text', 'hidden']), 'gauge', 'composer presentation'), trackAccountEnum),
    animatedNumbers: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'motion presentation'), trackAccountBoolean),
    agentInputHistoryScope: withAccountSettingAnalytics(accountPreference(z.enum(['perSession', 'global']), 'perSession', 'composer history presentation'), trackAccountEnum),
    agentInputActionBarLayout: withAccountSettingAnalytics(accountPreference(AgentInputActionBarLayoutSchema, 'auto', 'composer presentation'), trackAccountEnum),
    agentInputChipDensity: withAccountSettingAnalytics(accountPreference(z.enum(['auto', 'labels', 'icons']), 'auto', 'composer presentation'), trackAccountEnum),
    sessionListDensity: withAccountSettingAnalytics(accountPreference((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw): unknown => raw === 'compact' ? 'cozy' : raw), z.enum(['detailed', 'cozy', 'narrow'])), 'narrow', 'session list presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        derivedPropertyValueKinds: {
            compact_session_view: 'boolean',
            compact_session_view_minimal: 'boolean',
        },
        serializeDerivedProperties: (value: 'detailed' | 'cozy' | 'narrow') => ({
            compact_session_view: value === 'cozy' || value === 'narrow',
            compact_session_view_minimal: value === 'narrow',
        }),
    }),
    collectionSpacesV1: accountPreference(CollectionSpacesV1Schema, { v: 1, spaces: [] }, 'collection saved filters', ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES),
    // Presentation host owns column policy; Account storage carries its keyed JSON preferences.
    collectionColumnPreferencesV1: accountPreference(z.record(z.string(), StrictJsonValueSchema), {}, 'collection column presentation', ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES),
    collectionDisplayPreferencesV1: accountPreference(z.looseObject({
        workflow: z.optional(z.looseObject({
            presentation: z.optional(CollectionTableCardPresentationSchema),
            groupBy: z.optional(CollectionWorkflowGroupingSchema),
            lines: z.optional(CollectionLinesSchema),
            details: z.optional(CollectionPluginDetailPreferencesSchema),
        })),
        workflowRun: z.optional(z.looseObject({
            groupBy: z.optional(CollectionWorkflowRunGroupingSchema),
            lines: z.optional(CollectionLinesSchema),
            details: z.optional(CollectionPluginDetailPreferencesSchema),
        })),
        sessionWork: z.optional(z.looseObject({ details: z.optional(SessionCollectionRowDetailsSchema) })),
        artifact: z.optional(z.looseObject({ presentation: z.optional(CollectionArtifactPresentationSchema) })),
    }), {}, 'collection display'),
    collectionSpacesEnabled: accountPreference(CollectionSpacesEnabledV1Schema, true, 'collection spaces enablement'),
    sessionSpacesEnabled: accountPreference(CollectionSpacesEnabledV1Schema, true, 'collection spaces enablement'),
    reviewSpacesEnabled: accountPreference(CollectionSpacesEnabledV1Schema, true, 'collection spaces enablement'),
    reviewQualityAggregation: accountPreference(ReviewQualityAggregationV1Schema, 'lowest', 'review quality aggregation'),
    workflowRunSpacesEnabled: accountPreference(CollectionSpacesEnabledV1Schema, true, 'collection spaces enablement'),
    workflowSpacesEnabled: accountPreference(CollectionSpacesEnabledV1Schema, true, 'collection spaces enablement'),
    discussionSpacesEnabled: accountPreference(CollectionSpacesEnabledV1Schema, true, 'collection spaces enablement'),
    deploymentEnvironmentSpacesEnabled: accountPreference(CollectionSpacesEnabledV1Schema, true, 'collection spaces enablement'),
    sessionListLayoutV1: withAccountSettingAnalytics(accountPreference(z.enum(['projects', 'recent_activity']), 'projects', 'session list presentation'), trackAccountEnum),
    sessionListAttentionPlacementV1: withAccountSettingAnalytics(accountPreference(z.enum(['both', 'top', 'inPlace']), 'both', 'session list presentation'), trackAccountEnum),
    sessionListRowContextV1: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'session list presentation'), trackAccountBoolean),
    sessionListStatusWords: accountPreference(z.boolean(), false, 'work status presentation'),
    // Restored 0.2 choices (owner amendment 2026-11-01): the working row mark as a spinner or a pulsing dot, and
    // a playful working word when status words are on.
    sessionListNarrowWorkingIndicatorStyle: accountPreference(z.enum(['spinner', 'pulse']), 'spinner', 'work status presentation'),
    sessionListWorkingStatusAnimatedTextEnabled: accountPreference(z.boolean(), true, 'work status presentation'),
    sessionListIdentityDisplay: withAccountSettingAnalytics(accountPreference(SessionListIdentityDisplaySchema, 'auto', 'session list presentation'), trackAccountEnum),
    sessionHeaderIdentityDisplay: withAccountSettingAnalytics(accountPreference(z.enum(['avatar', 'agentLogo', 'none']), 'avatar', 'session header presentation'), trackAccountEnum),
    sessionListBackgroundWorkAttentionModeV1: withAccountSettingAnalytics(accountPreference(z.enum(SESSION_LIST_BACKGROUND_WORK_ATTENTION_MODE_VALUES), 'keepWorking', 'session list presentation'), trackAccountEnum),
    sessionListAttentionStandingDefaultV1: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'session list presentation'), trackAccountBoolean),
    workspaceFaviconsEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'session list presentation'), trackAccountBoolean),
    showFlavorIcons: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'application chrome'), trackAccountBoolean),
    avatarStyle: withAccountSettingAnalytics(accountPreference(AvatarStyleSchema, 'brutalist', 'avatar presentation'), trackAccountEnum),
    botFaceStyle: withAccountSettingAnalytics(accountPreference(BotFaceStyleSchema, 'dither', 'Bot face presentation'), trackAccountEnum),
    botMotion: accountPreference(BotMotionSchema, 'lively', 'Bot motion presentation'),
    homeBotFacesEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'Home presentation'), trackAccountBoolean),
    hideInactiveSessions: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'session list presentation'), trackAccountBoolean),
    sessionListActiveColorModeV1: withAccountSettingAnalytics(accountPreference(z.enum(['activityAndAttention', 'attentionOnly', 'allActive']), 'activityAndAttention', 'session list presentation'), trackAccountEnum),
    sessionMessageSendMode: withAccountSettingAnalytics(accountPolicy(z.enum(['agent_queue', 'interrupt', 'server_pending']), 'server_pending', 'message delivery'), trackAccountEnum),
    sessionBusySteerSendPolicy: withAccountSettingAnalytics(accountPolicy(z.enum(['steer_immediately', 'server_pending']), 'steer_immediately', 'message delivery'), trackAccountEnum),
    sessionNonSteerableSendPrompt: withAccountSettingAnalytics(accountPreference(z.enum(['on', 'off']), 'on', 'message delivery'), trackAccountEnum),
    sessionProviderUsageGaugeMode: withAccountSettingAnalytics(accountPreference(z.enum(['auto', 'hidden']), 'auto', 'usage presentation'), trackAccountEnum),
    sessionProviderUsageGaugeWindowModes: withAccountSettingAnalytics(accountPreference(z.nullable(z.array(z.enum(SESSION_PROVIDER_USAGE_GAUGE_WINDOW_MODES)).check(z.minLength(1))), null, 'usage presentation'), { trackCurrentState: false, trackChanges: false, valueKind: 'count', privacy: 'safe', identityScope: 'person' }),
    sessionUsageGaugeLabels: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'usage presentation'), trackAccountBoolean),
    sessionProviderUsageGaugeWindowMode: withAccountSettingAnalytics(accountPreference(z.enum(SESSION_PROVIDER_USAGE_GAUGE_WINDOW_MODES), 'most_constrained', 'usage presentation'), trackAccountEnum),
} as const;
const ACCOUNT_DISPLAY_CATALOG_DEFINITIONS = {
    sessionThinkingDisplayMode: withAccountSettingAnalytics(accountPreference(z.enum(['inline', 'tool', 'hidden']), 'inline', 'transcript presentation'), trackAccountEnum),
    sessionThinkingInlinePresentation: withAccountSettingAnalytics(accountPreference(z.enum(['full', 'summary']), 'summary', 'transcript presentation'), trackAccountEnum),
    sessionThinkingInlineChrome: withAccountSettingAnalytics(accountPreference(z.enum(['plain', 'card']), 'plain', 'transcript presentation'), trackAccountEnum),
    showLineNumbers: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'code presentation'), trackAccountBoolean),
    showLineNumbersInToolViews: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'tool presentation'), trackAccountBoolean),
    showChatCodeBlockWrapControls: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'code presentation'), trackAccountBoolean),
    wrapChatCodeBlocks: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'code presentation'), trackAccountBoolean),
    wrapLinesInDiffs: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'code presentation'), trackAccountBoolean),
    sessionReplayStrategy: withAccountSettingAnalytics(accountPreference(z.enum(['recent_messages', 'summary_plus_recent']), 'recent_messages', 'session replay'), trackAccountEnum),
    // Bounds come from the one Replay-budget owner. A stored value outside them
    // recovers to the default: a budget below the floor produced no seed at all.
    sessionReplayRecentMessagesCount: withAccountSettingAnalytics(accountPreference(HappierReplayRecentMessagesCountSchema, 250, 'session replay'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: (value: number) => bucketNumericSetting(value, 100, 300),
    }),
    sessionReplayMaxSeedChars: withAccountSettingAnalytics(accountCatalogDefinition(z.union([HappierReplayWritableMaxSeedCharsSchema, z.pipe(HappierReplayWireMaxSeedCharsSchema, z.transform(() => 120000))]), 120000, {
        semanticDomain: 'session replay', classification: 'preference', maximumSerializedValueBytes: 4 * 1024,
        mutationSchema: HappierReplayWritableMaxSeedCharsSchema,
    }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: (value: number) => bucketNumericSetting(value, 80000, 200000),
    }),
    executionRunsGuidanceEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'execution guidance'), trackAccountBoolean),
    executionRunsNotifyParentOnCompletionDefault: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'execution guidance'), trackAccountBoolean),
    filesAskWithoutSessionTarget: withAccountSettingAnalytics(accountPreference(z.enum(['detached_run', 'session']), 'detached_run', 'file selection Ask'), trackAccountEnum),
    executionRunsGuidanceMaxChars: withAccountSettingAnalytics(accountPreference(z.number().check(z.int(), z.minimum(1), z.maximum(64 * 1024)), 4000, 'execution guidance'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: (value: number) => bucketNumericSetting(value, 2000, 5000),
    }),
    attachmentsUploadsUploadLocation: withAccountSettingAnalytics(accountPreference(z.enum(['workspace', 'os_temp']), 'workspace', 'attachment uploads'), trackAccountEnum),
    attachmentsUploadsWorkspaceRelativeDir: accountCatalogDefinition(z.string().check(z.minLength(1), z.maxLength(4 * 1024)), '.happier/uploads', {
        semanticDomain: 'attachment uploads', classification: 'preference', maximumSerializedValueBytes: 4 * 1024,
        mutationSchema: z.pipe(z.pipe(z.string().check(z.minLength(1), z.maxLength(4 * 1024)),
            z.transform(normalizeAttachmentsUploadsWorkspaceRelativeDir)), z.string()),
    }),
    attachmentsUploadsVcsIgnoreStrategy: withAccountSettingAnalytics(accountPreference(z.enum(['git_info_exclude', 'gitignore', 'none']), 'git_info_exclude', 'attachment uploads'), trackAccountEnum),
    attachmentsUploadsVcsIgnoreWritesEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'attachment uploads'), trackAccountBoolean),
    attachmentsUploadsMaxFileBytes: withAccountSettingAnalytics(accountPolicy(z.number().check(z.int(), z.minimum(1), z.maximum(MAX_ATTACHMENT_UPLOAD_FILE_BYTES_V1)), DEFAULT_ATTACHMENT_UPLOAD_MAX_FILE_BYTES_V1, 'attachment uploads'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: (value: number) => bucketNumericSetting(value, 10 * 1024 * 1024, 50 * 1024 * 1024),
    }),
    sessionTagsEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'session list presentation'), trackAccountBoolean),
    // Tag ids belong to a Home; identical ids on another Home do not inherit this choice.
    sessionListHiddenTagIdsWhileRecording: withAccountSettingAnalytics(accountPreference(z.record(z.string(), z.array(z.string())), {}, 'session list presentation'), { trackCurrentState: false, trackChanges: false, valueKind: 'presence', privacy: 'forbidden', identityScope: 'person' }),
    mobileWorkspaceExperienceV1: withAccountSettingAnalytics(accountPreference(z.enum(['classic', 'cockpit']), 'cockpit', 'mobile workspace presentation'), trackAccountEnum),
    workspaceTabsSyncEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'workspace open tabs'), trackAccountBoolean),
    sessionCockpitSwipeNavigationEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'mobile workspace presentation'), trackAccountBoolean),
    sessionCockpitSwipeAlwaysSessionsEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'mobile workspace presentation'), trackAccountBoolean),
    sessionCockpitSwipeSource: withAccountSettingAnalytics(accountPreference(z.enum(['list', 'recent']), 'list', 'mobile workspace presentation'), trackAccountEnum),
    sessionSwitcherDragUpEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'mobile workspace presentation'), trackAccountBoolean),
    sessionSwitcherDragUpSource: withAccountSettingAnalytics(accountPreference(z.enum(['recent', 'list']), 'recent', 'mobile workspace presentation'), trackAccountEnum),
    sessionSwitcherFlickEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'mobile workspace presentation'), trackAccountBoolean),
    sessionSwitcherHoldToDockEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'mobile workspace presentation'), trackAccountBoolean),
    sessionHeaderPullAllTabsEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'mobile workspace presentation'), trackAccountBoolean),
    tabBarGitBadgeMode: withAccountSettingAnalytics(accountPreference(z.enum(['changedFiles', 'diffLines', 'off']), 'changedFiles', 'application chrome'), trackAccountEnum),
    tabBarFriendsBadgeEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'application chrome'), trackAccountBoolean),
    tabBarInboxBadgeEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'application chrome'), trackAccountBoolean),
    tabBarSessionsBadgeEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'application chrome'), trackAccountBoolean),
    tabBarOpenTabsBadgeEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'application chrome'), trackAccountBoolean),
    tabBarShowLabels: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'application chrome'), trackAccountBoolean),
    tabBarSize: withAccountSettingAnalytics(accountPreference(z.enum(['compact', 'regular', 'large']), 'regular', 'application chrome'), trackAccountEnum),
    glassBlurEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'application chrome'), trackAccountBoolean),
    glassBlurIntensity: withAccountSettingAnalytics(accountPreference(z.enum(['light', 'regular', 'strong']), 'regular', 'application chrome'), trackAccountEnum),
    glassTintIntensity: withAccountSettingAnalytics(accountPreference(GlassTintIntensitySchema, DEFAULT_GLASS_TINT_INTENSITY, 'application chrome'), { trackCurrentState: true, trackChanges: true, valueKind: 'count', privacy: 'safe', identityScope: 'person' }),
    glassSurfaceMaterials: accountCatalogDefinition(z.nullable(GlassSurfaceMaterialsStoredSchema), null, {
        semanticDomain: 'application chrome', classification: 'preference', maximumSerializedValueBytes: 4 * 1024,
        mutationSchema: z.nullable(GlassSurfaceMaterialsSchema),
    }),
    homeAtmosphere: withAccountSettingAnalytics(accountCatalogDefinition(HomeAtmosphereSchema, DEFAULT_HOME_ATMOSPHERE, {
        semanticDomain: 'Home atmosphere', classification: 'preference',
        maximumSerializedValueBytes: ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES,
    }), { trackCurrentState: false, trackChanges: false, valueKind: 'presence', privacy: 'forbidden', identityScope: 'person' }),
    homeBackgroundField: accountPreference(z.enum(HOME_BACKGROUND_FIELD_MODES), 'animated', 'Home atmosphere'),
    composerSurfaceStyle: withAccountSettingAnalytics(accountPreference(z.enum(['standard', 'glass']), 'glass', 'composer presentation'), trackAccountEnum),
} as const;
const BoundedLegacyArraySchema = defineStoredReadProjection(lazyDefinition(() => z.array(BoundedLegacyJsonValueSchema).check(z.maxLength(256))), () => z.array(createStoredReadSchema(BoundedLegacyJsonValueSchema)));
const BoundedLegacyRecordSchema = defineStoredReadProjection(lazyDefinition(() => z.record(z.string().check(z.maxLength(64 * 1024)), BoundedLegacyJsonValueSchema)), () => z.record(z.string(), createStoredReadSchema(BoundedLegacyJsonValueSchema)));
const SavedSecretsSchema = defineStoredReadProjection(lazyDefinition(() => z.array(SavedSecretSchema).check(z.maxLength(SAVED_SECRET_COLLECTION_MAX_ENTRIES))), () => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value): unknown => {
    if (!Array.isArray(value))
        return value;
    const storedSecretSchema = createStoredReadSchema(SavedSecretSchema);
    return value.flatMap((candidate) => {
        const parsed = storedSecretSchema.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
    });
}), z.array(createStoredReadSchema(SavedSecretSchema))));
// Import-only source grammar, not current writable catalog definitions.
// Stored-read projections retain predecessor cardinality and bytes; the raw
// document's existing budget still applies at the enclosing writer.
const RETAINED_ACCOUNT_SETTINGS_ENTITY_SOURCES = {
    profiles: BoundedLegacyArraySchema,
    secretBindingsByProfileId: BoundedLegacyRecordSchema,
    promptStacksV1: PromptStacksV1Schema,
    rolesV1: RolesV1Schema,
    promptFoldersV1: PromptFoldersV1Schema,
    promptInvocationsV1: PromptInvocationsV1Schema,
    promptExternalLinksV1: PromptExternalLinksV1Schema,
    // Retained source custody only; registry-sources row admission is the sole domain reader.
    promptRegistrySourcesV1: z.optional(z.unknown()),
    contextSelectionsV1: ContextSelectionsV1Schema,
    executionRunsGuidanceEntries: BoundedLegacyArraySchema,
} as const;

const RESOURCE_OWNED_SETTINGS_SOURCE_KEYS = new Set([
    // AuthoringMemory owns current values; raw Account sources stay import-only.
    'recentMachinePaths', 'lastUsedProfile', 'lastEngineSelectionsByScopeV1',
    ...CONNECTED_ACCOUNT_CATALOG_TRANSFERRED_ROOTS_V1.purposes,
    'remoteHostsV1', 'notificationChannelsV1', 'connectedServicesProfileLabelByKey',
    'connectedServicesCollapsedItemKeysV1', 'connectedServicesDefaultAuthPoolAdoptionDismissedByKey', 'dismissedCLIWarnings',
]);

// Read provenance: 0.2 Account core/display-setting definitions (including its
// unsuffixed background-work key). These inputs never enter effective settings
// or new mutations; only the ingress below may translate authored intent.
const RETIRED_SESSION_LIST_SETTING_KEYS = new Set([
    'sessionListSectionModeV1', 'sessionListActiveGroupingV1', 'sessionListInactiveGroupingV1',
    'sessionListOrderingModeV1', 'sessionListAttentionPromotionModeV1', 'sessionListWorkingPlacementModeV1',
    'sessionFolderViewModeV1', 'sessionListFolderSortModeV1', 'groupInactiveSessionsByProject',
    'sessionListSeparateBackgroundWorkV1', 'sessionListSeparateBackgroundWork',
    'workspaceMachineSubtitlesEnabled', 'workspacePathDisplayModeV1',
]);

function projectSessionListPreferenceIngress(raw: Record<string, unknown>): Record<string, unknown> {
    const next = { ...raw };
    if (raw.sessionListLayoutV1 !== 'projects' && raw.sessionListLayoutV1 !== 'recent_activity') {
        next.sessionListLayoutV1 = raw.sessionListSectionModeV1 === 'single'
            && raw.sessionListActiveGroupingV1 === 'date' ? 'recent_activity' : 'projects';
    }
    if (raw.sessionListAttentionPlacementV1 !== 'both' && raw.sessionListAttentionPlacementV1 !== 'top'
        && raw.sessionListAttentionPlacementV1 !== 'inPlace') {
        const attention = raw.sessionListAttentionPromotionModeV1;
        const working = raw.sessionListWorkingPlacementModeV1;
        next.sessionListAttentionPlacementV1 = attention === 'off' && working === 'off' ? 'inPlace'
            : attention === 'global' && working === 'global' ? 'top' : 'both';
    }
    for (const key of RETIRED_SESSION_LIST_SETTING_KEYS) delete next[key];
    return next;
}

/** Pending/input deltas cannot author raw carriers; captured baselines are preserved separately. */
export function isAccountSettingsReadOnlySourceKeyV1(key: string): boolean {
    return Object.hasOwn(RETAINED_ACCOUNT_SETTINGS_ENTITY_SOURCES, key)
        || RETIRED_SESSION_LIST_SETTING_KEYS.has(key)
        || RESOURCE_OWNED_SETTINGS_SOURCE_KEYS.has(key)
        || key === 'themeProfiles'
        || key === 'inferenceOpenAIKey';
}

/** Read-only provenance admission; undefined means this is not a retained entity source. */
export function parseRetainedAccountSettingsEntitySourceV1(key: string, value: unknown): AccountSettingValueParseResult | undefined {
    if (!Object.hasOwn(RETAINED_ACCOUNT_SETTINGS_ENTITY_SOURCES, key)) return undefined;
    return parseAccountSettingMutationValue(
        RETAINED_ACCOUNT_SETTINGS_ENTITY_SOURCES[key as keyof typeof RETAINED_ACCOUNT_SETTINGS_ENTITY_SOURCES], value, true);
}

const ACCOUNT_LEGACY_ROOT_CATALOG_DEFINITIONS = {
    // Rowless builtin enablement remains an ordinary Settings preference.
    profileEnabledById: withAccountSettingAnalytics(accountLegacy(BoundedLegacyRecordSchema, {}, 'profile entity state', 32 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildProfileEnabledSummaryProperties,
    }),
    secrets: withAccountSettingAnalytics(accountLegacy(SavedSecretsSchema, [], 'saved-secret records', ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES, false), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: (value: unknown) => (Array.isArray(value) ? value.length : 0),
    }),
    mcpServersStrictMode: accountPreference(z.boolean(), false, 'MCP server enforcement policy'),
    pinnedSessionKeysV1: accountLegacy(z.array(z.string().check(z.maxLength(1024))).check(z.maxLength(256)), [], 'session organization pins', 32 * 1024),
    workspaceLabelsV1: accountLegacy(BoundedLegacyRecordSchema, {}, 'workspace labels', 32 * 1024),
    sessionTagsV1: accountLegacy(BoundedLegacyRecordSchema, {}, 'session tags', 64 * 1024),
    sessionListGroupOrderV1: accountLegacy(BoundedLegacyRecordSchema, {}, 'session organization ordering', 64 * 1024),
    sessionWorkspaceOrderV1: accountLegacy(BoundedLegacyRecordSchema, {}, 'session organization ordering', 64 * 1024),
    sessionFoldersV1: accountLegacy(BoundedLegacyJsonValueSchema, { v: 1, folders: [] }, 'session folder entities', 128 * 1024),
    voiceSettingsV1: accountLegacy(BoundedLegacyJsonValueSchema, {}, 'voice configuration', 128 * 1024),
    voice: withAccountSettingAnalytics(accountLegacy(BoundedLegacyJsonValueSchema, {}, 'legacy voice configuration', 128 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: emptyRuntimeSettingProperties,
    }),
    voiceDiagnosticsV1: accountLegacy(BoundedLegacyJsonValueSchema, {}, 'voice diagnostics', 64 * 1024),
} as const;
const ACCOUNT_CONNECTED_SERVICES_CATALOG_DEFINITIONS = {
    connectedServicesDefaultProfileByServiceId: withAccountSettingAnalytics(accountPreference(z.record(z.string().check(z.maxLength(1024)), z.string().check(z.maxLength(1024))), {}, 'connected service defaults', 32 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: objectKeyCount,
    }),
    connectedServicesQuotaPinnedMeterIdsByKey: withAccountSettingAnalytics(accountPreference(z.record(z.string().check(z.maxLength(1024)), z.array(z.string().check(z.maxLength(1024))).check(z.maxLength(256))), {}, 'connected service presentation', 64 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildPinnedMeterSummaryProperties,
    }),
    connectedServicesQuotaSummaryStrategyByKey: withAccountSettingAnalytics(accountPreference(z.record(z.string().check(z.maxLength(1024)), z.enum(['primary', 'min_remaining'])), {}, 'connected service presentation', 32 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildQuotaSummaryStrategyProperties,
    }),
} as const;
const ACCOUNT_SIMPLE_COLLECTION_CATALOG_DEFINITIONS = {
    favoriteDirectories: withAccountSettingAnalytics(accountPreference(z.array(z.string().check(z.maxLength(16 * 1024))).check(z.maxLength(256)), [], 'favorite directories', 128 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    }),
    favoriteMachines: withAccountSettingAnalytics(accountPreference(z.array(z.string().check(z.maxLength(1024))).check(z.maxLength(256)), [], 'favorite machines', 32 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    }),
    // Retained Profile identities and collection size come from the predecessor
    // favorite writer, not new Profile authoring. The Account document owns bytes.
    favoriteProfiles: withAccountSettingAnalytics(accountCatalogDefinition(z.array(z.string()), [], {
        semanticDomain: 'favorite profiles', classification: 'preference',
        maximumSerializedValueBytes: ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES,
        structuralBoundsOwner: 'domainOwned',
    }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    }),
    // Preferences keep the bound, not the legacy carrier's size-tolerant read projection.
    favoriteModelSelectionsV1: withAccountSettingAnalytics(accountPreference(z.core.clone(BoundedLegacyArraySchema), [], 'favorite model selections', 64 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    }),
    // Read through the canonical key owner: 0.2's `agent:<id>` favorites read as the targets the catalog offers.
    favoriteBackendTargetKeysV1: withAccountSettingAnalytics(accountCatalogDefinition(z.pipe(z.array(z.string().check(z.maxLength(1024))).check(z.maxLength(256)),
        z.transform(value => FavoriteBackendTargetKeysV1Schema.parse(value))), [], {
        semanticDomain: 'favorite backend targets', classification: 'preference', maximumSerializedValueBytes: 32 * 1024,
        mutationSchema: z.pipe(z.array(z.pipe(z.string().check(z.trim(), z.maxLength(1024)), BackendTargetKeyV2Schema)).check(z.maxLength(256)),
            z.transform(value => FavoriteBackendTargetKeysV1Schema.parse(value))),
    }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: arrayCount,
    }),
} as const;
const KeyboardShortcutRuleSchema = lazyDefinition(() => z.object({
    binding: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    platforms: z.optional(z.array(z.enum(['macos', 'ios', 'windows', 'linux', 'android', 'web'])).check(z.maxLength(6))),
    blockedSurfaces: z.optional(z.array(z.enum(['native', 'web'])).check(z.maxLength(2))),
    allowInEditable: z.optional(z.boolean()),
    nativeConsumable: z.optional(z.boolean()),
    conflictScope: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
}));
const KeyboardShortcutCommandIdSchema = lazyDefinition(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const KeyboardShortcutOverridesSchema = lazyDefinition(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const normalized: Record<string, unknown> = {};
    for (const [rawCommandId, rawRules] of Object.entries(value).slice(0, 256)) {
        const commandId = KeyboardShortcutCommandIdSchema.safeParse(rawCommandId);
        if (!commandId.success || !Array.isArray(rawRules))
            continue;
        const rules = rawRules.slice(0, 32).flatMap((candidate) => {
            const parsed = KeyboardShortcutRuleSchema.safeParse(candidate);
            return parsed.success ? [parsed.data] : [];
        });
        if (rules.length === 0)
            continue;
        Object.defineProperty(normalized, commandId.data, {
            value: rules,
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return normalized;
}), z.record(KeyboardShortcutCommandIdSchema, z.array(KeyboardShortcutRuleSchema).check(z.minLength(1), z.maxLength(32)))));
const KeyboardShortcutDisabledCommandIdsSchema = lazyDefinition(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value): unknown => {
    if (!Array.isArray(value))
        return [];
    return value.slice(0, 256).flatMap((candidate) => {
        const parsed = KeyboardShortcutCommandIdSchema.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
    });
}), z.array(KeyboardShortcutCommandIdSchema).check(z.maxLength(256))));

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
  'docked',
] as const;

export const NEW_SESSION_BACKDROP_STRENGTHS = ['subtle', 'soft', 'medium', 'rich'] as const;

export const NEW_SESSION_DRAFT_ENTRY_MODES = [
  'resumePrevious',
  'alwaysFresh',
] as const;

export const NEW_SESSION_AFTER_SEND_MODES = [
  'open',
  'startAnother',
] as const;

export type NewSessionWizardSelectionSectionId = typeof NEW_SESSION_WIZARD_SELECTION_SECTION_IDS[number];
export type NewSessionWizardSectionPresentation = typeof NEW_SESSION_WIZARD_SECTION_PRESENTATIONS[number];
export type NewSessionPresentationModeV1 = typeof NEW_SESSION_PRESENTATION_MODES[number];
export type NewSessionBackdropStrengthV1 = typeof NEW_SESSION_BACKDROP_STRENGTHS[number];
export type NewSessionDraftEntryMode = typeof NEW_SESSION_DRAFT_ENTRY_MODES[number];
export type NewSessionAfterSendMode = typeof NEW_SESSION_AFTER_SEND_MODES[number];
const NewSessionWizardSectionIdSchema = lazyDefinition(() => z.enum(NEW_SESSION_WIZARD_SELECTION_SECTION_IDS));
const NewSessionWizardSectionPresentationSchema = lazyDefinition(() => z.enum(NEW_SESSION_WIZARD_SECTION_PRESENTATIONS));

export function resolveNewSessionWizardSectionPresentation(
  setting: Partial<Record<NewSessionWizardSelectionSectionId, NewSessionWizardSectionPresentation>> | null | undefined,
  sectionId: NewSessionWizardSelectionSectionId,
): NewSessionWizardSectionPresentation {
  return setting?.[sectionId] ?? 'auto';
}
const NewSessionWizardSectionPresentationByIdSchema = lazyDefinition(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value): unknown => {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    return Object.fromEntries(Object.entries(record).flatMap(([sectionId, presentation]) => {
        if (!NewSessionWizardSectionIdSchema.safeParse(sectionId).success)
            return [];
        if (!NewSessionWizardSectionPresentationSchema.safeParse(presentation).success)
            return [];
        return [[sectionId, presentation]];
    }));
}), z._default(z.partialRecord(NewSessionWizardSectionIdSchema, NewSessionWizardSectionPresentationSchema), {})));
const ACCOUNT_SESSION_AUTHORING_CATALOG_DEFINITIONS = {
    sessionDefaultPermissionModeByTargetKey: withAccountSettingAnalytics(accountPolicy(z.record(BackendTargetKeyV2InputSchema, z.enum(SESSION_PERMISSION_MODES)), {}, 'default permission mode', 32 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: emptyRuntimeSettingProperties,
    }),
    sessionIdleCompactionEnabledByTargetKey: accountPreference(z.record(BackendTargetKeyV2InputSchema, z.boolean()), {}, 'idle compaction', 32 * 1024),
    sessionIdleCompactionMinContextTokensByTargetKey: accountPreference(z.record(BackendTargetKeyV2InputSchema, z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))), {}, 'idle compaction', 32 * 1024),
    sessionIdleCompactionCacheWindowOverrideMsByTargetKey: accountPreference(z.record(BackendTargetKeyV2InputSchema, z.number().check(z.int(), z.positive(), z.maximum(MAX_IDLE_COMPACTION_CACHE_WINDOW_MS))), {}, 'idle compaction', 32 * 1024),
    newSessionDefaultPersistenceModeV1: accountPreference(z.enum(['direct', 'persisted']), 'persisted', 'session authoring'),
    newSessionDefaultPersistenceModeByTargetKeyV1: accountPreference(z.record(BackendTargetKeyV2InputSchema, z.enum(['direct', 'persisted'])), {}, 'session authoring', 32 * 1024),
    newSessionDraftEntryMode: accountPreference(z.enum(NEW_SESSION_DRAFT_ENTRY_MODES), 'resumePrevious', 'session authoring'),
    // null until the person chooses: the Docked composer then stays, every other presentation opens.
    newSessionAfterSendV1: accountPreference(z.nullable(z.enum(NEW_SESSION_AFTER_SEND_MODES)), null, 'session authoring'),
    rememberLastProjectSessionSelections: accountPreference(z.boolean(), true, 'session authoring'),
    rememberLastEngineSelectionsV1: accountPreference(z.boolean(), true, 'session authoring'),
    newSessionPresentationModeV1: accountPreference(z.enum(NEW_SESSION_PRESENTATION_MODES), 'docked', 'session authoring'),
    newSessionBackdropStrengthV1: accountPreference(z.enum(NEW_SESSION_BACKDROP_STRENGTHS), 'soft', 'session authoring'),
    newSessionWizardSectionPresentationV1: accountPreference(NewSessionWizardSectionPresentationByIdSchema, {}, 'session authoring'),
    newSessionWizardColumnsEnabled: accountPreference(z.boolean(), false, 'session authoring'),
    commandPaletteEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'keyboard shortcuts'), trackAccountBoolean),
    keyboardShortcutsV2Enabled: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'keyboard shortcuts'), trackAccountBoolean),
    keyboardSingleKeyShortcutsEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'keyboard shortcuts'), trackAccountBoolean),
    keyboardShortcutOverridesV1: withAccountSettingAnalytics(accountPreference(KeyboardShortcutOverridesSchema, {}, 'keyboard shortcuts', 64 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: objectKeyCount,
    }),
    keyboardShortcutDisabledCommandIdsV1: withAccountSettingAnalytics(accountPreference(KeyboardShortcutDisabledCommandIdsSchema, [], 'keyboard shortcuts', 32 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: (value: readonly unknown[]) => value.length,
    }),
    petsEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'pet preferences'), trackAccountBoolean),
    petsSelectedPetRef: accountPreference(PetAccountReferenceV1Schema, { kind: 'builtIn', petId: 'blink' }, 'pet preferences'),
    petsDesktopOverlayDefaultEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'pet preferences'), trackAccountBoolean),
} as const;
const ACCOUNT_SCM_AND_FILES_CATALOG_DEFINITIONS = {
    scmGitIdentity: accountPreference(z.nullable(ScmGitIdentitySchema), null, 'source control'),
    scmCommitStrategy: withAccountSettingAnalytics(accountPreference(z.enum(['atomic', 'git_staging']), 'atomic', 'source control'), trackAccountEnum),
    scmGitRepoPreferredBackend: withAccountSettingAnalytics(accountPreference(z.enum(['git', 'sapling']), 'git', 'source control'), trackAccountEnum),
    scmGitRepoPreferredBackendQualifiedId: withAccountSettingAnalytics(accountPreference(z.nullable(ScmBackendQualifiedIdSchema), null, 'source control'), trackAccountEnum),
    scmRemoteConfirmPolicy: withAccountSettingAnalytics(accountPreference(z.enum(['always', 'pull_only', 'push_only', 'never']), 'always', 'source control'), trackAccountEnum),
    scmPushRejectPolicy: withAccountSettingAnalytics(accountPreference(z.enum(['prompt_fetch', 'auto_fetch', 'manual']), 'prompt_fetch', 'source control'), trackAccountEnum),
    scmUncommittedChangesStrategy: withAccountSettingAnalytics(accountPreference(z.enum(['ask', 'always_bring', 'always_stash']), 'ask', 'source control'), trackAccountEnum),
    scmDefaultDiffModeByBackend: withAccountSettingAnalytics(accountPreference(z._default(z.record(accountBoundedString(256), z.enum(['included', 'pending', 'both'])), {}), {}, 'source control', 32 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildOverrideCountSummaryProperties,
    }),
    scmAskBeforeOverwritingBranchStash: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'source control'), trackAccountBoolean),
    scmReviewMaxFiles: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 25, 'source control'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(25, 50),
    }),
    scmReviewMaxChangedLines: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 2000, 'source control'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(2000, 4000),
    }),
    scmDiffCacheMaxEntries: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 30, 'source control'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(10, 30),
    }),
    scmDiffCacheMaxTotalBytes: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 20 * 1024 * 1024, 'source control'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(10 * 1024 * 1024, 50 * 1024 * 1024),
    }),
    scmReviewPrefetchAheadCountWeb: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 14, 'source control'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(14, 24) }),
    scmReviewPrefetchBehindCountWeb: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 8, 'source control'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(4, 8) }),
    scmReviewPrefetchAheadCountNative: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 8, 'source control'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(8, 14) }),
    scmReviewPrefetchBehindCountNative: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 4, 'source control'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(2, 4) }),
    scmReviewPrefetchConcurrency: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 3, 'source control'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(3, 5) }),
    scmReviewPrefetchDebounceMs: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 150, 'source control'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(50, 150) }),
    scmSessionAutoRefreshIntervalMs: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 300000, 'source control'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(60000, 300000) }),
    scmFilesAutoRefreshIntervalMs: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 60000, 'source control'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(15000, 60000) }),
    scmCommitMessageGeneratorEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'source control'), trackAccountBoolean),
    /** Null or `{ mode: 'auto' }`: the task runner owner picks on the executing machine. */
    /** Deploy planning uses the same background-task choice owner; null is Auto. */
    deploySuggestionRunnerV1: accountPreference(z.nullable(LlmTaskRunnerChoiceV1Schema), null, 'deploy suggestions', 64 * 1024),
    scmCommitMessageGeneratorRunnerV1: accountPreference(z.nullable(LlmTaskRunnerChoiceV1Schema), null, 'source control', 64 * 1024),
    scmCommitMessageGeneratorInstructions: accountPreference(accountBoundedString(16 * 1024), '', 'source control', 16 * 1024),
    'scm.diffSummary.enabled': withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'source control'), trackAccountBoolean),
    'scm.diffSummary.prefetch': withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'source control'), trackAccountBoolean),
    'scm.diffSummary.investigateSurroundingFiles': accountPreference(z.boolean(), false, 'source control'),
    /** The summary runner choice; null is Auto. */
    'scm.diffSummary.runnerV1': accountPreference(z.nullable(LlmTaskRunnerChoiceV1Schema), null, 'source control', 64 * 1024),
    // Reuse the Account language preference's scalar storage boundary; empty follows the UI locale.
    'scm.diffSummary.outputLanguage': accountPreference(accountBoundedString(256), '', 'source control'),
    filesDiffSyntaxHighlightingMode: withAccountSettingAnalytics(accountPreference(z.enum(['off', 'simple', 'advanced']), 'advanced', 'file presentation'), trackAccountEnum),
    filesDiffRendererMode: withAccountSettingAnalytics(accountPreference(z.enum(['happier', 'pierre']), 'pierre', 'file presentation'), trackAccountEnum),
    filesDiffPresentationStyle: withAccountSettingAnalytics(accountPreference(z.enum(['unified', 'split']), 'unified', 'file presentation'), trackAccountEnum),
    filesDiffFileListVirtualizationMinFiles: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 20, 'file presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(10, 30),
    }),
    filesDiffInlineVirtualizationLineThreshold: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 400, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(400, 800) }),
    filesDiffReviewCommentsInlineVirtualizationLineThreshold: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 120, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(120, 240) }),
    filesDiffInlineVirtualizationByteThreshold: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 120000, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(120000, 250000) }),
    filesChangedFilesRowDensity: withAccountSettingAnalytics(accountPreference(z.enum(['comfortable', 'compact']), 'comfortable', 'file presentation'), trackAccountEnum),
    /** The session Git pane: one scroll (changes → commit → timeline) or two views (Changes | History). */
    scmGitPaneLayout: withAccountSettingAnalytics(accountPreference(z.enum(['unified', 'tabs']), 'unified', 'file presentation'), trackAccountEnum),
    /** Changed files in the Git pane as a flat list or a folder tree. */
    scmChangedFilesLayout: withAccountSettingAnalytics(accountPreference(z.enum(['list', 'tree']), 'list', 'file presentation'), trackAccountEnum),
    /** Where a new pull request form opens: in the Git sidebar, or as a Details pane. */
    scmPullRequestPlacement: withAccountSettingAnalytics(accountPreference(z.enum(['sidebar', 'details']), 'sidebar', 'file presentation'), trackAccountEnum),
    /** Preferred destination for supported forge resource links; core owns external fallback. */
    scmResourceOpenLocation: withAccountSettingAnalytics(accountPreference(z.enum(['happier', 'github']), 'happier', 'source control'), trackAccountEnum),
    filesDiffFoldingEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'file presentation'), trackAccountBoolean),
    filesDiffFoldingContextThreshold: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 12, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(12, 24) }),
    filesDiffFoldingContextRadius: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 3, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(3, 6) }),
    filesDiffIntraLineWordDiffEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'file presentation'), trackAccountBoolean),
    filesDiffIntraLineWordDiffMaxPatchLines: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 2000, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(2000, 4000) }),
    filesDiffIntraLineWordDiffMaxPairs: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 500, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(500, 800) }),
    filesDiffIntraLineWordDiffMaxLineLength: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 800, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(800, 2000) }),
    filesDiffTokenizationMaxBytes: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 250000, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(250000, 500000) }),
    filesDiffTokenizationMaxLines: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 5000, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(5000, 10000) }),
    filesDiffTokenizationMaxLineLength: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 2000, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(2000, 4000) }),
    filesCodeViewJsonInferenceMaxBytes: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 40000, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(40000, 80000) }),
    filesRepositoryTreeWarmCacheEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'file presentation'), trackAccountBoolean),
    filesImagePreviewCacheMaxEntries: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 32, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(32, 64) }),
    filesImagePreviewCacheMaxTotalBytes: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 96 * 1024 * 1024, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(96 * 1024 * 1024, 128 * 1024 * 1024) }),
    filesImagePreviewMaxBytes: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 16 * 1024 * 1024, 'file presentation'), { trackCurrentState: true, trackChanges: true, valueKind: 'bucket', privacy: 'bucketed', identityScope: 'person', serializeCurrent: serializeNumericSettingBucket(16 * 1024 * 1024, 32 * 1024 * 1024) }),
    filesEditorAutoSave: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'file editing'), trackAccountBoolean),
    filesEditorFormatOnSave: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'file editing'), trackAccountBoolean),
    filesEditorInlayHints: withAccountSettingAnalytics(accountPreference(z.enum(['off', 'parameters', 'all']), 'off', 'file editing'), trackAccountEnum),
    filesEditorSemanticHighlighting: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'file editing'), trackAccountBoolean),
    filesEditorAiSuggestionsV1: accountPolicy(FilesEditorAiSuggestionsV1Schema, DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1, 'file editing'),
    markdownDefaultEditMode: withAccountSettingAnalytics(accountPreference(z.enum(['raw', 'rich']), 'rich', 'file editing'), trackAccountEnum),
    filesMarkdownRichEditorMaxBytes: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 256000, 'file editing'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(256000, 512000),
    }),
    filesMarkdownRichEditorHtmlRoundTripMaxBytes: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 50000, 'file editing'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(50000, 100000),
    }),
    filesEditorChangeDebounceMs: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 250, 'file editing'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(100, 250),
    }),
    filesEditorBridgeMaxChunkBytes: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 64000, 'file editing'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(64000, 96000),
    }),
    filesEditorWebMonacoEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'file editing'), trackAccountBoolean),
    filesEditorNativeCodeMirrorEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'file editing'), trackAccountBoolean),
} as const;
const ACCOUNT_TRANSCRIPT_AND_TOOL_CATALOG_DEFINITIONS = {
    agentHtmlNetworkPolicy: accountPolicy(z.catch(z.enum(['allowed', 'ask', 'off']), 'ask'), 'allowed', 'agent HTML network pre-approval'),
    toolViewDetailLevelDefault: withAccountSettingAnalytics(accountPreference(z.enum(['default', 'title', 'compact', 'summary', 'full']), 'default', 'tool presentation'), trackAccountEnum),
    toolViewDetailLevelDefaultLocalControl: withAccountSettingAnalytics(accountPreference(z.enum(['title', 'compact', 'summary', 'full']), 'title', 'tool presentation'), trackAccountEnum),
    toolViewShowDebugByDefault: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'tool presentation'), trackAccountBoolean),
    toolViewTapAction: withAccountSettingAnalytics(accountPreference(z.enum(['expand', 'open']), 'expand', 'tool presentation'), trackAccountEnum),
    toolViewExpandedDetailLevelDefault: withAccountSettingAnalytics(accountPreference(z.enum(['default', 'summary', 'full']), 'default', 'tool presentation'), trackAccountEnum),
    toolViewDetailLevelByToolName: withAccountSettingAnalytics(accountPreference(z._default(z.record(accountBoundedString(1024), z.enum(['title', 'compact', 'summary', 'full'])), {}), {}, 'tool presentation', 32 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildOverrideCountSummaryProperties,
    }),
    toolViewExpandedDetailLevelByToolName: withAccountSettingAnalytics(accountPreference(z._default(z.record(accountBoundedString(1024), z.enum(['summary', 'full'])), {}), {}, 'tool presentation', 32 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildOverrideCountSummaryProperties,
    }),
    transcriptGroupingMode: withAccountSettingAnalytics(accountPreference(z.enum(['linear', 'turns']), 'turns', 'transcript presentation'), trackAccountEnum),
    transcriptShowToolCalls: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptGroupToolCalls: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptTurnToolCallsGroupStrategy: withAccountSettingAnalytics(accountPreference(z.enum(['consecutive_tools', 'all_tools_in_turn']), 'consecutive_tools', 'transcript presentation'), trackAccountEnum),
    transcriptToolCallsCollapsedPreviewCount: withAccountSettingAnalytics(accountPreference((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value): unknown => typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.min(15, Math.trunc(value)))
        : value), accountNonNegativeInteger(15)), DEFAULT_TRANSCRIPT_TOOL_CALLS_COLLAPSED_PREVIEW_COUNT, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(3, 5),
    }),
    transcriptToolCallsGroupShowBackground: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'transcript presentation'), trackAccountBoolean),
    transcriptMessageTimestampDisplayMode: withAccountSettingAnalytics(accountPreference(z.enum(TRANSCRIPT_MESSAGE_TIMESTAMP_DISPLAY_MODE_VALUES), 'hover_web_hidden_mobile', 'transcript presentation'), trackAccountEnum),
    /** "Worked for 1m 12s" / "Stopped after 40s" at the end of each settled turn, from the turn's recorded start and end. */
    transcriptShowTurnDuration: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptLinkAgentNames: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptMessageSelectionEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptMessageCopyActionEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptMessageForkActionEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptMessageRollbackActionEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptMessagePinActionEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptMessageSavePromptActionEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptMessageMakeRepeatableActionEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptMessagePluginActionsEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptMessageSendToSessionEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'transcript presentation'), trackAccountBoolean),
    transcriptMessageSendToSessionTemplate: withAccountSettingAnalytics(accountPreference(accountBoundedString(2000), '{{MESSAGES}}', 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: (value: unknown) => bucketNumericSetting(typeof value === 'string' ? value.length : 0, 128, 512),
    }),
    transcriptBulkCopyFormat: withAccountSettingAnalytics(accountPreference(z.enum(['markdown_labeled', 'plain']), 'markdown_labeled', 'transcript presentation'), trackAccountEnum),
    transcriptPendingQueueMaxHeightPx: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 80, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(80, 96),
    }),
    transcriptPendingQueueExpandedMaxHeightPx: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 520, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(400, 600),
    }),
    transcriptPendingQueueReorderRowHeightPx: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 72, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(60, 80),
    }),
    transcriptPendingMessageCollapseThresholdChars: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 160, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(160, 320),
    }),
    transcriptPendingMessageCollapsedLines: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 2, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(2, 4),
    }),
    transcriptStreamingCoalesceEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptStreamingCoalesceWindowMs: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 16, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(16, 33),
    }),
    transcriptStreamingCoalesceMaxBatchSize: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 200, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(200, 350),
    }),
    transcriptThinkingPulseStaleMs: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 120000, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(120000, 240000),
    }),
    toolViewTimelineChromeMode: withAccountSettingAnalytics(accountPreference(z.enum(['cards', 'activity_feed']), 'activity_feed', 'tool presentation'), trackAccountEnum),
    toolViewTimelineFeedDefaultExpanded: withAccountSettingAnalytics(accountPreference(z.boolean(), false, 'tool presentation'), trackAccountBoolean),
    transcriptMotionPreset: withAccountSettingAnalytics(accountPreference(z.enum(['off', 'subtle', 'full']), 'subtle', 'transcript presentation'), trackAccountEnum),
    transcriptMotionFreshnessMs: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 60000, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(15000, 60000),
    }),
    transcriptAnimateNewItemsEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptAnimateToolExpandCollapseEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptAnimateToolExpandCollapseFreshOnly: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptAnimateThinkingEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptStreamingSmoothingEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptStreamingSettleDelayMs: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 250, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(150, 250),
    }),
    transcriptStreamingPartialOutputEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptStreamingMarkdownRenderingEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptScrollPinEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptScrollPinOffsetThresholdPx: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 72, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(72, 120),
    }),
    transcriptScrollAutoFollowWhenPinned: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptScrollJumpToBottomEnabled: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    transcriptScrollJumpToBottomMinNewCount: withAccountSettingAnalytics(accountPreference(accountNonNegativeInteger(), 1, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: serializeNumericSettingBucket(1, 3),
    }),
    transcriptScrollJumpToBottomRevealViewportRatio: withAccountSettingAnalytics(accountPreference(z.number().check(z.minimum(0), z.maximum(1)), 0.4, 'transcript presentation'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: (value: number) => bucketNumericSetting(Math.round(value * 100), 50, 100),
    }),
    transcriptScrollJumpToBottomAnimateScroll: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'transcript presentation'), trackAccountBoolean),
    permissionPromptSurface: withAccountSettingAnalytics(accountPreference(z.enum(['composer', 'transcript', 'both']), 'composer', 'permission mediation'), trackAccountEnum),
} as const;
const ACCOUNT_RUNTIME_AND_WORKFLOW_CATALOG_DEFINITIONS = {
    // PROGRAM D21: deliberate visible Activity cadence; zero disables automatic refresh.
    sessionReminderAutoClearOnOpen: accountPreference(z.boolean(), true, 'session reminders'),
    sessionReminderPresetsV1: accountPreference(SessionReminderPresetsV1Schema, [], 'session reminders', 16 * 1024),
    externalSessionsSettingsV1: withAccountSettingAnalytics(accountPreference(ExternalSessionsSettingsV1Schema, ExternalSessionsSettingsV1Schema.parse({}), 'external session policy', 64 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'count_only',
        identityScope: 'person',
        currentPropertyValueKinds: {
            keepPassivelyFollowingAfterRestart: 'boolean',
            autoLinkSourcePolicyEnabledCount: 'count',
        },
        serializeCurrentProperties: (value: z.infer<typeof ExternalSessionsSettingsV1Schema>) => ({
            keepPassivelyFollowingAfterRestart: value.keepPassivelyFollowingAfterRestart,
            autoLinkSourcePolicyEnabledCount: value.autoLinkSourcePolicies.length,
        }),
    }),
    pluginUpdateReviewModeV1: accountPreference(PluginUpdateReviewModeV1Schema, DEFAULT_PLUGIN_UPDATE_REVIEW_MODE_V1, 'plugin update review'),
    preferredLanguage: withAccountSettingAnalytics(accountPreference(z.nullable(accountBoundedString(256)), null, 'language preference'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrent: (value: string | null): string => value ?? 'auto',
    }),
    sessionHandoffDefaultsV1: withAccountSettingAnalytics(accountPreference(SessionHandoffDefaultsV1Schema, DEFAULT_SESSION_HANDOFF_DEFAULTS_V1, 'session handoff defaults', 32 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: (value: z.infer<typeof SessionHandoffDefaultsV1Schema>) => ({
            workspaceSyncMode: value.workspaceSyncMode,
            includeIgnoredMode: value.includeIgnoredMode,
            directTargetMode: value.directTargetMode,
        }),
    }),
    // Null or Auto: the background-task runner owner picks on the executing machine.
    sessionReplaySummaryRunnerV1: withAccountSettingAnalytics(accountPreference(z.nullable(LlmTaskRunnerChoiceV1Schema), null, 'session replay', 64 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'presence',
        privacy: 'presence_only',
        identityScope: 'person',
        serializeCurrent: (value) => value !== null,
    }),
    sessionTmuxByMachineId: withAccountSettingAnalytics(accountPreference(z._default(z.record(accountBoundedString(1024), SessionTmuxMachineOverrideSchema), {}), {}, 'session terminal defaults', 64 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildSessionTmuxOverrideSummaryProperties,
    }),
    sessionTerminalHostByMachineId: accountPreference(z._default(z.record(accountBoundedString(1024), z.enum(['zellij', 'herdr'])), {}), {}, 'session terminal defaults', 64 * 1024),
    sessionTmuxSessionName: accountPreference(accountBoundedString(256), 'happy', 'session terminal defaults'),
    sessionTmuxIsolated: withAccountSettingAnalytics(accountPreference(z.boolean(), true, 'session terminal defaults'), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'boolean',
        privacy: 'safe',
        identityScope: 'person',
    }),
    sessionTmuxTmpDir: accountPreference(z.nullable(accountBoundedString(16 * 1024)), null, 'session terminal defaults', 16 * 1024),
    installablesPolicyByMachineId: withAccountSettingAnalytics(accountPolicy(AccountInstallablePoliciesByMachineIdSchema, {}, 'installable policy', 64 * 1024), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildInstallablesPolicySummaryProperties,
    }),
    computerUseByMachineId: accountCatalogDefinition(ComputerUseByMachineIdV1Schema, {}, {
        semanticDomain: 'machine computer-use providers', classification: 'preference',
        maximumSerializedValueBytes: ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES,
    }),
} as const;
export const accountDeploymentSettingDefinitions = {
    deploymentDefaultsV1: accountCatalogDefinition(DeploymentCreationDefaultsV1Schema, {}, {
        semanticDomain: 'deployment creation defaults', classification: 'preference',
        maximumSerializedValueBytes: ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES,
    }),
} as const;

const ACCOUNT_SETTING_CANDIDATES = {
    ...accountDeploymentSettingDefinitions,
    ...ACCOUNT_CORE_CATALOG_DEFINITIONS,
    ...ACCOUNT_DISPLAY_CATALOG_DEFINITIONS,
    ...ACCOUNT_LEGACY_ROOT_CATALOG_DEFINITIONS,
    ...ACCOUNT_CONNECTED_SERVICES_CATALOG_DEFINITIONS,
    ...ACCOUNT_SIMPLE_COLLECTION_CATALOG_DEFINITIONS,
    ...ACCOUNT_SESSION_AUTHORING_CATALOG_DEFINITIONS,
    ...ACCOUNT_SCM_AND_FILES_CATALOG_DEFINITIONS,
    ...ACCOUNT_TRANSCRIPT_AND_TOOL_CATALOG_DEFINITIONS,
    ...ACCOUNT_RUNTIME_AND_WORKFLOW_CATALOG_DEFINITIONS,
    schemaVersion: accountCatalogDefinition(z._default(z.catch(z.number().check(z.int(), z.minimum(0)), ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION), ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION), ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION, { semanticDomain: 'settings compatibility', classification: 'policy', maximumSerializedValueBytes: 32 }),
    clientEncryptionRequirementV1: accountCatalogDefinition(ClientEncryptionRequirementSchema, 'follow_account', { semanticDomain: 'client encryption policy', classification: 'policy', maximumSerializedValueBytes: 32 }),
    featureToggles: accountCatalogDefinition(FeatureTogglesSchema, {}, { semanticDomain: 'feature choices', classification: 'preference', maximumSerializedValueBytes: 16 * 1024 }),
    backendEnabledByTargetKey: withAccountSettingAnalytics(accountCatalogDefinition(z._default(BackendEnabledByTargetKeySchema, {}), {}, { semanticDomain: 'backend availability', classification: 'preference', maximumSerializedValueBytes: 16 * 1024 }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'boolean',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: emptyRuntimeSettingProperties,
    }),
    backendCliSourcePreferenceByTargetKey: withAccountSettingAnalytics(accountCatalogDefinition(BackendCliSourcePreferenceByTargetKeySchema, {}, { semanticDomain: 'backend installation policy', classification: 'preference', maximumSerializedValueBytes: 16 * 1024 }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: emptyRuntimeSettingProperties,
    }),
    scmIncludeCoAuthoredBy: withAccountSettingAnalytics(accountCatalogDefinition(z.catch(z.optional(z.boolean()), undefined), undefined, { semanticDomain: 'source control', classification: 'preference', maximumSerializedValueBytes: 8 }), trackAccountBoolean),
    actionsSettingsV1: withAccountSettingAnalytics(accountCatalogDefinition(z.transform((value) => migrateLegacyDefaultActionsSettingsV1(tryNormalizeActionsSettingsV1(value) ?? DEFAULT_ACTIONS_SETTINGS_V1)), DEFAULT_ACTIONS_SETTINGS_V1, { semanticDomain: 'action policy', classification: 'policy', structuralBoundsOwner: 'domainOwned', maximumSerializedValueBytes: 64 * 1024 }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildActionsSettingsSummaryProperties,
    }),
    notificationsSettingsV1: withAccountSettingAnalytics(accountCatalogDefinition(z._default(NotificationsSettingsV1Schema, DEFAULT_NOTIFICATIONS_SETTINGS_V1), DEFAULT_NOTIFICATIONS_SETTINGS_V1, {
        semanticDomain: 'legacy notification preferences',
        classification: 'legacy',
        maximumSerializedValueBytes: 4 * 1024,
        compatibility: LEGACY_COMPATIBILITY,
    }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: (value: z.infer<typeof NotificationsSettingsV1Schema>) => ({
            pushEnabled: value.pushEnabled,
            ready: value.ready,
            readyIncludeMessageText: value.readyIncludeMessageText,
            permissionRequest: value.permissionRequest,
            userActionRequest: value.userActionRequest,
            foregroundBehavior: value.foregroundBehavior,
        }),
    }),
    codingPromptBehaviorV1: withAccountSettingAnalytics(accountCatalogDefinition(z._default(CodingPromptBehaviorV1Schema, DEFAULT_CODING_PROMPT_BEHAVIOR_V1), DEFAULT_CODING_PROMPT_BEHAVIOR_V1, { semanticDomain: 'coding prompts', classification: 'preference', maximumSerializedValueBytes: 4 * 1024 }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: (value: unknown) => {
            const parsed = CodingPromptBehaviorV1Schema.parse(value);
            return {
                sessionTitleUpdates: parsed.sessionTitleUpdates,
                sessionCompactionNudge: parsed.sessionCompactionNudge,
                responseOptions: parsed.responseOptions,
            };
        },
    }),
    sessionRemoteAlertsEnabled: accountCatalogDefinition(z.catch(z._default(z.boolean(), false), false), false, { semanticDomain: 'remote alert policy disclosure', classification: 'policy', maximumSerializedValueBytes: 5 }),
    machineOfflineAlertsV1: accountPolicy(MachineOfflineAlertsV1Schema, DEFAULT_MACHINE_OFFLINE_ALERTS_V1, 'machine offline alert enrollment', ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES),
    attentionDeliveryPolicyV1: withAccountSettingAnalytics(accountCatalogDefinition(z._default(z.catch(AttentionDeliveryPolicyV1Schema, DEFAULT_ATTENTION_DELIVERY_POLICY_V1), DEFAULT_ATTENTION_DELIVERY_POLICY_V1), DEFAULT_ATTENTION_DELIVERY_POLICY_V1, { semanticDomain: 'attention delivery', classification: 'policy', maximumSerializedValueBytes: 32 * 1024 }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: (value: z.infer<typeof AttentionDeliveryPolicyV1Schema>) => ({
            quietHoursEnabled: value.quietHours.enabled,
            foregroundBehavior: value.foregroundBehavior,
            expoPushEnabled: value.channels.expo_push.enabled,
            localNotificationEnabled: value.channels.local_notification.enabled,
            liveActivityEnabled: value.channels.live_activity.enabled,
            liveActivityRemoteMode: value.liveActivityRemoteUpdates.preferredMode,
        }),
    }),
    peerMediationPreferencesV1: withAccountSettingAnalytics(accountCatalogDefinition(z._default(z.catch(PeerMediationPreferencesV1Schema, DEFAULT_PEER_MEDIATION_PREFERENCES_V1), DEFAULT_PEER_MEDIATION_PREFERENCES_V1), DEFAULT_PEER_MEDIATION_PREFERENCES_V1, { semanticDomain: 'peer mediation', classification: 'policy', maximumSerializedValueBytes: 32 * 1024 }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildPeerMediationPreferencesSummaryProperties,
    }),
    usageLimitRecoverySettingsV1: withAccountSettingAnalytics(accountCatalogDefinition(z._default(UsageLimitRecoverySettingsV1Schema, DEFAULT_USAGE_LIMIT_RECOVERY_SETTINGS_V1), DEFAULT_USAGE_LIMIT_RECOVERY_SETTINGS_V1, { semanticDomain: 'usage recovery', classification: 'policy', maximumSerializedValueBytes: 8 * 1024 }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrent: (value: {
            mode: string;
        }) => value.mode,
    }),
    usagePacingTargetsV1: accountPreference(UsagePacingTargetsV1Schema, [], 'usage pacing advice', ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES),
    usageNightHoursV1: accountPreference(z.nullable(UsageNightHoursV1Schema), null, 'recorded activity night hours'),
    usageQuotaNotificationsV1: accountPreference(UsageQuotaNotificationsV1Schema, DEFAULT_USAGE_QUOTA_NOTIFICATIONS_V1, 'usage notifications'),
    /** The agent/model picker's routing hint section; display only, never an account switch. */
    usageRoutingHintsEnabled: accountPreference(z.catch(z._default(z.boolean(), true), true), true, 'usage routing hints', 8),
    usageCoachPreferencesV1: accountCatalogDefinition(UsageCoachPreferencesV1Schema, DEFAULT_USAGE_COACH_PREFERENCES_V1, {
        semanticDomain: 'usage coach preferences', classification: 'preference',
        mutationSchema: UsageCoachPreferenceMutationV1Schema,
        maximumSerializedValueBytes: ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES,
    }),
    usageModelPriceOverridesV1: accountPreference(UsageModelPriceOverridesV1Schema, {}, 'usage model price overrides', ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES),
    sessionPendingQueueDrainMode: accountCatalogDefinition(z._default(SessionPendingQueueDrainModeSchema, DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE), DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE, { semanticDomain: 'pending queue delivery', classification: 'policy', maximumSerializedValueBytes: 64 }),
    sessionInactiveResumePolicy: withAccountSettingAnalytics(accountCatalogDefinition(z._default(SessionInactiveResumePolicySchema, DEFAULT_SESSION_INACTIVE_RESUME_POLICY), DEFAULT_SESSION_INACTIVE_RESUME_POLICY, { semanticDomain: 'pending queue activation', classification: 'preference', maximumSerializedValueBytes: 32 }), trackAccountEnum),
    sessionPendingQueueDeliveryTiming: withAccountSettingAnalytics(accountCatalogDefinition(z._default(SessionPendingQueueDeliveryTimingSchema, DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING), DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING, { semanticDomain: 'pending queue delivery', classification: 'policy', maximumSerializedValueBytes: 64 }), trackAccountEnum),
    sessionAgentSpawnPolicyV1: withAccountSettingAnalytics(accountCatalogDefinition(z._default(SessionAgentSpawnPolicyV1Schema, DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1), DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { semanticDomain: 'agent spawn policy', classification: 'policy', maximumSerializedValueBytes: 8 * 1024, recoverMalformed: false, mutationSchema: SessionAgentSpawnPolicyV1StrictSchema }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildSessionAgentSpawnPolicySummaryProperties,
    }),
    sessionAgentStartAllowListsV1: accountCatalogDefinition(z._default(SessionAgentStartAllowListsV1Schema, DEFAULT_SESSION_AGENT_START_ALLOW_LISTS_V1), DEFAULT_SESSION_AGENT_START_ALLOW_LISTS_V1, { semanticDomain: 'agent start allow-lists', classification: 'policy', maximumSerializedValueBytes: 8 * 1024, recoverMalformed: false, mutationSchema: SessionAgentStartAllowListsV1StrictSchema }),
    approvalReviewerEnabled: accountCatalogDefinition(z.catch(z._default(z.boolean(), false), false), false, { semanticDomain: 'approval reviewer', classification: 'policy', maximumSerializedValueBytes: 64 }),
    coordinationAutonomousCheckIn: accountPreference(
        z.strictObject({ afterTurns: z.nullable(z.number().check(z.int(), z.positive())) }),
        { afterTurns: 5 },
        'autonomous exchange check-in',
    ),
    coordinationCoordinatorRoleId: accountPreference(z.string().check(z.minLength(1)), 'orchestrator', 'new coordinator role'),
    coordinationCoordinatorKeep: accountPreference(z.enum(COORDINATOR_KEEP_DEFAULT_VALUES), 'suggest', 'new coordinator placement'),
    coordinationCoordinatorSuggestProjectRule: accountPreference(z.boolean(), true, 'new coordinator project rule suggestion'),
    coordinationCoordinatorSuggestHomeRule: accountPreference(z.boolean(), true, 'new coordinator Home rule suggestion'),
    coordinationCoordinatorAnswersWorkerQuestions: accountPreference(z.boolean(), true, 'new coordinator worker questions'),
    workDepthLimit: accountCatalogDefinition(z.catch(z._default(z.number().check(z.int(), z.nonnegative()), 4), 4), 4, { semanticDomain: 'agent delegation depth', classification: 'policy', maximumSerializedValueBytes: 64 }),
    connectedServicesProviderStateSharingSettingsV1: withAccountSettingAnalytics(accountCatalogDefinition(z._default(ConnectedServicesProviderStateSharingSettingsV1Schema, DEFAULT_CONNECTED_SERVICES_PROVIDER_STATE_SHARING_SETTINGS_V1), DEFAULT_CONNECTED_SERVICES_PROVIDER_STATE_SHARING_SETTINGS_V1, { semanticDomain: 'connected service state sharing', classification: 'policy', maximumSerializedValueBytes: 16 * 1024 }), {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: (value: unknown) => {
            const parsed = ConnectedServicesProviderStateSharingSettingsV1Schema.parse(value);
            return {
                overrideCount: objectKeyCount(parsed.byAgentId),
                acknowledgedRiskCount: objectKeyCount(parsed.acknowledgedRisksByAgentId),
                defaultsConfigLinked: parsed.defaults.configMode === 'linked' ? 1 : 0,
                defaultsConfigCopied: parsed.defaults.configMode === 'copied' ? 1 : 0,
                defaultsConfigIsolated: parsed.defaults.configMode === 'isolated' ? 1 : 0,
                defaultsStateShared: parsed.defaults.stateMode === 'shared' ? 1 : 0,
            };
        },
    }),
    providerDefaultModelSelectionsByAgentTargetKeyV1: withAccountSettingAnalytics(accountCatalogDefinition(z._default(z.catch(ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema, {}), {}), {}, {
        semanticDomain: 'provider default model selections', classification: 'preference',
        maximumSerializedValueBytes: ACCOUNT_SETTINGS_MAX_PROVIDER_SUBTREE_BYTES, structuralBoundsOwner: 'domainOwned',
    }), {
        valueKind: 'presence',
        privacy: 'forbidden',
        identityScope: 'person',
    }),
    machineRetentionDefaultsV1: accountCatalogDefinition(MachineRetentionDefaultsV1Schema, DEFAULT_MACHINE_RETENTION_DEFAULTS_V1, { semanticDomain: 'managed machine category defaults', classification: 'preference', maximumSerializedValueBytes: ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES }),
    managedMachineDeletionReminderLeadTimeMs: accountPreference(z.number().check(z.int(), z.nonnegative()), 2 * 24 * 60 * 60 * 1_000, 'managed machine deletion reminder lead time'),
    managedMachineCreationEnabled: accountCatalogDefinition(z._default(z.boolean(), true), true, { semanticDomain: 'managed machine acquisition', classification: 'policy', maximumSerializedValueBytes: 5 }),
    workspaceFileViewerPreferencesV1: withAccountSettingAnalytics(accountCatalogDefinition(z._default(z.catch(WorkspaceFileViewerPreferencesV1Schema, DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1), DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1), DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1, { semanticDomain: 'workspace file viewing', classification: 'preference', maximumSerializedValueBytes: WORKSPACE_FILE_VIEWER_PREFERENCES_V1_MAX_ENCODED_BYTES }), {
        valueKind: 'presence',
        privacy: 'forbidden',
        identityScope: 'person',
    }),
} as const;

export const ACCOUNT_SETTING_ARTIFACTS: SettingArtifacts<typeof ACCOUNT_SETTING_CANDIDATES> = lazyDefinition(() => buildAccountSettingArtifacts(ACCOUNT_SETTING_CANDIDATES));
export const ACCOUNT_SETTING_DEFINITIONS = lazyDefinition(() => ACCOUNT_SETTING_ARTIFACTS.definitions);
export const ACCOUNT_SETTING_KEYS = Object.freeze(Object.keys(ACCOUNT_SETTING_CANDIDATES));
export type AccountSettingKey = keyof typeof ACCOUNT_SETTING_DEFINITIONS;
export type AccountSettingsDefaults = typeof ACCOUNT_SETTING_ARTIFACTS.defaults;
// This is the canonical, forward-compatible schema for the server-synced account settings blob.
// It MUST preserve unknown keys so newer clients can add fields without breaking older ones.
export const AccountSettingsSchema = lazyZodSchema(() => classicZ.pipe(z.transform((raw): unknown => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const source = migrateAccountSettingsFeaturePreferences(raw as Record<string, unknown>);
    migrateLegacyScmCommitMessageRunner(source);
    const effective = backfillClaudeUnifiedTerminalResponseLocations(
        backfillLegacyTargetKeyedAccountSettings(projectSessionListPreferenceIngress(source)),
    );
    // Effective readers no longer own these values. Raw persisted baselines must
    // retain them until the destination-first reserved-row importer commits.
    for (const key of Object.keys(effective)) {
        if (isAccountSettingsReadOnlySourceKeyV1(key)) delete effective[key];
    }
    delete effective.mcpServersSettingsV1;
    delete effective.acpCatalogSettingsV1;
    delete effective.providerSettingsV1;
    delete effective.connectedAccountServiceConfigurationsV1;
    delete effective.petsDesktopOverlayDefaultVisibilityMode;
    return effective;
}), z.looseObject(ACCOUNT_SETTING_ARTIFACTS.shape)));

export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

export function accountSettingsParse(raw: unknown): AccountSettings {
  return AccountSettingsSchema.parse(raw);
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

  const canonicalKey = readBackendTargetKeyV2(target);
  if (canonicalKey === null) return undefined;
  if (Object.hasOwn(byKey, canonicalKey)) return byKey[canonicalKey];

  // An unparsed document may still hold the legacy spelling the catalog would
  // rewrite on its next read.
  for (const [key, value] of Object.entries(byKey)) {
    if (readBackendTargetKeyV2(key) === canonicalKey) return value;
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
  return readAccountAttentionDeliveryPolicy(settingsLike).channels.expo_push.enabled !== false;
}

export { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID };
export type { ConnectedServicesDefaultAuthByAgentIdV1, ConnectedServicesProviderStateSharingSettingsV1, NotificationChannelV1, NotificationChannelsV1, };
export { AttentionDeliveryPolicyV1Schema, DEFAULT_ATTENTION_DELIVERY_POLICY_V1, deriveAttentionDeliveryPolicyFromLegacySettings, resolveAttentionDeliveryPolicyDecision, };
export type {
  AttentionDeliveryPolicyV1,
  AttentionDeliveryDecision,
  PeerMediationPreferencesV1,
  ResolveAttentionDeliveryPolicyDecisionParams,
};
