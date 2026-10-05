import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { logger } from '@/ui/logger';
import { PushNotificationClient } from './pushNotifications';
import { sendReadyWithPushNotification } from '@/agent/runtime/notifications/sendReadyWithPushNotification';
import { sendAgentRequestPushNotificationAsync } from '@/settings/notifications/permissionRequestPush';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import {
  HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
  PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS,
  PUSH_NOTIFICATION_CATEGORY_IDS,
  type LiveActivityRemoteUpdateRequestV1,
  accountSettingsParse,
} from '@happier-dev/protocol';

type MockExpoPushTicket = Readonly<{
  status: string;
  id?: string;
  details?: Readonly<{ error?: string }>;
}>;

const sendPushNotificationsAsyncSpy = vi.fn(async (_chunk: any[]): Promise<MockExpoPushTicket[]> =>
  _chunk.map((): MockExpoPushTicket => ({ status: 'ok' })),
);
const getPushNotificationReceiptsAsyncSpy = vi.fn(async (_ids: string[]) => ({}));

vi.mock('axios', () => {
  return {
    __esModule: true,
    default: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), isAxiosError: (err: any) => Boolean(err?.isAxiosError) },
  };
});

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    infoFile: vi.fn(),
  },
}));

vi.mock('expo-server-sdk', () => {
  class Expo {
    static isExpoPushToken() {
      return true;
    }
    chunkPushNotifications(messages: any[]) {
      return [messages];
    }
    async sendPushNotificationsAsync(chunk: any[]) {
      return await sendPushNotificationsAsyncSpy(chunk);
    }
    async getPushNotificationReceiptsAsync(ids: string[]) {
      return await getPushNotificationReceiptsAsyncSpy(ids);
    }
  }

  return {
    __esModule: true,
    Expo,
  };
});

describe('PushNotificationClient.sendToAllDevicesAsync', () => {
  const originalDebugPush = process.env.HAPPIER_DEBUG_PUSH;

  beforeEach(() => {
    sendPushNotificationsAsyncSpy.mockClear();
    getPushNotificationReceiptsAsyncSpy.mockClear();
    (logger.debug as any).mockClear();
    vi.mocked(logger.infoFile).mockClear();
    (axios as any).get.mockReset();
    vi.mocked(axios.post).mockReset();
    (axios as any).delete.mockReset();
    if (typeof originalDebugPush === 'string') {
      process.env.HAPPIER_DEBUG_PUSH = originalDebugPush;
    } else {
      delete process.env.HAPPIER_DEBUG_PUSH;
    }
  });

  it('reports no delivery without push tokens and permits the same Notify me request after device registration', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { tokens: [] } });
    const sender = new PushNotificationClient('account-token', 'https://owner-home.example.test');
    const params = {
      settings: accountSettingsParse({}),
      expoPushSender: sender,
      pluginNotifications: null,
      channels: ['builtin:expo_push'],
      event: { topic: 'notify_me' as const, message: 'Digest ready', actionRequestId: 'zero-token-retry' },
      nowMs: () => 50_000,
    };

    expect(await dispatchActivityNotificationAsync(params)).toEqual({ attemptedChannels: 1, deliveredChannels: 0 });
    expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();

    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { tokens: [{ id: 'device', token: 'ExponentPushToken[registered]' }] } })
      .mockResolvedValueOnce({ data: { badgeCount: 0 } });
    expect(await dispatchActivityNotificationAsync(params)).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sendPushNotificationsAsyncSpy.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[registered]', body: 'Digest ready' }),
    ]);
    expect(await dispatchActivityNotificationAsync(params)).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
  });

  it('does not dedupe Notify me after a push-token read failure', async () => {
    const params = {
      settings: accountSettingsParse({}),
      pluginNotifications: null,
      channels: ['builtin:expo_push'],
      event: { topic: 'notify_me' as const, message: 'Digest ready', actionRequestId: 'token-read-failure-retry' },
      nowMs: () => 50_000,
    };
    vi.mocked(axios.get).mockRejectedValueOnce(new Error('Home unavailable'));
    expect(await dispatchActivityNotificationAsync({ ...params,
      expoPushSender: new PushNotificationClient('account-token', 'https://owner-home.example.test'),
    })).toEqual({ attemptedChannels: 1, deliveredChannels: 0 });
    expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();

    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { tokens: [{ id: 'device', token: 'ExponentPushToken[registered]' }] } })
      .mockResolvedValueOnce({ data: { badgeCount: 0 } });
    expect(await dispatchActivityNotificationAsync({ ...params,
      expoPushSender: new PushNotificationClient('account-token', 'https://owner-home.example.test'),
    })).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['ready', 'ready_without_settings', 'permission', 'user_action'] as const)('honors current owner Follow suppression for rich %s notifications', async (kind) => {
    let notificationLevel: 'none' | null = 'none';
    let sessionReadFails = false;
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).includes('/v2/sessions/') && sessionReadFails) throw new Error('Session Home unavailable');
      if (String(url).includes('/v2/sessions/')) return { status: 200, data: { session: {
        ...createSessionNotificationContextFixture('s_1'),
        viewer: {
          readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
          attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
          follow: { follows: false, notificationLevel },
          notification: { level: notificationLevel ?? 'important', source: notificationLevel ? 'preference' : 'owner' },
        },
      } } };
      return { status: 200, data: { tokens: [{ id: '1', token: 'ExponentPushToken[a]' }] } };
    });
    const pushSender = new PushNotificationClient('account-token', 'https://owner-home.example.test');
    const settings = accountSettingsParse({});
    const send = async () => {
      if (kind === 'ready' || kind === 'ready_without_settings') {
        await sendReadyWithPushNotification({
          session: { sessionId: 's_1', enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true, localId: 'ready-1' }) },
          pushSender, waitingForCommandLabel: 'Agent', logPrefix: '[test]', accountSettings: kind === 'ready' ? settings : null,
        });
      } else {
        await sendAgentRequestPushNotificationAsync({ pushSender, settings, sessionId: 's_1',
          requestId: 'request-1', toolName: 'Write', kind });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    await send();
    expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();
    notificationLevel = null;
    await send();
    expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
    if (kind === 'ready' || kind === 'ready_without_settings') {
      expect(sendPushNotificationsAsyncSpy.mock.calls[0][0][0].data.activityEventLocalId).toBe('ready-1');
    }
    expect(axios.get).toHaveBeenCalledWith(
      'https://owner-home.example.test/v2/sessions/s_1?accessProjectionVersion=1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer account-token' }) }),
    );
    sessionReadFails = true;
    await expect(send()).resolves.toBeUndefined();
    expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
  });

  it('bounds the serialized outbound message while preserving Unicode and routing data', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [{ id: '1', token: 'ExponentPushToken[a]' }] } });
    const data = { sessionId: 's_1', requestId: 'p_1', kind: 'permission', tool: 'Bash' };
    const body = 'Run command: ' + '🧪漢字\n"'.repeat(1500);
    await new PushNotificationClient('t', 'https://api.example.test').sendToAllDevicesAsync('Permission', body, data);
    const message = sendPushNotificationsAsyncSpy.mock.calls[0][0][0];
    expect(Buffer.byteLength(JSON.stringify(message), 'utf8')).toBeLessThanOrEqual(4096);
    expect(message.body).toMatch(/^Run command: /);
    expect(message.body.endsWith('…')).toBe(true);
    expect(body.startsWith(message.body.slice(0, -1))).toBe(true);
    expect(message.body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(message.data).toEqual({ ...data, serverUrl: 'https://api.example.test' });
    expect(message.categoryId).toBe(PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1);
    expect(message.channelId).toBe(PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsV1);
  });

  it('bounds long titles and subtitles at the same outbound boundary', async () => {
    const client = new PushNotificationClient('t');
    await client.sendPushNotifications([{ to: 'ExponentPushToken[a]', title: '🧪'.repeat(2000), subtitle: '漢'.repeat(2000), body: 'Body', data: { sessionId: 's_1' } }]);
    const message = sendPushNotificationsAsyncSpy.mock.calls[0][0][0];
    expect(Buffer.byteLength(JSON.stringify(message), 'utf8')).toBeLessThanOrEqual(4096);
    expect(message.data).toEqual({ sessionId: 's_1' });
  });

  it('rejects oversized routing metadata without sending a corrupt route', async () => {
    const client = new PushNotificationClient('t');
    await expect(client.sendPushNotifications([{ to: 'ExponentPushToken[a]', body: 'Body', data: { sessionId: 's'.repeat(5000) } }])).rejects.toThrow(/4096/);
    expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();
  });

  it('still sends to valid recipients when another device has oversized routing metadata', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [
      { id: '1', token: 'ExponentPushToken[a]', clientServerUrl: 'https://api.example.test/' + 's'.repeat(5000) },
      { id: '2', token: 'ExponentPushToken[b]', clientServerUrl: 'https://api.example.test' },
    ] } });
    await new PushNotificationClient('t').sendToAllDevicesAsync('Title', 'Body', { sessionId: 's_1' });
    expect(sendPushNotificationsAsyncSpy.mock.calls[0][0]).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[b]', data: { sessionId: 's_1', serverUrl: 'https://api.example.test' } }),
    ]);
    expect(logger.infoFile).toHaveBeenCalledWith('[PUSH] Notification exceeds outbound payload budget; routing data was preserved');
  });

  it.each(['ticket', 'receipt'])('reports terminal MessageTooBig from a %s without retrying unchanged content', async (source) => {
    sendPushNotificationsAsyncSpy.mockResolvedValueOnce(source === 'ticket'
      ? [{ status: 'error', details: { error: 'MessageTooBig' } }]
      : [{ status: 'ok', id: 'oversize' }]);
    if (source === 'receipt') getPushNotificationReceiptsAsyncSpy.mockResolvedValueOnce({ oversize: { status: 'error', details: { error: 'MessageTooBig' } } });
    await new PushNotificationClient('t').sendPushNotifications([{ to: 'ExponentPushToken[a]', body: 'Body' }]);
    expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
    expect(logger.infoFile).toHaveBeenCalledWith('[PUSH] Expo rejected oversized notification payload', { count: 1 });
  });

  it.each(['ticket', 'receipt'])('reports invalid Expo credentials from a %s without retrying a permanent failure', async (source) => {
    vi.useFakeTimers();
    try {
      vi.mocked(axios.get).mockResolvedValueOnce({
        data: { tokens: [{ id: '1', token: 'ExponentPushToken[a]' }] },
      }).mockResolvedValueOnce({ data: { badgeCount: 0 } });
      sendPushNotificationsAsyncSpy.mockResolvedValueOnce(source === 'ticket'
        ? [{ status: 'error', details: { error: 'InvalidCredentials' } }]
        : [{ status: 'ok', id: 'credential-error' }]);
      if (source === 'receipt') {
        getPushNotificationReceiptsAsyncSpy.mockResolvedValueOnce({
          'credential-error': { status: 'error', details: { error: 'InvalidCredentials' } },
        });
      }
      const result = new PushNotificationClient('t').sendToAllDevicesAsync('Title', 'Body');
      const rejected = expect(result).rejects.toThrow(/InvalidCredentials/);

      await vi.advanceTimersByTimeAsync(300_000);

      await rejected;
      expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
      expect(logger.infoFile).toHaveBeenCalledWith(
        '[PUSH] Expo rejected push notification credentials',
        expect.objectContaining({ error: 'InvalidCredentials' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses token-specific clientServerUrl when present', async () => {
    (axios as any).get.mockResolvedValue({
      data: {
        tokens: [
          { id: '1', token: 'ExponentPushToken[a]', clientServerUrl: 'https://lan.example.test/' },
          { id: '2', token: 'ExponentPushToken[b]' },
        ],
      },
    });

    const client = new PushNotificationClient('t', 'http://localhost:3005');
    await client.sendToAllDevicesAsync('Title', 'Body', { sessionId: 's_1' });

    const [chunk] = sendPushNotificationsAsyncSpy.mock.calls[0] ?? [];
    expect(Array.isArray(chunk)).toBe(true);
    expect(chunk).toHaveLength(2);

    const [first, second] = chunk as any[];
    expect(first.data).toMatchObject({ serverUrl: 'https://lan.example.test' });
    expect(second.data).toMatchObject({ serverUrl: 'http://localhost:3005' });
  });

  it('sets categoryId for permission/user_action request pushes based on payload kind', async () => {
    (axios as any).get.mockResolvedValue({
      data: {
        tokens: [{
          id: '1',
          token: 'ExponentPushToken[a]',
          createdAt: Date.parse('2026-05-04T12:00:00.000Z'),
          updatedAt: Date.parse('2026-05-04T12:00:00.000Z'),
        }],
      },
    });

    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Title', 'Body', { sessionId: 's_1', requestId: 'p_1', kind: 'permission' });

    const [chunk] = sendPushNotificationsAsyncSpy.mock.calls.at(-1) ?? [];
    expect(Array.isArray(chunk)).toBe(true);
    expect(chunk).toHaveLength(1);
    expect((chunk as any[])[0]).toMatchObject({ categoryId: PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1 });
  });

  it('sets iOS subtitle and Android channelId for permission request pushes', async () => {
    (axios as any).get.mockResolvedValue({
      data: {
        tokens: [{
          id: '1',
          token: 'ExponentPushToken[a]',
          createdAt: Date.parse('2026-05-04T12:00:00.000Z'),
          updatedAt: Date.parse('2026-05-04T12:00:00.000Z'),
        }],
      },
    });

    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Title', 'Body', {
      sessionId: 's_1',
      requestId: 'p_1',
      kind: 'permission',
      tool: 'Bash',
    });

    const [chunk] = sendPushNotificationsAsyncSpy.mock.calls.at(-1) ?? [];
    expect(Array.isArray(chunk)).toBe(true);
    expect(chunk).toHaveLength(1);
    expect((chunk as any[])[0]).toMatchObject({
      subtitle: 'Bash',
      channelId: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsV1,
    });
  });

  it('uses sound-specific Android channels when a bundled sound id is provided', async () => {
    (axios as any).get.mockResolvedValue({
      data: {
        tokens: [{ id: '1', token: 'ExponentPushToken[a]' }],
      },
    });

    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Title', 'Body', {
      sessionId: 's_1',
      requestId: 'p_1',
      kind: 'permission',
    }, {
      sound: 'happier_urgent.wav',
      priority: 'high',
      androidSoundId: 'urgent',
    });

    const [chunk] = sendPushNotificationsAsyncSpy.mock.calls.at(-1) ?? [];
    expect(Array.isArray(chunk)).toBe(true);
    expect(chunk).toHaveLength(1);
    expect((chunk as any[])[0]).toMatchObject({
      sound: 'happier_urgent.wav',
      channelId: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsUrgentV1,
    });
  });

  it('applies explicit sound and priority options to outbound Expo messages', async () => {
    (axios as any).get.mockResolvedValue({
      data: {
        tokens: [{ id: '1', token: 'ExponentPushToken[a]' }],
      },
    });

    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Title', 'Body', { sessionId: 's_1' }, {
      sound: null,
      priority: 'normal',
    });

    const [chunk] = sendPushNotificationsAsyncSpy.mock.calls.at(-1) ?? [];
    expect(Array.isArray(chunk)).toBe(true);
    expect(chunk).toHaveLength(1);
    expect((chunk as any[])[0]).toMatchObject({ priority: 'normal' });
    expect((chunk as any[])[0]).not.toHaveProperty('sound');
  });

  it('does not log notification title or body when push debug logging is enabled', async () => {
    process.env.HAPPIER_DEBUG_PUSH = '1';
    (axios as any).get.mockResolvedValue({
      data: {
        tokens: [{
          id: '1',
          token: 'ExponentPushToken[a]',
          createdAt: Date.parse('2026-05-04T12:00:00.000Z'),
          updatedAt: Date.parse('2026-05-04T12:00:00.000Z'),
        }],
      },
    });

    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync(
      'Private launch title',
      'Body includes private-token',
      { sessionId: 's_1' },
    );

    const logged = JSON.stringify((logger.debug as any).mock.calls);
    expect(logged).not.toContain('Private launch title');
    expect(logged).not.toContain('private-token');
    expect(logger.debug).toHaveBeenCalledWith(
      '[PUSH] sendToAllDevicesAsync called',
      expect.objectContaining({
        titleLength: 'Private launch title'.length,
        bodyLength: 'Body includes private-token'.length,
      }),
    );
  });

  it('posts Live Activity remote updates to the selected server route', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: { success: true, deliveries: [] },
    } as never);
    const request = {
      v: 1,
      requestId: 'request-1',
      createdAt: 1_762_000_000_000,
      transportMode: 'direct_apns',
      event: 'update',
      activityKey: {
        serverId: 'server-a',
        sessionId: 'session-1',
        activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
      },
      snapshotFingerprint: 'snapshot-fingerprint-1',
      contentState: {
        version: 1,
        generatedAt: 1_762_000_000_000,
        staleAt: 1_762_001_800_000,
        sessionId: 'session-1',
        title: 'Review branch',
        subtitle: null,
        previewText: null,
        statusText: 'Ready',
        attentionState: 'unread',
        defaultTarget: 'open-inbox',
        sessionTarget: 'open-session:session-1?serverId=server-a',
        overflowCount: 0,
        totalAttentionCount: 1,
        allowActionButtons: true,
        labels: {
          title: 'Happier',
          openLabel: 'Open',
          inboxLabel: 'Inbox',
          attentionLabel: 'Attention',
        },
      },
    } satisfies LiveActivityRemoteUpdateRequestV1;

    const client = new PushNotificationClient('t', 'https://api.example.test', 'server-a');
    expect(typeof client.sendLiveActivityRemoteUpdateAsync).toBe('function');
    await client.sendLiveActivityRemoteUpdateAsync(request);

    expect(vi.mocked(axios.post)).toHaveBeenCalledWith(
      'https://api.example.test/v1/live-activity-remote-updates',
      request,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('sanitizes iOS subtitle for notification pushes', async () => {
    (axios as any).get.mockResolvedValue({
      data: {
        tokens: [{ id: '1', token: 'ExponentPushToken[a]' }],
      },
    });

    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Title', 'Body', {
      sessionId: 's_1',
      requestId: 'p_1',
      kind: 'permission',
      tool: 'Bash\nrm -rf /\t\t',
    });

    const [chunk] = sendPushNotificationsAsyncSpy.mock.calls.at(-1) ?? [];
    expect(Array.isArray(chunk)).toBe(true);
    expect(chunk).toHaveLength(1);
    expect((chunk as any[])[0]).toMatchObject({
      subtitle: 'Bash rm -rf /',
    });
  });

  it('applies the server badge snapshot count to outbound Expo messages', async () => {
    (axios as any).get
      .mockResolvedValueOnce({
        data: {
          tokens: [{ id: '1', token: 'ExponentPushToken[a]' }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          badgeCount: 4,
        },
      });

    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Title', 'Body', { sessionId: 's_1' });

    const [chunk] = sendPushNotificationsAsyncSpy.mock.calls.at(-1) ?? [];
    expect(Array.isArray(chunk)).toBe(true);
    expect(chunk).toHaveLength(1);
    expect((chunk as any[])[0]).toMatchObject({
      badge: 4,
    });
    expect((axios as any).get).toHaveBeenNthCalledWith(2,
      'https://api.example.test/v1/account/activity/badge-snapshot',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer t',
        }),
      }),
    );
  });

  it('still sends push notifications when fetching the badge snapshot fails', async () => {
    (axios as any).get
      .mockResolvedValueOnce({
        data: {
          tokens: [{ id: '1', token: 'ExponentPushToken[a]' }],
        },
      })
      .mockRejectedValueOnce(new Error('badge snapshot unavailable'));

    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Title', 'Body', { sessionId: 's_1' });

    const [chunk] = sendPushNotificationsAsyncSpy.mock.calls.at(-1) ?? [];
    expect(Array.isArray(chunk)).toBe(true);
    expect(chunk).toHaveLength(1);
    expect((chunk as any[])[0].badge).toBeUndefined();
  });

  it('deletes push tokens that Expo marks as DeviceNotRegistered', async () => {
    (axios as any).get
      .mockResolvedValueOnce({
        data: {
          tokens: [{ id: '1', token: 'ExponentPushToken[dead-token]' }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          badgeCount: 2,
        },
      });
    const deviceNotRegisteredTickets = [
      {
        status: 'error',
        details: { error: 'DeviceNotRegistered' },
      },
    ] satisfies Array<{ status: string; details?: { error?: string } }>;
    sendPushNotificationsAsyncSpy.mockResolvedValueOnce(deviceNotRegisteredTickets);

    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Title', 'Body', { sessionId: 's_1' });

    expect((axios as any).delete).toHaveBeenCalledWith(
      'https://api.example.test/v1/push-tokens/ExponentPushToken%5Bdead-token%5D',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer t',
        }),
      }),
    );
    expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry DeviceNotRegistered targets when retrying mixed terminal and transient failures', async () => {
    (axios as any).get
      .mockResolvedValueOnce({
        data: {
          tokens: [
            { id: '1', token: 'ExponentPushToken[dead-token]' },
            { id: '2', token: 'ExponentPushToken[live-token]' },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          badgeCount: 2,
        },
      });

    sendPushNotificationsAsyncSpy
      .mockResolvedValueOnce([
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', details: { error: 'MessageRateExceeded' } },
      ])
      .mockResolvedValueOnce([
        { status: 'ok', id: 'receipt-live' },
      ]);

    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Title', 'Body', { sessionId: 's_1' });

    expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(2);
    expect(sendPushNotificationsAsyncSpy.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[dead-token]' }),
      expect.objectContaining({ to: 'ExponentPushToken[live-token]' }),
    ]);
    expect(sendPushNotificationsAsyncSpy.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[live-token]' }),
    ]);
    expect((axios as any).delete).toHaveBeenCalledWith(
      'https://api.example.test/v1/push-tokens/ExponentPushToken%5Bdead-token%5D',
      expect.any(Object),
    );
  });

  it('does not log raw Expo push tokens when cleanup deletion fails', async () => {
    (axios as any).get
      .mockResolvedValueOnce({
        data: {
          tokens: [{ id: '1', token: 'ExponentPushToken[dead-token]' }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          badgeCount: 1,
        },
      });
    sendPushNotificationsAsyncSpy.mockResolvedValueOnce([
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ]);
    (axios as any).delete.mockRejectedValueOnce(new Error('delete failed'));

    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Title', 'Body', { sessionId: 's_1' });

    expect(logger.debug).toHaveBeenCalledWith(
      '[PUSH] Failed to delete invalid push token:',
      expect.not.objectContaining({
        token: 'ExponentPushToken[dead-token]',
      }),
    );
  });
});
