import { describe, expect, it } from 'vitest';

import { resolveChannelBridgeRuntimeConfig } from './channelBridgeConfig';
import { overlayServerKvTelegramConfigInSettings } from './channelBridgeServerConfigOverlay';

describe('overlayServerKvTelegramConfigInSettings', () => {
  it('overlays non-secret server KV telegram config into scoped runtime settings', () => {
    const merged = overlayServerKvTelegramConfigInSettings({
      settings: {
        channelBridge: {
          byServerId: {
            'local-3005': {
              byAccountId: {
                acct_123: {
                  providers: {
                    telegram: {
                      secrets: {
                        botToken: 'local-secret-token',
                        webhookSecret: 'local-secret-webhook',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      serverId: 'local-3005',
      accountId: 'acct_123',
      record: {
        schemaVersion: 1,
        tickMs: 3100,
        telegram: {
          allowedChatIds: ['-100111', '-100222'],
          requireTopics: true,
          webhook: {
            enabled: true,
            host: '0.0.0.0',
            port: 9001,
          },
        },
        updatedAtMs: Date.now(),
      },
    });

    const runtime = resolveChannelBridgeRuntimeConfig({
      env: {},
      settings: merged,
      serverId: 'local-3005',
      accountId: 'acct_123',
    });

    expect(runtime.tickMs).toBe(3100);
    expect(runtime.telegram.botToken).toBe('local-secret-token');
    expect(runtime.telegram.allowedChatIds).toEqual(['-100111', '-100222']);
    expect(runtime.telegram.requireTopics).toBe(true);
    expect(runtime.telegram.webhookEnabled).toBe(true);
    expect(runtime.telegram.webhookSecret).toBe('local-secret-webhook');
    expect(runtime.telegram.webhookHost).toBe('0.0.0.0');
    expect(runtime.telegram.webhookPort).toBe(9001);
  });

  it('returns original settings when no record is available', () => {
    const settings = {
      channelBridge: {
        byServerId: {
          'local-3005': {
            byAccountId: {
              acct_123: {
                providers: {
                  telegram: {
                    botToken: 'local-token',
                  },
                },
              },
            },
          },
        },
      },
    };

    const merged = overlayServerKvTelegramConfigInSettings({
      settings,
      serverId: 'local-3005',
      accountId: 'acct_123',
      record: null,
    });

    expect(merged).toBe(settings);
  });

  it('does not create empty scoped config when record has no usable fields', () => {
    const settings = { schemaVersion: 7 };

    const merged = overlayServerKvTelegramConfigInSettings({
      settings,
      serverId: 'local-3005',
      accountId: 'acct_123',
      record: {
        schemaVersion: 1,
        telegram: {},
        updatedAtMs: Date.now(),
      },
    });

    expect(merged).toBe(settings);
  });
});
