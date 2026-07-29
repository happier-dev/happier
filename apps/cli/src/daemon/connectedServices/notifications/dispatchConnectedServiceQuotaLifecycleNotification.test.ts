import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { dispatchConnectedServiceQuotaLifecycleNotificationAsync } from './dispatchConnectedServiceQuotaLifecycleNotification';

type SendToAllDevicesAsync = (title: string, body: string, data: Record<string, unknown>) => Promise<void>;

function buildSettings(topics: Readonly<{ blocked: boolean; recovered: boolean }>) {
  return accountSettingsParse({
    notificationChannelsV1: [{
      v: 1,
      id: 'expo',
      kind: 'expo_push',
      enabled: true,
      topics: {
        ready: false,
        permissionRequest: false,
        userActionRequest: false,
        connectedServiceAccountSwitch: false,
        connectedServiceCredentialHealth: false,
        connectedServiceQuotaBlocked: topics.blocked,
        connectedServiceQuotaRecovered: topics.recovered,
      },
      readyIncludeMessageText: false,
    }],
  });
}

describe('dispatchConnectedServiceQuotaLifecycleNotificationAsync', () => {
  it('dispatches a quota-blocked notification per affected session with retry timing from the known reset', async () => {
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async () => {});

    await dispatchConnectedServiceQuotaLifecycleNotificationAsync({
      settings: buildSettings({ blocked: true, recovered: true }),
      settingsSecretsReadKeys: [],
      expoPushSender: { sendToAllDevicesAsync },
      transition: {
        phase: 'blocked',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        sessionIds: ['sess-1', 'sess-2'],
        issueFingerprint: 'quota-blocked:openai-codex:main',
        resetAtMs: 90_000,
        reason: 'connected_service_group_quota_exhausted',
      },
      nowMs: () => 30_000,
      dedupeWindowMs: 0,
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);
    const [, , data] = sendToAllDevicesAsync.mock.calls[0] ?? [];
    expect(data).toMatchObject({
      topic: 'connected_service_quota_blocked',
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      serviceDisplayName: 'OpenAI',
      groupId: 'main',
      profileId: 'primary',
      issueFingerprint: 'quota-blocked:openai-codex:main',
      retryAfterMs: 60_000,
    });
  });

  it('suppresses dispatch when the quota-blocked topic is disabled on the channel', async () => {
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async () => {});

    await dispatchConnectedServiceQuotaLifecycleNotificationAsync({
      settings: buildSettings({ blocked: false, recovered: true }),
      settingsSecretsReadKeys: [],
      expoPushSender: { sendToAllDevicesAsync },
      transition: {
        phase: 'blocked',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        sessionIds: ['sess-1'],
        issueFingerprint: 'quota-blocked:openai-codex:main',
        resetAtMs: null,
        reason: 'connected_service_group_quota_exhausted',
      },
      nowMs: () => 30_000,
      dedupeWindowMs: 0,
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('dispatches the quota-recovered topic on the recovered edge without retry timing', async () => {
    const sendToAllDevicesAsync = vi.fn<SendToAllDevicesAsync>(async () => {});

    await dispatchConnectedServiceQuotaLifecycleNotificationAsync({
      settings: buildSettings({ blocked: true, recovered: true }),
      settingsSecretsReadKeys: [],
      expoPushSender: { sendToAllDevicesAsync },
      transition: {
        phase: 'recovered',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        sessionIds: ['sess-1'],
        issueFingerprint: 'quota-blocked:openai-codex:main',
        resetAtMs: null,
        reason: 'fresh_quota_evidence',
      },
      nowMs: () => 30_000,
      dedupeWindowMs: 0,
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    const [, , data] = sendToAllDevicesAsync.mock.calls[0] ?? [];
    expect(data).toMatchObject({
      topic: 'connected_service_quota_recovered',
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      serviceDisplayName: 'OpenAI',
      profileId: 'backup',
      retryAfterMs: null,
    });
  });
});
