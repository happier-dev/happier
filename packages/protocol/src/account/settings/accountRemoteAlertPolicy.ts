import {
  AttentionPreviewBehaviorSchema,
  REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS,
  AttentionDeliveryPolicyV1Schema,
  composeAttentionDeliveryPolicyDeviceOverrides,
  type AttentionDeliveryEventConfig,
  type AttentionDeliveryPolicyV1,
  type AttentionPreviewBehavior,
  type ResolveAttentionDeliveryPolicyDecisionParams,
} from './attentionDeliveryPolicy.js';
import { ACCOUNT_SETTING_ARTIFACTS, type AccountSettings } from './accountSettings.js';
import { isRecord } from '../../common/records.js';
import { readAccountAttentionDeliveryPolicy } from './attentionPolicyIngress.js';
import { resolveAttentionDeliveryPolicyDecision, resolveAttentionNotificationSound } from './attentionDeliveryPolicyDecision.js';
import { PUSH_NOTIFICATION_SOUND_IDS } from '../../push/pushNotificationActions.js';
import {
  AccountRemoteAlertPolicyBindingV1Schema, AccountRemoteAlertPolicyV1Schema,
  DeviceRemoteAlertPolicyV1Schema, RemoteAlertSoundIdSchema,
  type AccountRemoteAlertPolicyV1, type RemoteAlertSoundId,
} from './accountRemoteAlertPolicySchema.js';
export * from './accountRemoteAlertPolicySchema.js';

export function resolveAccountRemoteAlertPolicyCurrentness(value: unknown, settingsVersion: number):
  | { status: 'disabled' | 'stale'; policy: null }
  | { status: 'current'; policy: AccountRemoteAlertPolicyV1 } {
  if (value === null || value === undefined) return { status: 'disabled', policy: null };
  const parsed = AccountRemoteAlertPolicyBindingV1Schema.safeParse(value);
  return parsed.success && parsed.data.settingsVersion === settingsVersion
    ? { status: 'current', policy: parsed.data.policy }
    : { status: 'stale', policy: null };
}

function remoteSound(id: string): RemoteAlertSoundId {
  const parsed = RemoteAlertSoundIdSchema.safeParse(id);
  return parsed.success ? parsed.data : PUSH_NOTIFICATION_SOUND_IDS.none;
}

function projectEvent(event: AttentionDeliveryEventConfig) {
  return {
    enabled: event.enabled,
    ...(event.quietHoursBehavior === undefined ? {} : { quietHoursBehavior: event.quietHoursBehavior }),
    ...(event.previewBehavior === undefined ? {} : { previewBehavior: event.previewBehavior }),
    ...(event.soundId === undefined ? {} : { soundId: remoteSound(event.soundId) }),
  };
}

/** The Account/device projections consume this admitted policy subset, not the full document. */
export function readAccountRemoteAlertSettings(settings: unknown): Pick<AccountSettings,
  'sessionRemoteAlertsEnabled' | 'machineOfflineAlertsV1' | 'attentionDeliveryPolicyV1'> {
  const source = isRecord(settings) ? settings : {};
  return {
    sessionRemoteAlertsEnabled: ACCOUNT_SETTING_ARTIFACTS.shape.sessionRemoteAlertsEnabled.parse(source.sessionRemoteAlertsEnabled),
    machineOfflineAlertsV1: ACCOUNT_SETTING_ARTIFACTS.shape.machineOfflineAlertsV1.parse(source.machineOfflineAlertsV1),
    attentionDeliveryPolicyV1: readAccountAttentionDeliveryPolicy(source),
  };
}

export function deriveAccountRemoteAlertPolicyV1(settings: unknown): AccountRemoteAlertPolicyV1 | null {
  const parsed = readAccountRemoteAlertSettings(settings);
  const policy = parsed.attentionDeliveryPolicyV1;
  const machineOfflineEnabled = parsed.machineOfflineAlertsV1.machineIds.length > 0;
  // Wake muting and machine enrollment do not grant remote session consent.
  // The shared projection keeps consent separate for each event family.
  if (parsed.sessionRemoteAlertsEnabled !== true && !machineOfflineEnabled && policy.mutePhoneWhenComputerFocused !== true) return null;
  const projectEvents = (events: AttentionDeliveryPolicyV1['events']) => Object.fromEntries(
    REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS.map((event) => [event, {
      ...projectEvent(events[event]),
      enabled: events[event].enabled && (event === 'machine_offline' ? machineOfflineEnabled : parsed.sessionRemoteAlertsEnabled === true),
    }]),
  );
  const pushEvents = projectEvents(policy.channels.expo_push.events);
  for (const event of REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS) {
    // Only the bundled fallback crosses the server-readable policy boundary.
    const sound = resolveAttentionNotificationSound(policy, event, 'expo_push');
    if (sound.kind === 'custom') pushEvents[event].soundId = sound.fallbackSoundId;
  }
  return AccountRemoteAlertPolicyV1Schema.parse({
    v: 1,
    machineOffline: parsed.machineOfflineAlertsV1,
    events: projectEvents(policy.events),
    channels: { expo_push: { ...projectEvent(policy.channels.expo_push),
      enabled: (parsed.sessionRemoteAlertsEnabled === true || machineOfflineEnabled) && policy.channels.expo_push.enabled,
      events: pushEvents } },
    quietHours: {
      enabled: policy.quietHours.enabled,
      timezone: policy.quietHours.timezone,
      windows: policy.quietHours.windows.map(({ startLocalTime, endLocalTime, days }) => ({ startLocalTime, endLocalTime, ...(days ? { days } : {}) })),
    },
    foregroundBehavior: policy.foregroundBehavior,
    ...(policy.mutePhoneWhenComputerFocused === undefined ? {} : { mutePhoneWhenComputerFocused: policy.mutePhoneWhenComputerFocused }),
    privacy: { defaultPreviewBehavior: policy.privacy.defaultPreviewBehavior, surfaces: policy.privacy.surfaces.expo_push === undefined ? {} : { expo_push: policy.privacy.surfaces.expo_push } },
    sounds: {
      defaultSoundId: remoteSound(policy.sounds.defaultSoundId),
      eventSoundIds: Object.fromEntries(REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS
        .filter((event) => policy.sounds.eventSoundIds[event] !== undefined)
        .map((event) => [event, remoteSound(policy.sounds.eventSoundIds[event])])),
      volume: policy.sounds.volume,
    },
  });
}

export function restrictAttentionPreviewBehavior(
  preview: AttentionPreviewBehavior,
  ceiling: AttentionPreviewBehavior | 'account',
): AttentionPreviewBehavior {
  const order = AttentionPreviewBehaviorSchema.options;
  return ceiling === 'account' || order.indexOf(preview) <= order.indexOf(ceiling) ? preview : ceiling;
}

export function resolveRemoteAlertPolicyDecision(params: Readonly<{
  accountPolicy: unknown;
  devicePolicy: unknown;
  event: string;
  now: Date | string;
  foregroundState?: 'foreground' | 'background';
  follow?: ResolveAttentionDeliveryPolicyDecisionParams['follow'];
  inboxItemType?: ResolveAttentionDeliveryPolicyDecisionParams['inboxItemType'];
}>) {
  const account = AccountRemoteAlertPolicyV1Schema.safeParse(params.accountPolicy);
  const device = DeviceRemoteAlertPolicyV1Schema.safeParse(params.devicePolicy);
  if (!account.success || !device.success || !device.data.enabled) return null;
  // Older saved projections grouped a failed turn under Following.
  const event = params.event === 'task_failed' && !account.data.events.task_failed ? 'follow_update' : params.event;
  if (!Object.hasOwn(account.data.events, event)) return null;
  const policy = composeAttentionDeliveryPolicyDeviceOverrides(AttentionDeliveryPolicyV1Schema.parse(account.data), {
    quietHoursOverride: device.data.quietHoursOverride,
    foregroundBehavior: device.data.foregroundBehavior,
    previewBehavior: 'account',
    soundVolume: device.data.soundVolume,
  });
  const decision = resolveAttentionDeliveryPolicyDecision({ policy, event, channel: 'expo_push', now: params.now,
    foregroundState: params.foregroundState, follow: params.follow, inboxItemType: params.inboxItemType });
  return { ...decision, previewBehavior: restrictAttentionPreviewBehavior(decision.previewBehavior, device.data.previewCeiling) };
}
