import { z } from 'zod';

import { ActionsSettingsV1Schema, type ActionsSettingsV1 } from '../../actions/actionSettings.js';
import { AcpCatalogSettingsV1Schema } from '../../acpCatalog/settingsV1.js';
import {
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  NotificationChannelsV1Schema,
  deriveExpoPushNotificationChannelFromLegacySettings,
  type NotificationChannelV1,
  type NotificationChannelsV1,
} from './notificationChannels.js';

function rekeyLegacyBuiltInAgentMap<T>(raw: unknown): Record<string, T> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(([key]) => typeof key === 'string' && key.trim().length > 0)
    .map(([key, value]) => [`agent:${key.trim()}`, value as T]);
  return Object.fromEntries(entries);
}

export const ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION = 2;

export const ForegroundBehaviorSchema = z.enum(['full', 'silent', 'off']);
export type ForegroundBehavior = z.infer<typeof ForegroundBehaviorSchema>;

export const NotificationsSettingsV1Schema = z
  .object({
    v: z.literal(1).default(1),
    pushEnabled: z.boolean().default(true),
    ready: z.boolean().default(true),
    readyIncludeMessageText: z.boolean().default(true),
    permissionRequest: z.boolean().default(true),
    userActionRequest: z.boolean().default(true),
    foregroundBehavior: ForegroundBehaviorSchema.default('full'),
  })
  .catch({
    v: 1,
    pushEnabled: true,
    ready: true,
    readyIncludeMessageText: true,
    permissionRequest: true,
    userActionRequest: true,
    foregroundBehavior: 'full',
  });

export type NotificationsSettingsV1 = z.infer<typeof NotificationsSettingsV1Schema>;

export const DEFAULT_NOTIFICATIONS_SETTINGS_V1: NotificationsSettingsV1 = NotificationsSettingsV1Schema.parse({});

export const DEFAULT_ACTIONS_SETTINGS_V1: ActionsSettingsV1 = ActionsSettingsV1Schema.parse({
  v: 1,
  actions: {
    // Fail-closed: session agents must not control other sessions by default.
    // Users can explicitly opt in per action via settings.
    'session.stop': { disabledSurfaces: ['session_agent'] },
    'session.permission_mode.set': { disabledSurfaces: ['session_agent'] },
    'session.model.set': { disabledSurfaces: ['session_agent'] },
    'session.archive': { disabledSurfaces: ['session_agent'] },
    'session.unarchive': { disabledSurfaces: ['session_agent'] },
    'session.status.get': { disabledSurfaces: ['session_agent'] },
    'session.history.get': { disabledSurfaces: ['session_agent'] },
    'session.wait.idle': { disabledSurfaces: ['session_agent'] },
    'session.message.send': { disabledSurfaces: ['session_agent'] },
    'session.permission.respond': { disabledSurfaces: ['session_agent'] },
    'session.user_action.answer': { disabledSurfaces: ['session_agent'] },
    'session.mode.set': { disabledSurfaces: ['session_agent'] },
    'session.list': { disabledSurfaces: ['session_agent'] },
    'session.activity.get': { disabledSurfaces: ['session_agent'] },
    'session.messages.recent.get': { disabledSurfaces: ['session_agent'] },
  },
});

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

function migrateLegacyDefaultActionsSettingsV1(settings: ActionsSettingsV1): ActionsSettingsV1 {
  if (!isLegacyDefaultSessionAgentActionLockdownV1(settings)) return settings;
  const actions = { ...(settings.actions as any) } as ActionsSettingsV1['actions'];
  delete (actions as any)['session.title.set'];
  return { ...settings, actions };
}

const BackendEnabledByTargetKeySchema = z.record(z.string(), z.boolean()).catch({});
const BackendCliSourcePreferenceSchema = z.enum(['system-first', 'managed-first']);
const BackendCliSourcePreferenceByTargetKeySchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([, value]) => value === 'system-first' || value === 'managed-first',
    ),
  );
}, z.record(z.string(), BackendCliSourcePreferenceSchema)).default({});

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
export const AccountSettingsSchema = z.preprocess(
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
      backendEnabledByTargetKey: BackendEnabledByTargetKeySchema.default({}),
      backendCliSourcePreferenceByTargetKey: BackendCliSourcePreferenceByTargetKeySchema,
      scmIncludeCoAuthoredBy: z.boolean().optional().catch(undefined),
      actionsSettingsV1: ActionsSettingsV1Schema.catch(DEFAULT_ACTIONS_SETTINGS_V1).default(DEFAULT_ACTIONS_SETTINGS_V1),
      notificationsSettingsV1: NotificationsSettingsV1Schema.default(DEFAULT_NOTIFICATIONS_SETTINGS_V1),
      notificationChannelsV1: NotificationChannelsV1Schema.default([
        deriveExpoPushNotificationChannelFromLegacySettings(DEFAULT_NOTIFICATIONS_SETTINGS_V1),
      ]),
      acpCatalogSettingsV1: AcpCatalogSettingsV1Schema.catch({ v: 2, backends: [] }).default({ v: 2, backends: [] }),
    })
    .passthrough(),
);

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

export { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID };
export type { NotificationChannelV1, NotificationChannelsV1 };
