import { describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { PushNotificationClient } from './pushNotifications';
import { PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS, PUSH_NOTIFICATION_CATEGORY_IDS } from '@happier-dev/protocol';

const sendPushNotificationsAsyncSpy = vi.fn(async (_chunk: any[]) =>
  _chunk.map(() => ({ status: 'ok' })),
);

vi.mock('axios', () => {
  return {
    __esModule: true,
    default: { get: vi.fn(), isAxiosError: (err: any) => Boolean(err?.isAxiosError) },
  };
});

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
  }

  return {
    __esModule: true,
    Expo,
  };
});

describe('PushNotificationClient.sendToAllDevicesAsync', () => {
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
        tokens: [{ id: '1', token: 'ExponentPushToken[a]' }],
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
        tokens: [{ id: '1', token: 'ExponentPushToken[a]' }],
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
});
