import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountSettingsParse,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  LiveActivityRemoteUpdateRequestV1Schema,
  type LiveActivityRemoteUpdateRequestV1,
} from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { dispatchActivityNotificationAsync } from './dispatchActivityNotification';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('dispatchActivityNotificationAsync', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(logger.debug).mockReset();
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 202,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the builtin expo push channel when explicit channels are missing', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-1',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Review branch',
      'The branch is ready to review.',
      { sessionId: 'session-1' },
      { sound: 'happier_soft.wav', priority: 'high', androidSoundId: 'soft' },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('suppresses Expo push delivery during account quiet hours', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
        },
      },
    });

    const result = await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      nowMs: () => Date.parse('2026-05-03T12:00:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-quiet',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps webhook delivery active during account quiet hours by default', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
        },
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            value: 'webhook-secret',
          },
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    const result = await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      nowMs: () => Date.parse('2026-05-03T12:00:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-webhook',
        sessionTitle: 'Deploy fix',
        waitingForCommandLabel: 'Gemini',
        assistantPreviewText: 'Deployment is complete.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('suppresses webhook delivery during quiet hours when policy opts in', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
        },
        channels: {
          webhook: {
            quietHoursBehavior: 'suppress',
          },
        },
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    const result = await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      nowMs: () => Date.parse('2026-05-03T12:00:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-webhook-quiet',
        sessionTitle: 'Deploy fix',
        waitingForCommandLabel: 'Gemini',
        assistantPreviewText: 'Deployment is complete.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('suppresses policy-disabled Expo push channels even when legacy channel rows are enabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          expo_push: { enabled: false },
        },
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'expo-enabled',
          kind: 'expo_push',
          enabled: true,
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: true,
        },
      ],
    });

    const result = await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-disabled',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('uses canonical Expo push policy even when legacy channel rows are stale-disabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          expo_push: {
            enabled: true,
            events: {
              ready: { enabled: true },
            },
          },
        },
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'expo-stale-disabled',
          kind: 'expo_push',
          enabled: false,
          topics: {
            ready: false,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: true,
        },
      ],
    });

    const result = await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-enabled',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
  });

  it('uses canonical Expo push policy when legacy channel rows are absent', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          expo_push: {
            enabled: true,
            events: {
              ready: { enabled: true },
            },
          },
        },
      },
      notificationChannelsV1: [],
    });

    const result = await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-policy-only',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
  });

  it('passes resolved silent sound options to Expo push senders', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        sounds: {
          defaultSoundId: 'none',
        },
      },
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-silent',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Review branch',
      'The branch is ready to review.',
      { sessionId: 'session-silent' },
      { sound: null, priority: 'high', androidSoundId: 'none' },
    );
  });

  it('maps bundled policy sounds to Expo notification filenames and Android sound channels', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        sounds: {
          defaultSoundId: 'soft',
          eventSoundIds: {
            permission_request: 'urgent',
          },
        },
      },
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'permission_request',
        sessionId: 'session-sound',
        requestId: 'request-1',
        sessionTitle: 'Review branch',
        toolName: 'Bash',
        toolDetails: 'Run git status',
      },
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ sessionId: 'session-sound', kind: 'permission' }),
      { sound: 'happier_urgent.wav', priority: 'high', androidSoundId: 'urgent' },
    );
  });

  it('does not pass unsupported custom sound ids to Expo push senders', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        sounds: {
          defaultSoundId: 'custom:imported-tone',
        },
      },
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'permission_request',
        sessionId: 'session-custom-sound',
        sessionTitle: 'Review branch',
        requestId: 'request-custom-sound',
        toolName: 'Bash',
        toolDetails: 'Run git status',
      },
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Permission Request',
      expect.stringContaining('Bash'),
      expect.objectContaining({ sessionId: 'session-custom-sound', kind: 'permission' }),
      { sound: null, priority: 'high', androidSoundId: 'none' },
    );
  });

  it('sends a Live Activity remote update as its own delivery channel', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        liveActivityRemoteUpdates: {
          enabled: true,
          preferredMode: 'direct_apns',
          defaultStaleAfterSeconds: 900,
        },
      },
    });

    const result = await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      liveActivityRemoteSender: {
        serverId: 'server-a',
        sendLiveActivityRemoteUpdateAsync,
      },
      nowMs: () => Date.parse('2026-05-04T12:00:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-live',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(result).toEqual({ attemptedChannels: 2, deliveredChannels: 2 });
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Review branch',
      'The branch is ready to review.',
      { sessionId: 'session-live' },
      { sound: 'happier_soft.wav', priority: 'high', androidSoundId: 'soft' },
    );
    expect(sendLiveActivityRemoteUpdateAsync).toHaveBeenCalledTimes(1);
    const request = sendLiveActivityRemoteUpdateAsync.mock.calls[0]?.[0];
    expect(LiveActivityRemoteUpdateRequestV1Schema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({
      v: 1,
      createdAt: Date.parse('2026-05-04T12:00:00.000Z'),
      transportMode: 'direct_apns',
      event: 'update',
      activityKey: {
        serverId: 'server-a',
        sessionId: 'session-live',
        activityName: 'HappierFocusLiveActivity',
      },
      contentState: {
        version: 1,
        generatedAt: Date.parse('2026-05-04T12:00:00.000Z'),
        staleAt: Date.parse('2026-05-04T12:15:00.000Z'),
        sessionId: 'session-live',
        title: 'Review branch',
        previewText: 'The branch is ready to review.',
        attentionState: 'unread',
      },
    });
    expect(request).not.toHaveProperty('interruptiveAlert');
  });

  it('omits Live Activity preview text when policy allows title only', async () => {
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          expo_push: { enabled: false },
        },
        privacy: {
          defaultPreviewBehavior: 'include_preview',
          surfaces: {
            live_activity: 'title_only',
          },
        },
        liveActivityRemoteUpdates: {
          enabled: true,
          preferredMode: 'direct_apns',
        },
      },
    });

    const result = await dispatchActivityNotificationAsync({
      settings,
      liveActivityRemoteSender: {
        serverId: 'server-a',
        sendLiveActivityRemoteUpdateAsync,
      },
      nowMs: () => Date.parse('2026-05-04T12:00:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-private',
        sessionTitle: 'Private project',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'secret transcript detail',
      },
    });

    expect(result).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    const request = sendLiveActivityRemoteUpdateAsync.mock.calls[0]?.[0];
    expect(request?.contentState?.previewText).toBeNull();
    expect(request?.contentState?.title).toBe('Private project');
    expect(JSON.stringify(request)).not.toContain('secret transcript detail');
  });

  it('filters title-only permission details from Live Activity state and alert intent', async () => {
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          expo_push: { enabled: false },
        },
        privacy: {
          defaultPreviewBehavior: 'include_preview',
          surfaces: {
            live_activity: 'title_only',
          },
        },
        liveActivityRemoteUpdates: {
          enabled: true,
          preferredMode: 'direct_apns',
        },
      },
    });

    await dispatchActivityNotificationAsync({
      settings,
      liveActivityRemoteSender: {
        serverId: 'server-a',
        sendLiveActivityRemoteUpdateAsync,
      },
      nowMs: () => Date.parse('2026-05-04T12:00:00.000Z'),
      event: {
        topic: 'permission_request',
        sessionId: 'session-private-permission',
        sessionTitle: 'Private project',
        requestId: 'permission-private',
        toolName: 'Bash',
        toolDetails: 'Run command containing private-token',
      },
    });

    const request = sendLiveActivityRemoteUpdateAsync.mock.calls[0]?.[0];
    expect(request?.contentState?.title).toBe('Private project');
    expect(request?.contentState?.subtitle).toBeNull();
    expect(request?.contentState?.previewText).toBeNull();
    expect(request?.contentState?.statusText).toBe('Permission required');
    expect(request?.event === 'update' ? request.interruptiveAlert?.body : undefined).toBe('Permission required');
    expect(JSON.stringify(request)).not.toContain('Bash');
    expect(JSON.stringify(request)).not.toContain('private-token');
  });

  it('keeps quiet Live Activity freshness updates non-interruptive', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
        },
        liveActivityRemoteUpdates: {
          enabled: true,
          preferredMode: 'direct_apns',
          quietHoursBehavior: 'silent',
        },
      },
    });

    const result = await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      liveActivityRemoteSender: {
        serverId: 'server-a',
        sendLiveActivityRemoteUpdateAsync,
      },
      nowMs: () => Date.parse('2026-05-04T12:00:00.000Z'),
      event: {
        topic: 'permission_request',
        sessionId: 'session-quiet-live',
        sessionTitle: 'Production fix',
        requestId: 'permission-1',
        toolName: 'Bash',
        toolInput: { command: 'npm test && echo secret-token' },
      },
    });

    expect(result).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    const request = sendLiveActivityRemoteUpdateAsync.mock.calls[0]?.[0];
    expect(request).not.toHaveProperty('interruptiveAlert');
    expect(request?.contentState?.attentionState).toBe('permission_required');
    expect(JSON.stringify(request)).not.toContain('secret-token');
  });

  it('dispatches only to enabled explicit channels', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'expo-disabled',
          kind: 'expo_push',
          enabled: false,
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: true,
        },
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            value: 'webhook-secret',
          },
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-2',
        sessionTitle: 'Deploy fix',
        waitingForCommandLabel: 'Gemini',
        assistantPreviewText: 'Deployment is complete.',
      },
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('https://hooks.example.test/happier');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-happier-signature-256': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
      },
    });
    const payload = JSON.parse(String(init.body));
    expect(payload.content).toEqual({
      title: 'Deploy fix',
      body: 'Gemini is waiting for your command',
    });
  });

  it('sends sanitized request payloads to webhook channels', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            value: 'webhook-secret',
          },
          topics: {
            ready: false,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'permission_request',
        sessionId: 'session-3',
        sessionTitle: 'Fix prod issue',
        requestId: 'request-9',
        toolName: 'Bash',
        toolInput: { command: 'git status --short && echo secret-token' },
      },
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const payload = JSON.parse(String(init.body));
    expect(init).toMatchObject({
      headers: {
        'content-type': 'application/json',
        'x-happier-signature-256': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
      },
    });
    expect(payload.request).toMatchObject({
      requestId: 'request-9',
      kind: 'permission',
      toolName: 'Bash',
      toolDetails: 'Command: git',
    });
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  });

  it('decrypts encrypted webhook signing secrets when settings secret read keys are provided', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(new Uint8Array(32).fill(7));
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            encryptedValue: encryptSecretStringV1(
              'sealed-webhook-secret',
              settingsSecretsKey,
              (length) => new Uint8Array(length).fill(3),
            ),
          },
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      settingsSecretsReadKeys: [settingsSecretsKey],
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-4',
        sessionTitle: 'Ship release',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'Release branch is ready.',
      },
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init).toMatchObject({
      headers: {
        'content-type': 'application/json',
        'x-happier-signature-256': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
      },
    });
  });

  it('redacts transport error details before logging failed notification dispatches', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {
      throw {
        isAxiosError: true,
        name: 'AxiosError',
        message: 'Request failed with status code 401',
        config: {
          method: 'post',
          url: 'https://api.example.test/v1/push-tokens?token=query-secret',
          headers: { Authorization: 'Bearer authorization-secret' },
          data: { body: 'private notification body' },
        },
        response: { status: 401 },
      };
    });
    const settings = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
      },
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-log-redaction',
        sessionTitle: 'Private title',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'private notification body',
      },
    });

    expect(logger.debug).toHaveBeenCalledWith(
      '[activityNotifications] Failed to dispatch outbound notification',
      expect.objectContaining({
        name: 'AxiosError',
        status: 401,
        method: 'POST',
        url: 'https://api.example.test/v1/push-tokens',
      }),
    );
    const logged = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(logged).not.toContain('Authorization');
    expect(logged).not.toContain('authorization-secret');
    expect(logged).not.toContain('query-secret');
    expect(logged).not.toContain('private notification body');
  });
});
