import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { PushNotificationClient } from './pushNotifications';

vi.mock('axios', () => {
  const isAxiosError = (err: any) => Boolean(err?.isAxiosError);
  return {
    __esModule: true,
    default: { get: vi.fn(), isAxiosError },
    isAxiosError,
  };
});

describe('PushNotificationClient.fetchPushTokens', () => {
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
    await expect(client.fetchPushTokens()).resolves.toEqual([]);

    expect((axios as any).get).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    (axios as any).get.mockResolvedValueOnce({ data: { tokens: [] } });

    await expect(client.fetchPushTokens()).resolves.toEqual([]);

    expect((axios as any).get).toHaveBeenCalledTimes(2);
  });
});
