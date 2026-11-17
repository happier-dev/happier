import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
} from '@happier-dev/protocol';
import { notificationSettingsFixture as accountSettingsParse, notificationCatalogFixture } from '@/notifications/activity/activityNotification.testkit';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

type MockExpoPushTicket = Readonly<{
  status: string;
  id?: string;
  details?: Readonly<{ error?: string }>;
}>;

const sendPushNotificationsAsyncSpy = vi.fn(async (_chunk: any[]): Promise<MockExpoPushTicket[]> =>
  _chunk.map((_, index): MockExpoPushTicket => ({ status: 'ok', id: `receipt-${index}` })),
);
const getPushNotificationReceiptsAsyncSpy = vi.fn(async (_ids: string[]) => ({}));

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
    vi.spyOn(axios, 'get').mockImplementation(vi.fn());
    vi.spyOn(axios, 'post').mockImplementation(vi.fn());
    vi.spyOn(axios, 'delete').mockImplementation(vi.fn());
    resetActiveAccountSettingsSnapshotForTests();
    sendPushNotificationsAsyncSpy.mockClear();
    getPushNotificationReceiptsAsyncSpy.mockClear();
    (logger.debug as any).mockClear();
    vi.mocked(logger.infoFile).mockClear();
    if (typeof originalDebugPush === 'string') {
      process.env.HAPPIER_DEBUG_PUSH = originalDebugPush;
    } else {
      delete process.env.HAPPIER_DEBUG_PUSH;
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('reports partial push acceptance without inventing complete success', async () => {
    sendPushNotificationsAsyncSpy.mockResolvedValueOnce([{ status: 'ok', id: 'accepted' }, { status: 'error', details: { error: 'MessageTooBig' } }]);
    expect(await new PushNotificationClient('t').sendPushNotifications([
      { to: 'ExponentPushToken[a]', body: 'Test' }, { to: 'ExponentPushToken[b]', body: 'Test' },
    ])).toMatchObject({ acceptedCount: 1, failedCount: 1 });
    expect(logger.infoFile).toHaveBeenCalledWith('[PUSH] Push service did not confirm acceptance for every recipient', { acceptedCount: 1, failedCount: 1 });
  });

  it('binds outgoing request metadata to the authenticated Account rather than caller data', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [{ id: 'phone', token: 'ExponentPushToken[a]' }] } });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
    await new PushNotificationClient(token).sendToAllDevicesAsync('Question', 'Your input is needed', { kind: 'user_action', accountId: 'spoofed' });
    expect(sendPushNotificationsAsyncSpy.mock.calls[0][0][0].data).toMatchObject({ accountId: 'account-a' });
  });

  it.each([
    [{ kind: 'choices', questionKey: 'pick', values: ['a'] }, 'happier.questionChoices1.v1'],
    [{ kind: 'choices', questionKey: 'pick', values: ['a', 'b'] }, 'happier.questionChoices2.v1'],
    [{ kind: 'choices', questionKey: 'pick', values: ['a', 'b', 'c'] }, 'happier.questionChoices3.v1'],
    [{ kind: 'text', questionKey: 'reply', allowEmpty: false }, 'happier.questionText.v1'],
  ])('selects the native question category at the remote Expo boundary: %s', async (questionAnswerV1, categoryId) => {
    vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [{ id: 'phone', token: 'ExponentPushToken[a]' }] } });
    await new PushNotificationClient('t').sendToAllDevicesAsync('Question', 'Your input is needed', {
      kind: 'user_action', sessionId: 'session', requestId: 'request', turnId: 'turn-a', questionAnswerV1,
    });
    expect(sendPushNotificationsAsyncSpy.mock.calls[0][0][0]).toMatchObject({ categoryId, data: { questionAnswerV1, turnId: 'turn-a' } });
  });

  it('qualifies an external plugin category without borrowing permission actions', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { tokens: [{ id: 'device', token: 'ExponentPushToken[plugin]' }] } })
      .mockResolvedValueOnce({ data: { badgeCount: 0 } });
    const sender = new PushNotificationClient('account-token', 'https://home.example.test');
    await sender.sendToAllDevicesAsync('Review', '', { v: 1, topic: 'plugin_session', accountId: 'owner',
      sessionId: 'session-bound', serverId: 'srv_home', serverUrl: 'https://home.example.test',
      pluginNotification: { pluginId: 'acme.tasks', categoryId: 'review', occurrenceId: 'current', clientRequestId: 'send-one' } });
    expect(sendPushNotificationsAsyncSpy.mock.calls[0]?.[0]?.[0]).toMatchObject({
      categoryId: 'happier.pluginNotification.v1/acme.tasks/review',
    });
  });

  it('keeps the public Home address separate from its private HTTP transport', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { tokens: [{ id: 'device', token: 'ExponentPushToken[bound-home]' }] } })
      .mockResolvedValueOnce({ data: { badgeCount: 0 } });
    const sender = new PushNotificationClient('account-token', 'http://127.0.0.1:43123', 'srv_home', 'https://home.example.test');
    await sender.sendToAllDevicesAsync('Review', 'Open review', { topic: 'account_notice' });
    expect(vi.mocked(axios.get).mock.calls[0]?.[0]).toBe('http://127.0.0.1:43123/v1/push-tokens');
    expect(sendPushNotificationsAsyncSpy.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ categoryId: undefined, data: { topic: 'account_notice', serverUrl: 'https://home.example.test' } }),
    ]);
  });

  it('delivers a guard warning with its actionable category and content-free occurrence identity', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { tokens: [{ id: 'device', token: 'ExponentPushToken[guard]' }] } })
      .mockResolvedValueOnce({ data: { badgeCount: 0 } });
    const sender = new PushNotificationClient('account-token', 'https://owner-home.example.test');
    await sender.sendToAllDevicesAsync('Session will stop soon', 'Keep it running to continue.', {
      topic: 'guard_stop_warning', machineId: 'machine-1', sessionId: 'session-1', stopAt: 300_000,
      rule: 'memory_guard', notificationId: 'guard-stop:session-1:300000',
    });
    expect(sendPushNotificationsAsyncSpy.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ categoryId: PUSH_NOTIFICATION_CATEGORY_IDS.guardStopWarningV1,
        data: expect.objectContaining({ notificationId: 'guard-stop:session-1:300000', topic: 'guard_stop_warning' }) }),
    ]);
  });

  it('reports no delivery with an unbound sender or no tokens and permits the same Notify me request after repair', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { tokens: [] } });
    const sender = new PushNotificationClient('account-token', 'https://owner-home.example.test');
    const settings = accountSettingsParse({});
    const params = {
      settings,
      ...notificationCatalogFixture(settings),
      expoPushSender: sender,
      pluginNotifications: null,
      channels: ['builtin:expo_push'],
      event: { topic: 'notify_me' as const, message: 'Digest ready', actionRequestId: 'zero-token-retry' },
      nowMs: () => 50_000,
    };

    expect(await dispatchActivityNotificationAsync({ ...params, expoPushSender: null }))
      .toEqual({ attemptedChannels: 1, deliveredChannels: 0 });
    expect(axios.get).not.toHaveBeenCalled();
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
    const settings = accountSettingsParse({});
    const params = {
      settings,
      ...notificationCatalogFixture(settings),
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

  it.each(['ticket', 'receipt', 'retry_exhaustion', 'transport_exhaustion'] as const)(
    'does not deliver or dedupe Notify me after zero accepted deliveries (%s)', async (failure) => {
      vi.useFakeTimers();
      try {
        vi.mocked(axios.get).mockImplementation(async (url) => ({ data: String(url).includes('/push-tokens')
          ? { tokens: [{ id: 'device', token: 'ExponentPushToken[retry]' }] }
          : { badgeCount: 0 } }));
        if (failure === 'transport_exhaustion') {
          sendPushNotificationsAsyncSpy.mockRejectedValue(new Error('Expo unavailable'));
        } else if (failure === 'retry_exhaustion') {
          sendPushNotificationsAsyncSpy.mockResolvedValue([{ status: 'error', details: { error: 'MessageRateExceeded' } }]);
        } else {
          sendPushNotificationsAsyncSpy.mockResolvedValueOnce(failure === 'ticket'
            ? [{ status: 'error', details: { error: 'DeviceNotRegistered' } }]
            : [{ status: 'ok', id: 'rejected-receipt' }]);
          if (failure === 'receipt') getPushNotificationReceiptsAsyncSpy.mockResolvedValueOnce({
            'rejected-receipt': { status: 'error', details: { error: 'DeviceNotRegistered' } },
          });
        }
        const settings = accountSettingsParse({});
        const params = { settings, ...notificationCatalogFixture(settings),
          expoPushSender: new PushNotificationClient('account-token', 'https://owner-home.example.test'),
          pluginNotifications: null, channels: ['builtin:expo_push'],
          event: { topic: 'notify_me' as const, message: 'Digest ready', actionRequestId: `zero-accepted-${failure}` },
          nowMs: () => 50_000 };
        const rejected = dispatchActivityNotificationAsync(params);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(await rejected).toEqual({ attemptedChannels: 1, deliveredChannels: 0 });
        const failedAttempts = sendPushNotificationsAsyncSpy.mock.calls.length;
        if (failure === 'ticket' || failure === 'receipt') {
          expect(failedAttempts).toBe(1);
          expect(vi.mocked(axios.delete)).toHaveBeenCalledTimes(1);
        }

        sendPushNotificationsAsyncSpy.mockResolvedValue([{ status: 'ok', id: 'accepted-retry' }]);
        expect(await dispatchActivityNotificationAsync(params)).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
        expect(await dispatchActivityNotificationAsync(params)).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
        expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(failedAttempts + 1);
      } finally {
        sendPushNotificationsAsyncSpy.mockReset().mockImplementation(async (chunk) =>
          chunk.map((_, index) => ({ status: 'ok', id: `receipt-${index}` })));
        vi.useRealTimers();
      }
    },
  );

  it.each(['DeviceNotRegistered', 'InvalidCredentials'])('counts mixed accepted and %s tickets as a successful Notify me delivery', async (error) => {
    vi.mocked(axios.get).mockImplementation(async (url) => ({ data: String(url).includes('/push-tokens')
      ? { tokens: [{ id: 'dead', token: 'ExponentPushToken[dead]' }, { id: 'live', token: 'ExponentPushToken[live]' }] }
      : { badgeCount: 0 } }));
    sendPushNotificationsAsyncSpy.mockResolvedValueOnce([
      { status: 'error', details: { error } }, { status: 'ok', id: 'accepted-mixed' },
    ]);
    const settings = accountSettingsParse({});
    const params = { settings, ...notificationCatalogFixture(settings),
      expoPushSender: new PushNotificationClient('account-token', 'https://owner-home.example.test'),
      pluginNotifications: null, channels: ['builtin:expo_push'],
      event: { topic: 'notify_me' as const, message: 'Digest ready', actionRequestId: `mixed-accepted-${error}` },
      nowMs: () => 50_000 };
    expect(await dispatchActivityNotificationAsync(params)).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(await dispatchActivityNotificationAsync(params)).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
    expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['ready', 'ready_without_settings', 'permission', 'user_action'] as const)('honors current owner Follow suppression for rich %s notifications', async (kind) => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'push-fixture-account' })).toString('base64url')}.signature`;
    let notificationLevel: 'none' | null = 'none';
    let includeFinished = false;
    let sessionReadFails = false;
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/v2/account/session-delivery-mutes')) return { status: 200, data: { scopes: [] } };
      if (String(url).includes('/v2/sessions/') && sessionReadFails) throw new Error('Session Home unavailable');
      if (String(url).includes('/v2/sessions/')) return { status: 200, data: { session: {
        ...createSessionNotificationContextFixture('s_1'),
        viewer: {
          latestFailureSeq: null,
          readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
          attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
          follow: { follows: false, notificationLevel, ...(includeFinished ? { policy: { preset: 'everything' } } : {}) },
          notification: { level: includeFinished ? 'all_messages' : notificationLevel ?? 'important',
            source: includeFinished || notificationLevel ? 'preference' : 'owner' },
        },
      } } };
      return { status: 200, data: { tokens: [{ id: '1', token: 'ExponentPushToken[a]' }] } };
    });
    const pushSender = new PushNotificationClient(token, 'https://owner-home.example.test');
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey({ token, encryption: null }), settings,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      notificationChannelCatalog: notificationCatalogFixture(settings).notificationChannelCatalog });
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
    if (kind === 'ready' || kind === 'ready_without_settings') {
      // C1 Important keeps finished events quiet; Everything selects their push.
      expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();
      includeFinished = true;
      await send();
    }
    expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
    if (kind === 'ready' || kind === 'ready_without_settings') {
      expect(sendPushNotificationsAsyncSpy.mock.calls[0][0][0].data.activityEventLocalId).toBe('ready-1');
    }
    expect(axios.get).toHaveBeenCalledWith(
      'https://owner-home.example.test/v2/sessions/s_1?accessProjectionVersion=1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${token}` }) }),
    );
    sessionReadFails = true;
    await expect(send()).resolves.toBeUndefined();
    expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
  });

  it('removes the entire inline question mapping before bounding an oversized native message', async () => {
    await new PushNotificationClient('t').sendPushNotifications([{
      to: 'ExponentPushToken[a]', body: 'Which branch?\n1. Main\n2. ' + 'Long label'.repeat(600),
      categoryId: 'happier.questionChoices2.v1',
      data: { sessionId: 'session-1', requestId: 'question-1', turnId: 'turn-1',
        questionAnswerV1: { kind: 'choices', questionKey: 'branch', values: ['main', 'release'] } },
    }]);
    const message = sendPushNotificationsAsyncSpy.mock.calls[0][0][0];
    expect(message.categoryId).toBe(PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1);
    expect(message.data).toEqual({ sessionId: 'session-1', requestId: 'question-1', turnId: 'turn-1' });
    expect(Buffer.byteLength(JSON.stringify(message), 'utf8')).toBeLessThanOrEqual(4096);
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
