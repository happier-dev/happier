import { describe, expect, it, vi } from 'vitest';

// expo-server-sdk (with node-fetch, whatwg-url and the tr46 mapping table) is the remote push boundary.
// Every daemon and Session host imports the push client, so the SDK must load with the first send only.
const expoLoads = vi.hoisted(() => ({ count: 0 }));

vi.mock('axios', () => ({
  __esModule: true,
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), defaults: {}, getUri: (config?: { url?: string }) => config?.url ?? '', isAxiosError: () => false },
}));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), infoFile: vi.fn() } }));
vi.mock('expo-server-sdk', () => {
  expoLoads.count += 1;
  class Expo {
    static isExpoPushToken() { return true; }
    chunkPushNotifications(messages: unknown[]) { return [messages]; }
    async sendPushNotificationsAsync(chunk: unknown[]) { return chunk.map((_, index) => ({ status: 'ok', id: `receipt-${index}` })); }
    async getPushNotificationReceiptsAsync() { return {}; }
  }
  return { __esModule: true, Expo };
});

import { PushNotificationClient } from './pushNotifications';

describe('PushNotificationClient Expo SDK loading', () => {
  it('loads the Expo SDK once, at the first send, not when the push client module or client is created', async () => {
    const client = new PushNotificationClient('t');
    expect(expoLoads.count).toBe(0);
    await client.sendPushNotifications([{ to: 'ExponentPushToken[a]', body: 'one' }]);
    await new PushNotificationClient('t').sendPushNotifications([{ to: 'ExponentPushToken[b]', body: 'two' }]);
    expect(expoLoads.count).toBe(1);
  });
});
