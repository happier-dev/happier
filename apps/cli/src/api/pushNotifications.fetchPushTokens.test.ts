import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { PushNotificationClient } from './pushNotifications';

vi.mock('axios', () => {
  return {
    __esModule: true,
    default: { get: vi.fn() },
    isAxiosError: (err: any) => Boolean(err?.isAxiosError),
  };
});

describe('PushNotificationClient.fetchPushTokens', () => {
  beforeEach(() => {
    (axios as any).get.mockReset();
    delete process.env.HAPPIER_PUSH_FETCH_TOKENS_TIMEOUT_MS;
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
});
