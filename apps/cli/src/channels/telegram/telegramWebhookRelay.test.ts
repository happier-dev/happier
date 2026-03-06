import axios from 'axios';
import { describe, expect, it } from 'vitest';

import { startTelegramWebhookRelay } from './telegramWebhookRelay';

describe('startTelegramWebhookRelay', () => {
  it('rejects webhook secret path tokens outside Telegram-safe charset', async () => {
    await expect(startTelegramWebhookRelay({
      port: 0,
      host: '127.0.0.1',
      secretPathToken: 'bad$token',
      onUpdate: () => {
        throw new Error('should not be called');
      },
    })).rejects.toThrow('Webhook secret token must match [A-Za-z0-9_-]');
  });

  it('accepts webhook updates on the configured secret path', async () => {
    const received: unknown[] = [];

    const relay = await startTelegramWebhookRelay({
      port: 0,
      host: '127.0.0.1',
      secretPathToken: 'secret-123',
      secretHeaderToken: 'secret-123',
      onUpdate: (update) => {
        received.push(update);
      },
    });

    try {
      const response = await axios.post(`http://127.0.0.1:${relay.port}${relay.path}`, {
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
      secretPathToken: 'secret-abc',
      secretHeaderToken: 'header-token-abc',
      onUpdate: (update) => {
        received.push(update);
      },
    });

    try {
      const missingHeaderResponse = await axios.post(`http://127.0.0.1:${relay.port}${relay.path}`, {
        update_id: 101,
        message: { text: 'hello' },
      }, {
        validateStatus: () => true,
      });

      const invalidHeaderResponse = await axios.post(`http://127.0.0.1:${relay.port}${relay.path}`, {
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
    const relay = await startTelegramWebhookRelay({
      port: 0,
      host: '127.0.0.1',
      secretPathToken: 'secret-fail',
      secretHeaderToken: 'secret-fail',
      onUpdate: async () => {
        throw new Error('failed to process update');
      },
    });

    try {
      const response = await axios.post(
        `http://127.0.0.1:${relay.port}${relay.path}`,
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
    } finally {
      await relay.stop();
    }
  });

  it('requires an explicit webhook header secret token', async () => {
    await expect(startTelegramWebhookRelay({
      port: 0,
      host: '127.0.0.1',
      secretPathToken: 'secret-123',
      onUpdate: () => undefined,
    })).rejects.toThrow('Webhook header secret token is required');
  });

  it('rejects non-loopback webhook hosts', async () => {
    await expect(startTelegramWebhookRelay({
      port: 0,
      host: '0.0.0.0',
      secretPathToken: 'secret-123',
      secretHeaderToken: 'secret-123',
      onUpdate: () => undefined,
    })).rejects.toThrow('Webhook host must be loopback-only');
  });
});
