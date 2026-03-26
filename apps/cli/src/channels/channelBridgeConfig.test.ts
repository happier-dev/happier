import { describe, expect, it } from 'vitest';

import { resolveChannelBridgeRuntimeConfig } from './channelBridgeConfig';

describe('resolveChannelBridgeRuntimeConfig', () => {
  it('uses settings.json bridge values when env is not set', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {},
      settings: {
        channelBridge: {
          tickMs: 3_100,
          providers: {
            telegram: {
              botToken: 'settings-bot-token',
              allowedChatIds: ['-100111', '-100222'],
              requireTopics: true,
              webhook: {
                enabled: true,
                secret: 'settings-secret',
                host: '0.0.0.0',
                port: 9_001,
              },
            },
          },
        },
      },
    });

    expect(config.tickMs).toBe(3_100);
    expect(config.telegram.botToken).toBe('settings-bot-token');
    expect(config.telegram.allowedChatIds).toEqual(['-100111', '-100222']);
    expect(config.telegram.allowAllSharedChats).toBe(false);
    expect(config.telegram.requireTopics).toBe(true);
    expect(config.telegram.webhookEnabled).toBe(true);
    expect(config.telegram.webhookSecret).toBe('settings-secret');
    expect(config.telegram.webhookHost).toBe('127.0.0.1');
    expect(config.telegram.webhookPort).toBe(9_001);
  });

  it('reads secret fields from telegram.secrets local-only block', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {},
      settings: {
        channelBridge: {
          providers: {
            telegram: {
              allowedChatIds: ['-100111'],
              requireTopics: true,
              webhook: {
                enabled: true,
                host: '127.0.0.1',
                port: 8787,
              },
              secrets: {
                botToken: 'secret-bot-token',
                webhookSecret: 'secret-webhook-token',
              },
            },
          },
        },
      },
    });

    expect(config.telegram.botToken).toBe('secret-bot-token');
    expect(config.telegram.webhookSecret).toBe('secret-webhook-token');
    expect(config.telegram.allowedChatIds).toEqual(['-100111']);
    expect(config.telegram.allowAllSharedChats).toBe(false);
    expect(config.telegram.requireTopics).toBe(true);
  });

  it('applies env overrides and falls back to settings for invalid env webhook port', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {
        HAPPIER_CHANNEL_BRIDGE_TICK_MS: '700',
        HAPPIER_TELEGRAM_BOT_TOKEN: 'env-token',
        HAPPIER_TELEGRAM_ALLOWED_CHAT_IDS: '-100333,-100444',
        HAPPIER_TELEGRAM_REQUIRE_TOPICS: '0',
        HAPPIER_TELEGRAM_WEBHOOK_ENABLED: '1',
        HAPPIER_TELEGRAM_WEBHOOK_SECRET: 'env-secret',
        HAPPIER_TELEGRAM_WEBHOOK_HOST: '127.0.0.9',
        HAPPIER_TELEGRAM_WEBHOOK_PORT: '8_877',
      },
      settings: {
        channelBridge: {
          tickMs: 5_000,
          providers: {
            telegram: {
              botToken: 'settings-token',
              allowedChatIds: ['-100111'],
              requireTopics: true,
              webhook: {
                enabled: false,
                secret: 'settings-secret',
                host: '0.0.0.0',
                port: 9_001,
              },
            },
          },
        },
      },
    });

    expect(config.tickMs).toBe(700);
    expect(config.telegram.botToken).toBe('env-token');
    expect(config.telegram.allowedChatIds).toEqual(['-100333', '-100444']);
    expect(config.telegram.allowAllSharedChats).toBe(false);
    expect(config.telegram.requireTopics).toBe(false);
    expect(config.telegram.webhookEnabled).toBe(true);
    expect(config.telegram.webhookSecret).toBe('env-secret');
    expect(config.telegram.webhookHost).toBe('127.0.0.9');
    expect(config.telegram.webhookPort).toBe(9_001);
  });

  it('applies a valid env webhook port override', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {
        HAPPIER_TELEGRAM_WEBHOOK_PORT: '8877',
      },
      settings: {
        channelBridge: {
          providers: {
            telegram: {
              webhook: {
                port: 9_001,
              },
            },
          },
        },
      },
    });

    expect(config.telegram.webhookPort).toBe(8_877);
  });

  it('reads allowAllSharedChats from env', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {
        HAPPIER_TELEGRAM_ALLOW_ALL_SHARED_CHATS: '1',
      },
      settings: {},
    });

    expect(config.telegram.allowAllSharedChats).toBe(true);
  });

  it('falls back to settings allowedChatIds when env CSV is effectively empty', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {
        HAPPIER_TELEGRAM_ALLOWED_CHAT_IDS: ', ,',
      },
      settings: {
        channelBridge: {
          providers: {
            telegram: {
              allowedChatIds: ['-100settings'],
            },
          },
        },
      },
    });

    expect(config.telegram.allowedChatIds).toEqual(['-100settings']);
  });

  it('falls back to lower scope when account allowedChatIds is malformed', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {},
      serverId: 'local-test',
      accountId: 'acct-123',
      settings: {
        channelBridge: {
          providers: {
            telegram: {
              allowedChatIds: ['-100-global'],
            },
          },
          byServerId: {
            'local-test': {
              providers: {
                telegram: {
                  allowedChatIds: ['-100-server'],
                },
              },
              byAccountId: {
                'acct-123': {
                  providers: {
                    telegram: {
                      allowedChatIds: [{}],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(config.telegram.allowedChatIds).toEqual(['-100-server']);
  });

  it('falls back to lower scope when account allowedChatIds string normalizes empty', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {},
      serverId: 'local-test',
      accountId: 'acct-123',
      settings: {
        channelBridge: {
          byServerId: {
            'local-test': {
              providers: {
                telegram: {
                  allowedChatIds: ['-100-server'],
                },
              },
              byAccountId: {
                'acct-123': {
                  providers: {
                    telegram: {
                      allowedChatIds: ',  ,',
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(config.telegram.allowedChatIds).toEqual(['-100-server']);
  });

  it('falls back to lower scope when higher-scope string secrets are blank', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {},
      serverId: 'local-test',
      accountId: 'acct-123',
      settings: {
        channelBridge: {
          providers: {
            telegram: {
              botToken: 'global-token',
              webhook: {
                secret: 'global-secret',
              },
            },
          },
          byServerId: {
            'local-test': {
              providers: {
                telegram: {
                  botToken: 'server-token',
                  webhook: {
                    secret: 'server-secret',
                  },
                },
              },
              byAccountId: {
                'acct-123': {
                  providers: {
                    telegram: {
                      botToken: '   ',
                      webhook: {
                        secret: '   ',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(config.telegram.botToken).toBe('server-token');
    expect(config.telegram.webhookSecret).toBe('server-secret');
  });

  it('falls back to settings webhook secret when env secret token is invalid', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {
        HAPPIER_TELEGRAM_WEBHOOK_SECRET: 'bad token!',
      },
      settings: {
        channelBridge: {
          providers: {
            telegram: {
              webhook: {
                secret: 'settings-secret',
              },
            },
          },
        },
      },
    });

    expect(config.telegram.webhookSecret).toBe('settings-secret');
  });

  it('ignores non-loopback env webhook host and keeps settings host', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {
        HAPPIER_TELEGRAM_WEBHOOK_HOST: '0.0.0.0',
      },
      settings: {
        channelBridge: {
          providers: {
            telegram: {
              webhook: {
                host: '127.0.0.1',
              },
            },
          },
        },
      },
    });

    expect(config.telegram.webhookHost).toBe('127.0.0.1');
  });

  it('rejects webhook port zero and falls back to default', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {
        HAPPIER_TELEGRAM_WEBHOOK_PORT: '0',
      },
      settings: {
        channelBridge: {
          providers: {
            telegram: {
              webhook: {
                port: 0,
              },
            },
          },
        },
      },
    });

    expect(config.telegram.webhookPort).toBe(8_787);
  });

  it('resolves account-scoped bridge config with server/global fallback', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {},
      serverId: 'local-test',
      accountId: 'acct-123',
      settings: {
        channelBridge: {
          tickMs: 2_500,
          providers: {
            telegram: {
              botToken: 'global-token',
              allowedChatIds: ['-100-global'],
              requireTopics: false,
              webhook: {
                enabled: false,
                secret: '',
                host: '127.0.0.1',
                port: 8_787,
              },
            },
          },
          byServerId: {
            'local-test': {
              providers: {
                telegram: {
                  allowedChatIds: ['-100-server'],
                  requireTopics: true,
                },
              },
              byAccountId: {
                'acct-123': {
                  tickMs: 1_800,
                  providers: {
                    telegram: {
                      botToken: 'account-token',
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(config.tickMs).toBe(1_800);
    expect(config.telegram.botToken).toBe('account-token');
    expect(config.telegram.allowedChatIds).toEqual(['-100-server']);
    expect(config.telegram.requireTopics).toBe(true);
    expect(config.telegram.webhookEnabled).toBe(false);
    expect(config.telegram.webhookHost).toBe('127.0.0.1');
    expect(config.telegram.webhookPort).toBe(8_787);
  });

  it('falls back to global settings when scoped bridge config is missing', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {},
      serverId: 'unknown-server',
      accountId: 'acct-missing',
      settings: {
        channelBridge: {
          tickMs: 4_200,
          providers: {
            telegram: {
              botToken: 'global-token',
              allowedChatIds: [],
              requireTopics: true,
            },
          },
        },
      },
    });

    expect(config.tickMs).toBe(4_200);
    expect(config.telegram.botToken).toBe('global-token');
    expect(config.telegram.allowedChatIds).toEqual([]);
    expect(config.telegram.requireTopics).toBe(true);
  });

  it('keeps settings allowedChatIds when env override is empty', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {
        HAPPIER_TELEGRAM_ALLOWED_CHAT_IDS: '   ',
      },
      settings: {
        channelBridge: {
          providers: {
            telegram: {
              allowedChatIds: ['-100111'],
            },
          },
        },
      },
    });

    expect(config.telegram.allowedChatIds).toEqual(['-100111']);
  });

  it('accepts numeric allowedChatIds from settings arrays', () => {
    const config = resolveChannelBridgeRuntimeConfig({
      env: {},
      settings: {
        channelBridge: {
          providers: {
            telegram: {
              allowedChatIds: [-1001234567890],
            },
          },
        },
      },
    });

    expect(config.telegram.allowedChatIds).toEqual(['-1001234567890']);
  });
});
