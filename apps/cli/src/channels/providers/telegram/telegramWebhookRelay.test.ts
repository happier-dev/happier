import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { startTelegramWebhookRelay } from './telegramWebhookRelay';

describe('startTelegramWebhookRelay', () => {
  it('rejects webhook secret tokens outside Telegram-safe charset', async () => {
    await expect(startTelegramWebhookRelay({
      port: 0,
      host: '127.0.0.1',
      secretToken: 'bad$token',
      onUpdate: () => {
        throw new Error('should not be called');
      },
    })).rejects.toThrow('Webhook secret token must match [A-Za-z0-9_-]');
  });

  it('accepts webhook updates on the fixed webhook path', async () => {
    const received: unknown[] = [];

    const relay = await startTelegramWebhookRelay({
      port: 0,
      host: '127.0.0.1',
      secretToken: 'secret-123',
      onUpdate: (update) => {
        received.push(update);
      },
    });

    try {
      const response = await axios.post(`http://127.0.0.1:${relay.port}/telegram/webhook`, {
        update_id: 42,
        message: { text: 'hello' },
      }, {
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': 'secret-123',
        },
      });

      expect(response.status).toBe(200);
      expect(received).toEqual([
        {
          update_id: 42,
          message: { text: 'hello' },
        },
      ]);
    } finally {
      await relay.stop();
    }
  });

  it('rejects requests when header secret token is missing or invalid', async () => {
    const received: unknown[] = [];

    const relay = await startTelegramWebhookRelay({
      port: 0,
      host: '127.0.0.1',
      secretToken: 'header-token-abc',
      onUpdate: (update) => {
        received.push(update);
      },
    });

    try {
      const missingHeaderResponse = await axios.post(`http://127.0.0.1:${relay.port}/telegram/webhook`, {
        update_id: 101,
        message: { text: 'hello' },
      }, {
        validateStatus: () => true,
      });

      const invalidHeaderResponse = await axios.post(`http://127.0.0.1:${relay.port}/telegram/webhook`, {
        update_id: 102,
        message: { text: 'hello again' },
      }, {
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': 'wrong-token',
        },
        validateStatus: () => true,
      });

      expect(missingHeaderResponse.status).toBe(401);
      expect(invalidHeaderResponse.status).toBe(401);
      expect(received).toEqual([]);
    } finally {
      await relay.stop();
    }
  });

  it('does not acknowledge webhook updates when onUpdate fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let relay: Awaited<ReturnType<typeof startTelegramWebhookRelay>> | null = null;

    try {
      relay = await startTelegramWebhookRelay({
        port: 0,
        host: '127.0.0.1',
        secretToken: 'secret-fail',
        onUpdate: async () => {
          throw new Error('failed to process update');
        },
      });

      const response = await axios.post(
        `http://127.0.0.1:${relay.port}/telegram/webhook`,
        {
          update_id: 202,
          message: { text: 'hello' },
        },
        {
          headers: {
            'X-Telegram-Bot-Api-Secret-Token': 'secret-fail',
          },
          validateStatus: () => true,
        },
      );

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.status).toBeLessThan(600);
      expect(warnSpy).toHaveBeenCalledWith(
        '[TELEGRAM_WEBHOOK_RELAY] Failed to process inbound webhook update',
        expect.objectContaining({
          path: '/telegram/webhook',
          tokenLength: 'secret-fail'.length,
        }),
      );
    } finally {
      warnSpy.mockRestore();
      await relay?.stop();
    }
  });

  it('rejects webhook secret tokens that exceed the maximum length', async () => {
    await expect(startTelegramWebhookRelay({
      port: 0,
      host: '127.0.0.1',
      secretToken: 'x'.repeat(300),
      onUpdate: () => undefined,
    })).rejects.toThrow('Webhook secret token is too long');
  });

  it('rejects requests with oversized header secret tokens without allocating large buffers', async () => {
    const received: unknown[] = [];

    const relay = await startTelegramWebhookRelay({
      port: 0,
      host: '127.0.0.1',
      secretToken: 'header-token-abc',
      onUpdate: (update) => {
        received.push(update);
      },
    });

    try {
      const oversizedHeaderResponse = await axios.post(`http://127.0.0.1:${relay.port}/telegram/webhook`, {
        update_id: 103,
        message: { text: 'hello' },
      }, {
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': 'x'.repeat(400),
        },
        validateStatus: () => true,
      });

      expect(oversizedHeaderResponse.status).toBe(431);
      expect(received).toEqual([]);
    } finally {
      await relay.stop();
    }
  });

  it('rejects non-loopback webhook hosts', async () => {
    await expect(startTelegramWebhookRelay({
      port: 0,
      host: '0.0.0.0',
      secretToken: 'secret-123',
      onUpdate: () => undefined,
    })).rejects.toThrow('Webhook host must be loopback-only');
  });

  it('rejects non-finite webhook ports', async () => {
    await expect(startTelegramWebhookRelay({
      port: Number.NaN,
      host: '127.0.0.1',
      secretToken: 'secret-123',
      onUpdate: () => undefined,
    })).rejects.toThrow('Webhook port must be a finite number');
  });
});
