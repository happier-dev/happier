import { describe, expect, it } from 'vitest';

import {
  PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS,
  resolveAndroidNotificationSoundName,
  resolveExpoNotificationSoundName,
  resolvePushNotificationAndroidChannelId,
} from './pushNotificationActions.js';

describe('push notification sound catalog', () => {
  it('maps bundled sound ids to Expo notification filenames', () => {
    expect(resolveExpoNotificationSoundName('soft')).toBe('happier_soft.wav');
    expect(resolveExpoNotificationSoundName('urgent')).toBe('happier_urgent.wav');
    expect(resolveExpoNotificationSoundName('default')).toBe('default');
    expect(resolveExpoNotificationSoundName('none')).toBeNull();
  });

  it('does not expose unsupported sound ids as platform sound names', () => {
    expect(resolveExpoNotificationSoundName('custom:imported-tone')).toBeNull();
    expect(resolveExpoNotificationSoundName('future-bundled-tone')).toBeNull();
    expect(resolveAndroidNotificationSoundName('custom:imported-tone')).toBeUndefined();
    expect(resolveAndroidNotificationSoundName('future-bundled-tone')).toBeUndefined();
  });

  it('derives Android notification channels for bundled and silent sounds', () => {
    expect(resolvePushNotificationAndroidChannelId({
      kind: 'permission',
      soundId: 'urgent',
    })).toBe(PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsUrgentV1);

    expect(resolvePushNotificationAndroidChannelId({
      kind: 'ready',
      soundId: 'soft',
    })).toBe(PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultSoftV1);

    expect(resolvePushNotificationAndroidChannelId({
      kind: 'user_action',
      soundId: 'none',
    })).toBe(PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsSilentV1);
  });
});
