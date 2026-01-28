import { describe, expect, it } from 'vitest';

import { sendPushNotification } from './notify';

describe('sendPushNotification', () => {
  it('awaits the push send call so errors are surfaced', async () => {
    const api = {
      push() {
        return {
          async sendToAllDevicesAsync() {
            throw new Error('push failed');
          },
        };
      },
    };

    await expect(sendPushNotification({ api, title: 'Happy', message: 'hi', nowMs: 123 })).rejects.toThrow('push failed');
  });

  it('sends the expected metadata payload', async () => {
    const calls: unknown[] = [];
    const api = {
      push() {
        return {
          async sendToAllDevicesAsync(title: string, message: string, meta: unknown) {
            calls.push({ title, message, meta });
          },
        };
      },
    };

    await sendPushNotification({ api, title: 'T', message: 'M', nowMs: 456 });

    expect(calls).toEqual([
      {
        title: 'T',
        message: 'M',
        meta: { source: 'cli', timestamp: 456 },
      },
    ]);
  });
});
