export const PUSH_NOTIFICATION_CATEGORY_IDS = {
  permissionRequestV1: 'happier.permissionRequest.v1',
  userActionRequestV1: 'happier.userActionRequest.v1',
} as const;

export const PUSH_NOTIFICATION_ACTION_IDS = {
  permissionAllowV1: 'HAPPIER_PERMISSION_ALLOW_V1',
  permissionDenyV1: 'HAPPIER_PERMISSION_DENY_V1',
  userActionOpenV1: 'HAPPIER_USER_ACTION_OPEN_V1',
} as const;

export const PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS = {
  defaultV1: 'default',
  permissionRequestsV1: 'happier.permissionRequests.v1',
  userActionRequestsV1: 'happier.userActionRequests.v1',
  defaultSoftV1: 'happier.default.soft.v1',
  defaultUrgentV1: 'happier.default.urgent.v1',
  defaultSilentV1: 'happier.default.silent.v1',
  permissionRequestsSoftV1: 'happier.permissionRequests.soft.v1',
  permissionRequestsUrgentV1: 'happier.permissionRequests.urgent.v1',
  permissionRequestsSilentV1: 'happier.permissionRequests.silent.v1',
  userActionRequestsSoftV1: 'happier.userActionRequests.soft.v1',
  userActionRequestsUrgentV1: 'happier.userActionRequests.urgent.v1',
  userActionRequestsSilentV1: 'happier.userActionRequests.silent.v1',
} as const;

export const PUSH_NOTIFICATION_SOUND_IDS = {
  none: 'none',
  systemDefault: 'default',
  soft: 'soft',
  urgent: 'urgent',
} as const;

export type PushNotificationSoundId =
  typeof PUSH_NOTIFICATION_SOUND_IDS[keyof typeof PUSH_NOTIFICATION_SOUND_IDS];

export const PUSH_NOTIFICATION_BUNDLED_SOUND_FILES = {
  soft: {
    expoSoundName: 'happier_soft.wav',
    androidSoundName: 'happier_soft',
  },
  urgent: {
    expoSoundName: 'happier_urgent.wav',
    androidSoundName: 'happier_urgent',
  },
} as const satisfies Record<string, Readonly<{
  expoSoundName: string;
  androidSoundName: string;
}>>;

export type PushNotificationBundledSoundId = keyof typeof PUSH_NOTIFICATION_BUNDLED_SOUND_FILES;

type PushNotificationAndroidChannelKind = 'ready' | 'permission' | 'user_action';

const ANDROID_CHANNEL_IDS_BY_KIND = {
  ready: {
    default: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultV1,
    soft: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultSoftV1,
    urgent: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultUrgentV1,
    silent: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultSilentV1,
  },
  permission: {
    default: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsV1,
    soft: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsSoftV1,
    urgent: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsUrgentV1,
    silent: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsSilentV1,
  },
  user_action: {
    default: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsV1,
    soft: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsSoftV1,
    urgent: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsUrgentV1,
    silent: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsSilentV1,
  },
} as const satisfies Record<PushNotificationAndroidChannelKind, Readonly<{
  default: string;
  soft: string;
  urgent: string;
  silent: string;
}>>;

export function isPushNotificationBundledSoundId(value: string | null | undefined): value is PushNotificationBundledSoundId {
  return typeof value === 'string' && value in PUSH_NOTIFICATION_BUNDLED_SOUND_FILES;
}

export function resolveExpoNotificationSoundName(soundId: string | null | undefined): string | null {
  if (!soundId || soundId === PUSH_NOTIFICATION_SOUND_IDS.systemDefault) return 'default';
  if (soundId === PUSH_NOTIFICATION_SOUND_IDS.none) return null;
  const bundled = isPushNotificationBundledSoundId(soundId)
    ? PUSH_NOTIFICATION_BUNDLED_SOUND_FILES[soundId]
    : null;
  return bundled?.expoSoundName ?? null;
}

export function resolveAndroidNotificationSoundName(soundId: string | null | undefined): string | null | undefined {
  if (!soundId || soundId === PUSH_NOTIFICATION_SOUND_IDS.systemDefault) return undefined;
  if (soundId === PUSH_NOTIFICATION_SOUND_IDS.none) return null;
  const bundled = isPushNotificationBundledSoundId(soundId)
    ? PUSH_NOTIFICATION_BUNDLED_SOUND_FILES[soundId]
    : null;
  return bundled?.androidSoundName;
}

export function resolvePushNotificationAndroidChannelId(params: Readonly<{
  kind: PushNotificationAndroidChannelKind;
  soundId?: string | null;
}>): string {
  const channels = ANDROID_CHANNEL_IDS_BY_KIND[params.kind];
  if (params.soundId === PUSH_NOTIFICATION_SOUND_IDS.none) return channels.silent;
  if (params.soundId === PUSH_NOTIFICATION_SOUND_IDS.soft) return channels.soft;
  if (params.soundId === PUSH_NOTIFICATION_SOUND_IDS.urgent) return channels.urgent;
  return channels.default;
}
