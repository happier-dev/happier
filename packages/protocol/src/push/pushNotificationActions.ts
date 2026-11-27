export const PUSH_NOTIFICATION_CATEGORY_IDS = {
  permissionRequestV1: 'happier.permissionRequest.v1',
  userActionRequestV1: 'happier.userActionRequest.v1',
  questionChoices1V1: 'happier.questionChoices1.v1',
  questionChoices2V1: 'happier.questionChoices2.v1',
  questionChoices3V1: 'happier.questionChoices3.v1',
  questionTextV1: 'happier.questionText.v1',
  guardStopWarningV1: 'happier.guardStopWarning.v1',
} as const;

export const PUSH_NOTIFICATION_ACTION_IDS = {
  permissionAllowV1: 'HAPPIER_PERMISSION_ALLOW_V1',
  permissionDenyV1: 'HAPPIER_PERMISSION_DENY_V1',
  userActionOpenV1: 'HAPPIER_USER_ACTION_OPEN_V1',
  questionChoice1V1: 'HAPPIER_QUESTION_CHOICE_1_V1',
  questionChoice2V1: 'HAPPIER_QUESTION_CHOICE_2_V1',
  questionChoice3V1: 'HAPPIER_QUESTION_CHOICE_3_V1',
  questionTextV1: 'HAPPIER_QUESTION_TEXT_V1',
  guardKeepRunningV1: 'HAPPIER_GUARD_KEEP_RUNNING_V1',
  guardStopNowV1: 'HAPPIER_GUARD_STOP_NOW_V1',
} as const;

const PLUGIN_NOTIFICATION_CATEGORY_PREFIX = 'happier.pluginNotification.v1/';

export function buildPluginNotificationCategoryId(pluginId: string, categoryId: string): string {
  // Expo forbids ':'/'-' in native category identifiers. Encode their carrier
  // spelling rather than restricting canonical plugin/category names.
  const encodeCategoryPart = (value: string) => encodeURIComponent(value).replace(/-/g, '%2D');
  return `${PLUGIN_NOTIFICATION_CATEGORY_PREFIX}${encodeCategoryPart(pluginId)}/${encodeCategoryPart(categoryId)}`;
}

export function buildPluginNotificationButtonId(pluginId: string, categoryId: string, buttonId: string): string {
  return `${buildPluginNotificationCategoryId(pluginId, categoryId)}/${encodeURIComponent(buttonId)}`;
}

export function parsePluginNotificationButtonId(identifier: string): Readonly<{ pluginId: string; categoryId: string; buttonId: string }> | null {
  if (!identifier.startsWith(PLUGIN_NOTIFICATION_CATEGORY_PREFIX)) return null;
  const parts = identifier.slice(PLUGIN_NOTIFICATION_CATEGORY_PREFIX.length).split('/');
  if (parts.length !== 3) return null;
  try {
    const [pluginId, categoryId, buttonId] = parts.map(part => decodeURIComponent(part));
    if (!pluginId || !categoryId || !buttonId || buildPluginNotificationButtonId(pluginId, categoryId, buttonId) !== identifier) return null;
    return { pluginId, categoryId, buttonId };
  } catch { return null; }
}

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
  drop: 'drop',
  chime: 'chime',
  chord: 'chord',
  swell: 'swell',
  glow: 'glow',
  flutter: 'flutter',
  pop: 'pop',
  blip: 'blip',
  tap: 'tap',
  ping: 'ping',
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
  drop: { expoSoundName: 'happier_drop.wav', androidSoundName: 'happier_drop' },
  chime: { expoSoundName: 'happier_chime.wav', androidSoundName: 'happier_chime' },
  chord: { expoSoundName: 'happier_chord.wav', androidSoundName: 'happier_chord' },
  swell: { expoSoundName: 'happier_swell.wav', androidSoundName: 'happier_swell' },
  glow: { expoSoundName: 'happier_glow.wav', androidSoundName: 'happier_glow' },
  flutter: { expoSoundName: 'happier_flutter.wav', androidSoundName: 'happier_flutter' },
  pop: { expoSoundName: 'happier_pop.wav', androidSoundName: 'happier_pop' },
  blip: { expoSoundName: 'happier_blip.wav', androidSoundName: 'happier_blip' },
  tap: { expoSoundName: 'happier_tap.wav', androidSoundName: 'happier_tap' },
  ping: { expoSoundName: 'happier_ping.wav', androidSoundName: 'happier_ping' },
} as const satisfies Record<string, Readonly<{
  expoSoundName: string;
  androidSoundName: string;
}>>;

export type PushNotificationBundledSoundId = keyof typeof PUSH_NOTIFICATION_BUNDLED_SOUND_FILES;
export type ExpoNotificationSoundName =
  'default' | typeof PUSH_NOTIFICATION_BUNDLED_SOUND_FILES[PushNotificationBundledSoundId]['expoSoundName'];

export type PushNotificationAndroidChannelKind = 'ready' | 'permission' | 'user_action';

export function resolvePushNotificationAndroidChannelKind(event: string): PushNotificationAndroidChannelKind {
  if (event === 'permission_request') return 'permission';
  if (event === 'user_action_request') return 'user_action';
  return 'ready';
}

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
  return typeof value === 'string' && Object.hasOwn(PUSH_NOTIFICATION_BUNDLED_SOUND_FILES, value);
}

export function resolveExpoNotificationSoundName(soundId: string | null | undefined): ExpoNotificationSoundName | null {
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
  if (isPushNotificationBundledSoundId(params.soundId)) return `happier.${params.kind}.${params.soundId}.v1`;
  return channels.default;
}
