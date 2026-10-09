import {
  AttentionPreviewBehaviorSchema,
  REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS,
  AttentionDeliveryPolicyV1Schema,
  composeAttentionDeliveryPolicyDeviceOverrides,
  type AttentionDeliveryEventConfig,
  type AttentionDeliveryPolicyV1,
  type AttentionPreviewBehavior,
} from './attentionDeliveryPolicy.js';
import { accountSettingsParse } from './accountSettings.js';
import { resolveAttentionDeliveryPolicyDecision } from './attentionDeliveryPolicyDecision.js';
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

export function deriveAccountRemoteAlertPolicyV1(settings: unknown): AccountRemoteAlertPolicyV1 | null {
  const parsed = accountSettingsParse(settings);
  const policy = parsed.attentionDeliveryPolicyV1;
  // The same public projection carries wake muting even when Home OS alerts
  // are opted out. It must never turn that opt-out into alert consent.
  if (parsed.sessionRemoteAlertsEnabled !== true && policy.mutePhoneWhenComputerFocused !== true) return null;
  const projectEvents = (events: AttentionDeliveryPolicyV1['events']) => Object.fromEntries(
    REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS.map((event) => [event, projectEvent(events[event])]),
  );
  return AccountRemoteAlertPolicyV1Schema.parse({
    v: 1,
    events: projectEvents(policy.events),
    channels: { expo_push: { ...projectEvent(policy.channels.expo_push),
      enabled: parsed.sessionRemoteAlertsEnabled === true && policy.channels.expo_push.enabled,
      events: projectEvents(policy.channels.expo_push.events) } },
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
}>) {
  const account = AccountRemoteAlertPolicyV1Schema.safeParse(params.accountPolicy);
  const device = DeviceRemoteAlertPolicyV1Schema.safeParse(params.devicePolicy);
  if (!account.success || !device.success || !device.data.enabled) return null;
  if (!Object.hasOwn(account.data.events, params.event)) return null;
  const policy = composeAttentionDeliveryPolicyDeviceOverrides(AttentionDeliveryPolicyV1Schema.parse(account.data), {
    quietHoursOverride: device.data.quietHoursOverride,
    foregroundBehavior: device.data.foregroundBehavior,
    previewBehavior: 'account',
    soundVolume: device.data.soundVolume,
  });
  const decision = resolveAttentionDeliveryPolicyDecision({ policy, event: params.event, channel: 'expo_push', now: params.now, foregroundState: params.foregroundState });
  return { ...decision, previewBehavior: restrictAttentionPreviewBehavior(decision.previewBehavior, device.data.previewCeiling) };
}
