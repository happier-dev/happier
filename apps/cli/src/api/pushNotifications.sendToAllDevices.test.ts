import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { logger } from '@/ui/logger';
import { PushNotificationClient } from './pushNotifications';
import { PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS, PUSH_NOTIFICATION_CATEGORY_IDS } from '@happier-dev/protocol';

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
    default: { get: vi.fn(), delete: vi.fn(), isAxiosError: (err: any) => Boolean(err?.isAxiosError) },
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
  beforeEach(() => {
    sendPushNotificationsAsyncSpy.mockClear();
    getPushNotificationReceiptsAsyncSpy.mockClear();
    (logger.debug as any).mockClear();
    vi.mocked(logger.infoFile).mockClear();
    (axios as any).get.mockReset();
    (axios as any).delete.mockReset();
  });

  it('reports service acceptance separately from rejected recipients', async () => {
    sendPushNotificationsAsyncSpy.mockResolvedValueOnce([
      { status: 'ok', id: 'accepted' },
      { status: 'error', details: { error: 'MessageTooBig' } },
    ]);
    const result = await new PushNotificationClient('t').sendPushNotifications([
      { to: 'ExponentPushToken[a]', body: 'Test' },
      { to: 'ExponentPushToken[b]', body: 'Test' },
    ]);
    expect(result).toMatchObject({ acceptedCount: 1, failedCount: 1 });
  });

  it('rejects an ordinary broadcast when the service accepted no recipients', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [{ id: 'phone', token: 'ExponentPushToken[a]' }] } });
    sendPushNotificationsAsyncSpy.mockResolvedValueOnce([{ status: 'error', details: { error: 'MessageTooBig' } }]);
    await expect(new PushNotificationClient('t').sendToAllDevicesAsync('Title', 'Body')).rejects.toThrow('Push service did not accept any recipients');
  });

  it('keeps partial broadcast success observable without triggering an automatic broadcast retry', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [
      { id: 'a', token: 'ExponentPushToken[a]' }, { id: 'b', token: 'ExponentPushToken[b]' },
    ] } });
    sendPushNotificationsAsyncSpy.mockResolvedValueOnce([{ status: 'ok' }, { status: 'error', details: { error: 'MessageTooBig' } }]);
    await expect(new PushNotificationClient('t').sendToAllDevicesAsync('Title', 'Body')).resolves.toBeUndefined();
    expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
    expect(logger.infoFile).toHaveBeenCalledWith('[PUSH] Push service did not accept every recipient', { acceptedCount: 1, failedCount: 1 });
  });

  it('reports exhausted network retries as failure, never service acceptance', async () => {
    vi.useFakeTimers();
    try {
      sendPushNotificationsAsyncSpy.mockRejectedValue(new Error('Network unavailable'));
      const pending = new PushNotificationClient('t').sendPushNotifications([{ to: 'ExponentPushToken[a]', body: 'Test' }]);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(await pending).toMatchObject({ acceptedCount: 0, failedCount: 1 });
    } finally {
      sendPushNotificationsAsyncSpy.mockImplementation(async (chunk) => chunk.map(() => ({ status: 'ok' })));
      vi.useRealTimers();
    }
  });

  it('sends the diagnostic only to the selected token registered to this Account', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { tokens: [
      { id: 'phone-a', token: 'ExponentPushToken[a]', clientServerUrl: 'https://home-a.test' },
      { id: 'phone-b', token: 'ExponentPushToken[b]' },
    ] } });
    const result = await new PushNotificationClient('account-a', 'https://relay-a.test').sendTestNotificationAsync('phone-a');
    expect(result).toEqual({ status: 'accepted' });
    expect(sendPushNotificationsAsyncSpy.mock.calls[0][0]).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[a]', data: { url: '/settings/notifications', serverUrl: 'https://home-a.test' } }),
    ]);
    expect(axios.get).toHaveBeenCalledWith('https://relay-a.test/v1/push-tokens', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer account-a' }) }));
  });

  it('never broadcasts a diagnostic when the selected registration is missing', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { tokens: [{ id: 'other-phone', token: 'ExponentPushToken[b]' }] } });
    expect(await new PushNotificationClient('t').sendTestNotificationAsync('missing')).toEqual({ status: 'not_registered' });
    expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();
  });

  it('binds remote request notifications to the authenticated Account rather than caller metadata', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [{ id: 'phone', token: 'ExponentPushToken[a]' }] } });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
    await new PushNotificationClient(token).sendToAllDevicesAsync('Question', 'Answer in Happier', { kind: 'user_action', accountId: 'spoofed-account' });
    expect(sendPushNotificationsAsyncSpy.mock.calls[0][0][0].data).toMatchObject({ accountId: 'account-a' });
  });

  it.each([
    [{ kind: 'choices', questionKey: 'pick', values: ['a'] }, PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices1V1],
    [{ kind: 'choices', questionKey: 'pick', values: ['a', 'b'] }, PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices2V1],
    [{ kind: 'choices', questionKey: 'pick', values: ['a', 'b', 'c'] }, PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices3V1],
    [{ kind: 'text', questionKey: 'reply', allowEmpty: false }, PUSH_NOTIFICATION_CATEGORY_IDS.questionTextV1],
  ])('selects the actionable question category at the actual remote sender boundary: %s', async (questionAnswerV1, categoryId) => {
    vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [{ id: 'phone', token: 'ExponentPushToken[a]' }] } });
    await new PushNotificationClient('t').sendToAllDevicesAsync('Question', 'Your input is needed', {
      kind: 'user_action', sessionId: 'session', requestId: 'request', occurrenceId: 'occurrence', questionAnswerV1,
    });
    expect(sendPushNotificationsAsyncSpy.mock.calls[0][0][0]).toMatchObject({ categoryId, data: { questionAnswerV1, occurrenceId: 'occurrence' } });
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
    await expect(client.sendToAllDevicesAsync('Title', 'Body', { sessionId: 's_1' })).rejects.toThrow('Push service did not accept any recipients');

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
    await expect(client.sendToAllDevicesAsync('Title', 'Body', { sessionId: 's_1' })).rejects.toThrow('Push service did not accept any recipients');

    expect(logger.debug).toHaveBeenCalledWith(
      '[PUSH] Failed to delete invalid push token:',
      expect.not.objectContaining({
        token: 'ExponentPushToken[dead-token]',
      }),
    );
  });
});


describe('focused computer push token query', () => {
  it('asks freshly for suppression and resumes on the next delivery after blur', async () => {
    sendPushNotificationsAsyncSpy.mockClear();
    vi.mocked(axios.get).mockReset();
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { tokens: [], suppressedByFocusedComputer: true } });
    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Ready', 'Done', { sessionId: 's' }, { suppressIfComputerFocused: true });
    expect(vi.mocked(axios.get).mock.calls[0][0]).toBe('https://api.example.test/v1/push-tokens?suppressIfComputerFocused=1');
    expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { tokens: [{ id: '1', token: 'ExponentPushToken[a]' }] } }).mockResolvedValueOnce({ data: { badgeCount: 0 } });
    await client.sendToAllDevicesAsync('Ready', 'Done', { sessionId: 's' }, { suppressIfComputerFocused: true });
    expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
  });
});
