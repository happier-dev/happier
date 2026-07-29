import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { logger } from '@/ui/logger';
import { PushNotificationClient } from './pushNotifications';
import {
  HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
  PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS,
  PUSH_NOTIFICATION_CATEGORY_IDS,
  type LiveActivityRemoteUpdateRequestV1,
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
    (axios as any).get.mockReset();
    vi.mocked(axios.post).mockReset();
    (axios as any).delete.mockReset();
    if (typeof originalDebugPush === 'string') {
      process.env.HAPPIER_DEBUG_PUSH = originalDebugPush;
    } else {
      delete process.env.HAPPIER_DEBUG_PUSH;
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
        headers: {
          Authorization: 'Bearer t',
        },
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
