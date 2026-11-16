import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { runInHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';

import { PushNotificationClient } from './pushNotifications';
import { readAccountSessionDeliveryMutedScopes } from './sessionDeliveryMuteTransport';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { notificationCatalogFixture, notificationSettingsFixture } from '@/notifications/activity/activityNotification.testkit';

vi.mock('axios', () => {
  const isAxiosError = (err: any) => Boolean(err?.isAxiosError);
  return {
    __esModule: true,
    // The credential request scope reads the client's defaults and request URI (credentialAxios.ts).
    default: { get: vi.fn(), isAxiosError, defaults: {}, getUri: (config?: { url?: string }) => config?.url ?? '' },
    isAxiosError,
  };
});

describe('PushNotificationClient.fetchPushTokens', () => {
  it('retains each Session timeout and failure cooldown when invoked outside its scope', async () => {
    vi.useFakeTimers();
    const clients = await Promise.all(['0', '500'].map((cooldown, index) => runInHostedSessionScope({ environment: {
      NODE_ENV: 'test',
      HAPPIER_PUSH_FETCH_TOKENS_TIMEOUT_MS: String(1200 + index),
      HAPPIER_PUSH_FETCH_TOKENS_FAILURE_COOLDOWN_MS: cooldown,
    } }, async () => {
      await Promise.resolve();
      return new PushNotificationClient('t', `https://session-${index}.example.test`);
    })));
    vi.mocked(axios.get).mockRejectedValue(new Error('unavailable'));
    await Promise.all(clients.map(client => expect(client.fetchPushTokens()).rejects.toThrow('unavailable')));
    expect(vi.mocked(axios.get).mock.calls.map(([, config]) => config?.timeout)).toEqual([1200, 1201]);
    vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [] } });
    await expect(clients[0].fetchPushTokens()).resolves.toEqual([]);
    await expect(clients[1].fetchPushTokens()).rejects.toThrow('cooldown');
    await vi.advanceTimersByTimeAsync(500);
    await expect(clients[1].fetchPushTokens()).resolves.toEqual([]);
  });
  beforeEach(() => {
    vi.useRealTimers();
    (axios as any).get.mockReset();
    delete process.env.HAPPIER_PUSH_FETCH_TOKENS_TIMEOUT_MS;
    delete process.env.HAPPIER_PUSH_FETCH_TOKENS_FAILURE_COOLDOWN_MS;
  });

  it('passes a timeout (default) to axios.get', async () => {
    (axios as any).get.mockResolvedValue({ data: { tokens: [] } });
    const client = new PushNotificationClient('t', 'https://api.example.test');

    await client.fetchPushTokens();

    expect((axios as any).get).toHaveBeenCalledWith(
      'https://api.example.test/v1/push-tokens',
      expect.objectContaining({
        timeout: 15_000,
      }),
    );
  });

  it('supports overriding the timeout via env', async () => {
    process.env.HAPPIER_PUSH_FETCH_TOKENS_TIMEOUT_MS = '1234';

    (axios as any).get.mockResolvedValue({ data: { tokens: [] } });
    const client = new PushNotificationClient('t', 'https://api.example.test');

    await client.fetchPushTokens();

    expect((axios as any).get).toHaveBeenCalledWith(
      'https://api.example.test/v1/push-tokens',
      expect.objectContaining({
        timeout: 1234,
      }),
    );
  });

  it('short-circuits repeated fetch failures during the cooldown window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-07T00:00:00.000Z'));
    process.env.HAPPIER_PUSH_FETCH_TOKENS_FAILURE_COOLDOWN_MS = '1000';

    (axios as any).get.mockRejectedValueOnce({
      isAxiosError: true,
      message: 'server failed',
      config: { url: 'https://api.example.test/v1/push-tokens', method: 'get' },
      response: { status: 500 },
    });

    const client = new PushNotificationClient('t', 'https://api.example.test');

    await expect(client.fetchPushTokens()).rejects.toThrow('Failed to fetch push tokens: server failed');
    await expect(client.fetchPushTokens()).rejects.toThrow('Push token registration lookup unavailable during failure cooldown');

    expect((axios as any).get).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    (axios as any).get.mockResolvedValueOnce({ data: { tokens: [] } });

    await expect(client.fetchPushTokens()).resolves.toEqual([]);

    expect((axios as any).get).toHaveBeenCalledTimes(2);
  });
});

describe('focused computer push filtering', () => {
  it.each([true, false])('carries the Account focus opt-in only with bound delivery admission (bound=%s)', async (bound) => {
    vi.mocked(axios.get).mockReset();
    vi.mocked(axios.get).mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/sessions/focus-session') {
        const session = createSessionNotificationContextFixture('focus-session');
        // Completion must opt into interrupt delivery before computer focus can filter it.
        return { status: 200, data: { session: { ...session, viewer: { ...session.viewer!,
          follow: { ...session.viewer!.follow, policy: { preset: 'everything' as const } },
        } } } };
      }
      if (path === '/v2/account/session-delivery-mutes') {
        return { status: 200, data: { scopes: [] } };
      }
      if (path === '/v1/push-tokens') {
        return { status: 200, data: { tokens: [], suppressedByFocusedComputer: true } };
      }
      throw new Error(`Unexpected notification HTTP path: ${path}`);
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'focus-account' })).toString('base64url')}.signature`;
    const client = new PushNotificationClient(token, 'https://api.example.test');
    const settings = notificationSettingsFixture({
      attentionDeliveryPolicyV1: { mutePhoneWhenComputerFocused: true },
      notificationChannelsV1: [{ id: 'phone-push', kind: 'expo_push', enabled: true }],
    });
    const result = await dispatchActivityNotificationAsync({
      settings,
      ...notificationCatalogFixture(settings),
      pluginNotifications: null,
      expoPushSender: client,
      fetchSessionNotificationContext: client.fetchSessionNotificationContext.bind(client),
      ...(bound ? { readAccountSessionDeliveryMutedScopes: () => readAccountSessionDeliveryMutedScopes({
        serverHttpBaseUrl: 'https://api.example.test', accountId: 'focus-account', token,
      }) } : {}),
      event: { topic: 'ready', sessionId: 'focus-session', waitingForCommandLabel: 'Agent' },
    });
    expect(result).toEqual({ attemptedChannels: bound ? 1 : 0, deliveredChannels: 0 });
    if (bound) {
      expect(axios.get).toHaveBeenCalledWith(
        'https://api.example.test/v2/account/session-delivery-mutes', expect.anything(),
      );
      expect(axios.get).toHaveBeenCalledWith(
        'https://api.example.test/v1/push-tokens?suppressIfComputerFocused=1', expect.anything(),
      );
    } else {
      expect(axios.get).not.toHaveBeenCalledWith(
        expect.stringContaining('/v1/push-tokens'), expect.anything(),
      );
    }
  });
  it('requests fresh focus filtering only for opted-in deliveries', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [] } });
    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Ready', 'Ready', undefined, { suppressIfComputerFocused: true });
    expect(axios.get).toHaveBeenLastCalledWith('https://api.example.test/v1/push-tokens?suppressIfComputerFocused=1', expect.anything());
    await client.fetchPushTokens();
    expect(axios.get).toHaveBeenLastCalledWith('https://api.example.test/v1/push-tokens', expect.anything());
  });
});
