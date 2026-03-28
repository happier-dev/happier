import { describe, expect, it } from 'vitest';

import {
  readScopedTelegramBridgeConfig,
  removeScopedTelegramBridgeConfig,
  upsertScopedTelegramBridgeConfig,
} from './channelBridgeAccountConfig';

describe('channelBridgeAccountConfig', () => {
  it('rejects webhook secrets that do not match Telegram-safe token charset', () => {
    expect(() =>
      upsertScopedTelegramBridgeConfig({
        settings: {},
        serverId: 'local-3005',
        accountId: 'acct-1',
        update: {
          webhookSecret: 'bad token!',
        },
      })
    ).toThrow('Invalid webhookSecret: must match [A-Za-z0-9_-]');
  });

  it('rejects webhook secrets that exceed Telegram maximum length', () => {
    expect(() =>
      upsertScopedTelegramBridgeConfig({
        settings: {},
        serverId: 'local-3005',
        accountId: 'acct-1',
        update: {
          webhookSecret: 'x'.repeat(257),
        },
      })
    ).toThrow('Webhook secret token is too long');
  });

  it('writes scoped telegram config under server/account with secrets in local-only block', () => {
    const next = upsertScopedTelegramBridgeConfig({
      settings: {},
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        tickMs: 2_200,
        botToken: 'bot-token',
        allowedChatIds: ['-100111'],
        requireTopics: true,
        webhookEnabled: true,
        webhookSecret: 'secret-1',
        webhookHost: '127.0.0.1',
        webhookPort: 9_000,
      },
    });

    const telegram = readScopedTelegramBridgeConfig({
      settings: next,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    expect(telegram).toEqual({
      tickMs: 2_200,
      botToken: 'bot-token',
      allowedChatIds: ['-100111'],
      requireTopics: true,
      webhook: {
        enabled: true,
        secret: 'secret-1',
        host: '127.0.0.1',
        port: 9_000,
      },
    });

    expect((next as any).channelBridge.byServerId['local-3005'].byAccountId['acct-1'].providers.telegram.secrets).toEqual({
      botToken: 'bot-token',
      webhookSecret: 'secret-1',
    });
    expect((next as any).channelBridge.byServerId['local-3005'].byAccountId['acct-1'].providers.telegram.botToken).toBeUndefined();
    expect((next as any).channelBridge.byServerId['local-3005'].byAccountId['acct-1'].providers.telegram.webhook.secret).toBeUndefined();
  });

  it('normalizes allowedChatIds when writing scoped config', () => {
    const next = upsertScopedTelegramBridgeConfig({
      settings: {},
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        allowedChatIds: [' -100111 ', '', '   ', '-100222'],
      },
    });

    const telegram = readScopedTelegramBridgeConfig({
      settings: next,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    expect(telegram?.allowedChatIds).toEqual(['-100111', '-100222']);
  });

  it('does not materialize providers.telegram for tick-only scoped updates', () => {
    const next = upsertScopedTelegramBridgeConfig({
      settings: {},
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        tickMs: 2_500,
      },
    });

    expect((next as any).channelBridge.byServerId['local-3005'].byAccountId['acct-1'].providers).toBeUndefined();

    const telegram = readScopedTelegramBridgeConfig({
      settings: next,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    expect(telegram).toBeNull();
  });

  it('preserves webhook secret when only webhook host/port settings are updated', () => {
    const configured = upsertScopedTelegramBridgeConfig({
      settings: {},
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        webhookSecret: 'secret-1',
      },
    });

    const updated = upsertScopedTelegramBridgeConfig({
      settings: configured,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        webhookHost: '127.0.0.1',
        webhookPort: 8080,
      },
    });

    const telegram = readScopedTelegramBridgeConfig({
      settings: updated,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });
    const webhook = telegram?.webhook as { secret?: string; host?: string; port?: number } | undefined;

    expect(webhook?.secret).toBe('secret-1');
    expect(webhook?.host).toBe('127.0.0.1');
    expect(webhook?.port).toBe(8080);
  });

  it('removes scoped telegram config and prunes empty nesting', () => {
    const configured = upsertScopedTelegramBridgeConfig({
      settings: {},
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        tickMs: 2_200,
        botToken: 'bot-token',
      },
    });

    const cleared = removeScopedTelegramBridgeConfig({
      settings: configured,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    const telegram = readScopedTelegramBridgeConfig({
      settings: cleared,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    expect(telegram).toBeNull();
    expect((cleared as any).channelBridge).toBeUndefined();
  });

  it('removes stale scoped tickMs even when providers.telegram is already missing', () => {
    const cleared = removeScopedTelegramBridgeConfig({
      settings: {
        channelBridge: {
          byServerId: {
            'local-3005': {
              byAccountId: {
                'acct-1': {
                  tickMs: 2_500,
                },
              },
            },
          },
        },
      },
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    expect((cleared as any).channelBridge).toBeUndefined();
  });
});
