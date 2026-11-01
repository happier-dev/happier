import { z } from 'zod';

import { ActionsSettingsV1Schema, type ActionsSettingsV1 } from '../../actions/actionSettings.js';
import { AcpCatalogSettingsV1Schema } from '../../acpCatalog/settingsV1.js';
import {
  CodingPromptBehaviorV1Schema,
  DEFAULT_CODING_PROMPT_BEHAVIOR_V1,
} from '../../prompts/codingPromptBehaviorV1.js';
import {
  ConnectedServicesDefaultAuthByAgentIdV1Schema,
  ConnectedServicesAdditionalDefaultAuthByAgentIdV1Schema,
  ConnectedServicesProviderStateSharingSettingsV1Schema,
  DEFAULT_CONNECTED_SERVICES_DEFAULT_AUTH_BY_AGENT_ID_V1,
  DEFAULT_CONNECTED_SERVICES_PROVIDER_STATE_SHARING_SETTINGS_V1,
  type ConnectedServicesDefaultAuthByAgentIdV1,
  type ConnectedServicesProviderStateSharingSettingsV1,
} from './connectedServicesSettings.js';
import {
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  NotificationChannelsV1Schema,
  deriveExpoPushNotificationChannelFromLegacySettings,
  type NotificationChannelV1,
  type NotificationChannelsV1,
} from './notificationChannels.js';
import { SESSION_PERMISSION_MODES } from '../../sessionMetadata/sessionPermissionModes.js';
import { ClientEncryptionRequirementSchema } from '../../encryption/clientEncryptionRequirement.js';
import { lazySchema } from '../../lazySchema.js';

function rekeyLegacyBuiltInAgentMap<T>(raw: unknown): Record<string, T> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(([key]) => typeof key === 'string' && key.trim().length > 0)
    .map(([key, value]) => [`agent:${key.trim()}`, value as T]);
  return Object.fromEntries(entries);
}

export const ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION = 2;

export const ForegroundBehaviorSchema = lazySchema(() => z.enum(['full', 'silent', 'off']));
export type ForegroundBehavior = z.infer<typeof ForegroundBehaviorSchema>;

function normalizeNotificationsSettingsV1Input(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (
    !Object.prototype.hasOwnProperty.call(record, 'connectedServiceQuotaRecovered')
    && record.connectedServiceQuotaBlocked === false
  ) {
    return { ...record, connectedServiceQuotaRecovered: false };
  }
  return raw;
}

export const NotificationsSettingsV1Schema = lazySchema(() => z.preprocess(
  normalizeNotificationsSettingsV1Input,
  z
  .object({
    v: z.literal(1).default(1),
    pushEnabled: z.boolean().default(true),
    ready: z.boolean().default(true),
    readyIncludeMessageText: z.boolean().default(true),
    requestIncludeMessageText: z.boolean().default(true),
    permissionRequest: z.boolean().default(true),
    userActionRequest: z.boolean().default(true),
    connectedServiceAccountSwitch: z.boolean().default(true),
    connectedServiceQuotaBlocked: z.boolean().default(true),
    connectedServiceQuotaRecovered: z.boolean().default(true),
    foregroundBehavior: ForegroundBehaviorSchema.default('full'),
    // Missing on released clients: keep phone push delivery enabled.
    mutePhoneWhenComputerFocused: z.boolean().optional(),
  })
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
  }),
));

export type NotificationsSettingsV1 = z.infer<typeof NotificationsSettingsV1Schema>;

export const DEFAULT_NOTIFICATIONS_SETTINGS_V1: NotificationsSettingsV1 = NotificationsSettingsV1Schema.parse({});

const SessionAgentSpawnPermissionCeilingV1Schema = lazySchema(() => z
  .enum(SESSION_PERMISSION_MODES)
  .nullable()
  .default(null)
  .catch(null));

export const SessionAgentSpawnPolicyV1Schema = lazySchema(() => z
  .object({
    v: z.literal(1).default(1),
    allowCustomDirectory: z.boolean().default(true),
    allowCrossMachine: z.boolean().default(true),
    allowBackendTargetOverride: z.boolean().default(true),
    allowModelOverride: z.boolean().default(true),
    allowPermissionModeOverride: z.boolean().default(true),
    allowAgentModeOverride: z.boolean().default(true),
    allowConfigOptionOverrides: z.boolean().default(true),
    allowProfileOverride: z.boolean().default(true),
    allowEnvironmentVariables: z.boolean().default(true),
    allowConnectedServicesOverride: z.boolean().default(true),
    allowMcpSelectionOverride: z.boolean().default(true),
    allowTranscriptStorageOverride: z.boolean().default(true),
    permissionCeiling: SessionAgentSpawnPermissionCeilingV1Schema,
  })
  .strict()
  .catch({
    v: 1,
    allowCustomDirectory: true,
    allowCrossMachine: true,
    allowBackendTargetOverride: true,
    allowModelOverride: true,
    allowPermissionModeOverride: true,
    allowAgentModeOverride: true,
    allowConfigOptionOverrides: true,
    allowProfileOverride: true,
    allowEnvironmentVariables: true,
    allowConnectedServicesOverride: true,
    allowMcpSelectionOverride: true,
    allowTranscriptStorageOverride: true,
    permissionCeiling: null,
  }));

export type SessionAgentSpawnPolicyV1 = z.infer<typeof SessionAgentSpawnPolicyV1Schema>;

export const DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1: SessionAgentSpawnPolicyV1 =
  SessionAgentSpawnPolicyV1Schema.parse({});

export const DEFAULT_ACTIONS_SETTINGS_V1: ActionsSettingsV1 = ActionsSettingsV1Schema.parse({
  v: 1,
  actions: {
    // Product-courtesy defaults: in-session agents may coordinate and inspect by default,
    // while destructive/accounting/user-approval controls remain explicit opt-ins.
    'session.stop': { disabledSurfaces: ['session_agent'] },
    'session.archive': { disabledSurfaces: ['session_agent'] },
    'session.unarchive': { disabledSurfaces: ['session_agent'] },
    'session.permission.respond': { disabledSurfaces: ['session_agent'] },
    'session.user_action.answer': { disabledSurfaces: ['session_agent'] },
    'session.usageLimit.consumeResetCredit': { disabledSurfaces: ['session_agent'] },
    'approval.request.decide': { disabledSurfaces: ['session_agent'] },
    'session.target.primary.set': { disabledSurfaces: ['session_agent'] },
    'session.target.tracked.set': { disabledSurfaces: ['session_agent'] },
    'session.terminalComposer.clear': { disabledSurfaces: ['session_agent'] },
    'session.pendingInput.interruptAndRun': { disabledSurfaces: ['session_agent'] },
  },
});

const CURRENT_DEFAULT_SESSION_AGENT_DISABLED_ACTION_IDS_V1 = Object.freeze([
  'session.stop',
  'session.archive',
  'session.unarchive',
  'session.permission.respond',
  'session.user_action.answer',
  'session.usageLimit.consumeResetCredit',
  'approval.request.decide',
  'session.target.primary.set',
  'session.target.tracked.set',
  'session.terminalComposer.clear',
  'session.pendingInput.interruptAndRun',
] as const satisfies readonly string[]);

const CURRENT_DEFAULT_SESSION_AGENT_DISABLED_ACTION_ID_SET_V1 = new Set<string>(
  CURRENT_DEFAULT_SESSION_AGENT_DISABLED_ACTION_IDS_V1,
);

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
  const actions = settings.actions ?? ({} as any);
  const keys = Object.keys(actions);
  if (keys.length !== LEGACY_DEFAULT_SESSION_AGENT_DISABLED_ACTION_IDS_V1.length) return false;

  for (const key of keys) {
    if (!known.has(key)) return false;
    const override = (actions as any)[key] as any;
    if (!override || typeof override !== 'object' || Array.isArray(override)) return false;
    if (override.enabled === false) return false;
    const disabledSurfaces = Array.isArray(override.disabledSurfaces) ? override.disabledSurfaces : [];
    if (disabledSurfaces.length !== 1 || disabledSurfaces[0] !== 'session_agent') return false;
    const enabledPlacements = Array.isArray(override.enabledPlacements) ? override.enabledPlacements : [];
    if (enabledPlacements.length > 0) return false;
    const disabledPlacements = Array.isArray(override.disabledPlacements) ? override.disabledPlacements : [];
    if (disabledPlacements.length > 0) return false;
  }
  return true;
}

function hasOnlyEmptyActionSettingsFieldsV1(override: Readonly<Record<string, unknown>>): boolean {
  const enabledPlacements = Array.isArray(override.enabledPlacements) ? override.enabledPlacements : [];
  const disabledSurfaces = Array.isArray(override.disabledSurfaces) ? override.disabledSurfaces : [];
  const disabledPlacements = Array.isArray(override.disabledPlacements) ? override.disabledPlacements : [];
  const approvalRequiredSurfaces = Array.isArray(override.approvalRequiredSurfaces) ? override.approvalRequiredSurfaces : [];
  const toolExposureModes = override.toolExposureModes && typeof override.toolExposureModes === 'object' && !Array.isArray(override.toolExposureModes)
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
  const actions = { ...(settings.actions as any) } as ActionsSettingsV1['actions'];
  let changed = false;

  const shouldMigrateAllLegacyDefaults = isLegacyDefaultSessionAgentActionLockdownV1(settings);
  for (const id of Object.keys(actions)) {
    if (!shouldMigrateAllLegacyDefaults && !LEGACY_DEFAULT_SESSION_AGENT_DISABLED_ACTION_ID_SET_V1.has(id)) continue;
    if (CURRENT_DEFAULT_SESSION_AGENT_DISABLED_ACTION_ID_SET_V1.has(id)) continue;
    const existing = (actions as any)[id];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      delete (actions as any)[id];
      changed = true;
      continue;
    }

    const disabledSurfaces = Array.isArray(existing.disabledSurfaces)
      ? existing.disabledSurfaces.filter((surface: unknown) => surface !== 'session_agent')
      : [];
    const next = {
      ...existing,
      disabledSurfaces,
    };
    if (disabledSurfaces.length === existing.disabledSurfaces?.length) continue;
    changed = true;
    if (hasOnlyEmptyActionSettingsFieldsV1(next as Record<string, unknown>)) {
      delete (actions as any)[id];
    } else {
      (actions as any)[id] = next;
    }
  }
  return changed ? { ...settings, actions } : settings;
}

const BackendEnabledByTargetKeySchema = lazySchema(() => z.record(z.string(), z.boolean()).catch({}));
const BackendCliSourcePreferenceSchema = lazySchema(() => z.enum(['system-first', 'managed-first']));
const BackendCliSourcePreferenceByTargetKeySchema = lazySchema(() => z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([, value]) => value === 'system-first' || value === 'managed-first',
    ),
  );
}, z.record(z.string(), BackendCliSourcePreferenceSchema)).default({}));

export const UsageLimitRecoverySettingsV1Schema = lazySchema(() => z
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
  }));

export type UsageLimitRecoverySettingsV1 = z.infer<typeof UsageLimitRecoverySettingsV1Schema>;

export const DEFAULT_USAGE_LIMIT_RECOVERY_SETTINGS_V1: UsageLimitRecoverySettingsV1 =
  UsageLimitRecoverySettingsV1Schema.parse({});

export const SESSION_PENDING_QUEUE_DRAIN_MODES = ['one_at_a_time', 'drain_all'] as const;
export const DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE = 'one_at_a_time' as const;
export const SessionPendingQueueDrainModeSchema = lazySchema(() => z
  .enum(SESSION_PENDING_QUEUE_DRAIN_MODES)
  .catch(DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE));
export type SessionPendingQueueDrainMode = z.infer<typeof SessionPendingQueueDrainModeSchema>;

export const SESSION_PENDING_QUEUE_DELIVERY_TIMINGS = ['after_foreground_ready', 'after_runtime_idle'] as const;
export const DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING = 'after_foreground_ready' as const;
export const SessionPendingQueueDeliveryTimingSchema = lazySchema(() => z
  .enum(SESSION_PENDING_QUEUE_DELIVERY_TIMINGS)
  .catch(DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING));
export type SessionPendingQueueDeliveryTiming = z.infer<typeof SessionPendingQueueDeliveryTimingSchema>;

function backfillLegacyTargetKeyedAccountSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const next = { ...raw };

  if (next.backendEnabledByTargetKey === undefined && raw.backendEnabledById !== undefined) {
    next.backendEnabledByTargetKey = rekeyLegacyBuiltInAgentMap<boolean>(raw.backendEnabledById);
  }

  if (next.backendCliSourcePreferenceByTargetKey === undefined && raw.backendCliSourcePreferenceById !== undefined) {
    next.backendCliSourcePreferenceByTargetKey = rekeyLegacyBuiltInAgentMap<'system-first' | 'managed-first'>(raw.backendCliSourcePreferenceById);
  }

  if (next.notificationChannelsV1 !== undefined) {
    const parsedChannels = NotificationChannelsV1Schema.safeParse(next.notificationChannelsV1);
    if (parsedChannels.success) {
      next.notificationChannelsV1 = parsedChannels.data;
    } else {
      delete next.notificationChannelsV1;
    }
  }

  if (next.notificationChannelsV1 === undefined) {
    next.notificationChannelsV1 = [
      deriveExpoPushNotificationChannelFromLegacySettings(
        NotificationsSettingsV1Schema.parse(raw.notificationsSettingsV1),
      ),
    ];
  }

  if (next.actionsSettingsV1 && typeof next.actionsSettingsV1 === 'object' && !Array.isArray(next.actionsSettingsV1)) {
    const parsed = ActionsSettingsV1Schema.safeParse(next.actionsSettingsV1);
    if (parsed.success) {
      next.actionsSettingsV1 = migrateLegacyDefaultActionsSettingsV1(parsed.data);
    }
  }

  return next;
}

// This is the canonical, forward-compatible schema for the server-synced account settings blob.
// It MUST preserve unknown keys so newer clients can add fields without breaking older ones.
export const AccountSettingsSchema = lazySchema(() => z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return backfillLegacyTargetKeyedAccountSettings(raw as Record<string, unknown>);
  },
  z
    .object({
      schemaVersion: z
        .number()
        .int()
        .min(0)
        .catch(ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION)
        .default(ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION),
      clientEncryptionRequirementV1: ClientEncryptionRequirementSchema,
      backendEnabledByTargetKey: BackendEnabledByTargetKeySchema.default({}),
      backendCliSourcePreferenceByTargetKey: BackendCliSourcePreferenceByTargetKeySchema,
      scmIncludeCoAuthoredBy: z.boolean().optional().catch(undefined),
      actionsSettingsV1: ActionsSettingsV1Schema.catch(DEFAULT_ACTIONS_SETTINGS_V1).default(DEFAULT_ACTIONS_SETTINGS_V1),
      notificationsSettingsV1: NotificationsSettingsV1Schema.default(DEFAULT_NOTIFICATIONS_SETTINGS_V1),
      usageLimitRecoverySettingsV1: UsageLimitRecoverySettingsV1Schema.default(DEFAULT_USAGE_LIMIT_RECOVERY_SETTINGS_V1),
      executionRunsNotifyParentOnCompletionDefault: z.boolean().default(false),
      sessionPendingQueueDrainMode: SessionPendingQueueDrainModeSchema.default(DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE),
      sessionPendingQueueDeliveryTiming: SessionPendingQueueDeliveryTimingSchema.default(
        DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
      ),
      sessionAgentSpawnPolicyV1: SessionAgentSpawnPolicyV1Schema.default(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1),
      connectedServicesDefaultAuthByAgentIdV1: ConnectedServicesDefaultAuthByAgentIdV1Schema.default(
        DEFAULT_CONNECTED_SERVICES_DEFAULT_AUTH_BY_AGENT_ID_V1,
      ),
      connectedServicesAdditionalDefaultAuthByAgentIdV1: ConnectedServicesAdditionalDefaultAuthByAgentIdV1Schema.default(
        DEFAULT_CONNECTED_SERVICES_DEFAULT_AUTH_BY_AGENT_ID_V1,
      ),
      connectedServicesProviderStateSharingSettingsV1:
        ConnectedServicesProviderStateSharingSettingsV1Schema.default(
          DEFAULT_CONNECTED_SERVICES_PROVIDER_STATE_SHARING_SETTINGS_V1,
        ),
      notificationChannelsV1: NotificationChannelsV1Schema.default([
        deriveExpoPushNotificationChannelFromLegacySettings(DEFAULT_NOTIFICATIONS_SETTINGS_V1),
      ]),
      codingPromptBehaviorV1: CodingPromptBehaviorV1Schema.default(DEFAULT_CODING_PROMPT_BEHAVIOR_V1),
      acpCatalogSettingsV1: AcpCatalogSettingsV1Schema.catch({ v: 2, backends: [] }).default({ v: 2, backends: [] }),
    })
    .passthrough(),
));

export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

export function accountSettingsParse(raw: unknown): AccountSettings {
  return AccountSettingsSchema.parse(raw);
}

export function getNotificationsSettingsV1FromAccountSettings(settingsLike: unknown): NotificationsSettingsV1 {
  const rec = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? (settingsLike as Record<string, unknown>)
    : null;
  return NotificationsSettingsV1Schema.parse(rec?.notificationsSettingsV1);
}

export function resolveNotificationChannelsV1FromAccountSettings(settingsLike: unknown): NotificationChannelsV1 {
  const rec = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? (settingsLike as Record<string, unknown>)
    : null;
  const explicit = NotificationChannelsV1Schema.parse(rec?.notificationChannelsV1);
  if (rec && Object.prototype.hasOwnProperty.call(rec, 'notificationChannelsV1')) return explicit;
  return [deriveExpoPushNotificationChannelFromLegacySettings(getNotificationsSettingsV1FromAccountSettings(rec))];
}

/**
 * Canonical answer to "may this account receive Expo push notifications at all".
 *
 * Both the client (token registration and OS permission prompting) and any surface that reports
 * the account-level push state must consume this, so the reported setting and the behavior it
 * describes cannot diverge. An enabled webhook channel is a different delivery channel and does
 * not enable Expo push.
 */
export function isExpoPushNotificationChannelEnabled(settingsLike: unknown): boolean {
  return resolveNotificationChannelsV1FromAccountSettings(settingsLike)
    .some((channel) => channel.kind === 'expo_push' && channel.enabled === true);
}

export { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID };
export type {
  ConnectedServicesDefaultAuthByAgentIdV1,
  ConnectedServicesProviderStateSharingSettingsV1,
  NotificationChannelV1,
  NotificationChannelsV1,
};
