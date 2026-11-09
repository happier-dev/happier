import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';

import {
  DISCORD_APPLICATION_GATEWAY_MESSAGE_CONTENT_FLAG,
  DISCORD_APPLICATION_GATEWAY_MESSAGE_CONTENT_LIMITED_FLAG,
  createDiscordBotApi,
  readDiscordApplicationMessageContentIntentPermission,
} from './discordApi.js';

function response(value: unknown, status = 200) {
  return {
    status,
    finalUrl: 'https://discord.com/api/v10/',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

describe('Discord Gateway Bot snapshot', () => {
  it('creates an explicitly public thread without a starter message and verifies its parent', async () => {
    const requests: { url: string; body?: Uint8Array }[] = [];
    const api = createDiscordBotApi({ token: 'fixture-token', http: { async request(input) {
      requests.push(input);
      return response({ id: 'thread-1', type: 11, parent_id: 'parent-1', name: 'Brief' }, 201);
    } } });
    await expect(api.createThread({ channelId: 'parent-1', name: 'Brief' }))
      .resolves.toEqual({ kind: 'created', channelId: 'thread-1' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://discord.com/api/v10/channels/parent-1/threads');
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toEqual({ name: 'Brief', type: 11 });
  });

  it.each([
    { status: 403, body: { code: 50013, message: 'Missing Permissions' }, expected: { kind: 'notSent', retry: 'never' } },
    { status: 429, body: { retry_after: 9 }, expected: { kind: 'notSent', retry: 'after', retryAfterMs: 9000 } },
    { status: 503, body: {}, expected: { kind: 'outcomeUnknown' } },
    { status: 201, body: { id: 'thread-1', type: 12, parent_id: 'other' }, expected: { kind: 'outcomeUnknown' } },
  ])('classifies native thread creation without retrying HTTP ($status)', async ({ status, body, expected }) => {
    const request = vi.fn(async () => response(body, status));
    const api = createDiscordBotApi({ token: 'fixture-token', http: { request } });
    await expect(api.createThread({ channelId: 'parent-1', name: 'Brief' })).resolves.toMatchObject(expected);
    expect(request).toHaveBeenCalledOnce();
  });

  it('accepts the native 100-code-point thread name boundary and rejects longer names before HTTP', async () => {
    const request = vi.fn(async () => response({ id: 'thread-1', type: 11, parent_id: 'parent-1' }, 201));
    const api = createDiscordBotApi({ token: 'fixture-token', http: { request } });
    await expect(api.createThread({ channelId: 'parent-1', name: '🦉'.repeat(100) }))
      .resolves.toEqual({ kind: 'created', channelId: 'thread-1' });
    await expect(api.createThread({ channelId: 'parent-1', name: '🦉'.repeat(101) }))
      .resolves.toMatchObject({ kind: 'notSent', retry: 'never' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('accepts a slow REST response while the caller remains active', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const api = createDiscordBotApi({ token: 'bot-token', http: {
        request(input, options) {
          expect(options?.signal).toBe(controller.signal);
          return new Promise((resolve, reject) => {
            const responseTimer = setTimeout(() => resolve(response({
              url: 'wss://gateway.discord.gg', shards: 1,
              session_start_limit: { total: 1_000, remaining: 1_000, reset_after: 0, max_concurrency: 1 },
            })), 15_001);
            if (input.timeoutMs !== undefined) setTimeout(() => {
              clearTimeout(responseTimer);
              reject(new Error('HTTP deadline exceeded'));
            }, input.timeoutMs);
          });
        },
      } });
      const result = api.getGatewayBot({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(15_001);
      await expect(result).resolves.toMatchObject({ gatewayUrl: 'wss://gateway.discord.gg/?v=10&encoding=json' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an outstanding REST request with its caller', async () => {
    const controller = new AbortController();
    const cancelled = new Error('connection retired');
    const api = createDiscordBotApi({ token: 'bot-token', http: {
      request(_input, options) {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
      },
    } });
    const result = api.getGatewayBot({ signal: controller.signal });
    controller.abort(cancelled);
    await expect(result).rejects.toBe(cancelled);
  });

  it('does not convert retired HTTP host generations into retryable Discord network failures', async () => {
    const error = new PluginError({ code: 'plugin_final_generation_retired', message: 'Retired HTTP host' });
    const api = createDiscordBotApi({ token: 'bot-token', http: { request: async () => { throw error; } } });
    await expect(api.getChannel({ channelId: 'channel-1' })).rejects.toBe(error);
  });

  it.each([1_000, 0])('accepts reset_after zero with %i remaining starts', async (remaining) => {
    const api = createDiscordBotApi({
      token: 'bot-token',
      http: { request: vi.fn(async () => response({
        url: 'wss://gateway.discord.gg',
        shards: 1,
        session_start_limit: { total: 1_000, remaining, reset_after: 0, max_concurrency: 1 },
      })) },
    });

    await expect(api.getGatewayBot()).resolves.toEqual({
      gatewayUrl: 'wss://gateway.discord.gg/?v=10&encoding=json',
      sessionStartLimit: { total: 1_000, remaining, resetAfterMs: 0, maxConcurrency: 1 },
    });
  });

  it.each([-1, 0.5, '0'])('refuses an invalid reset_after %s', async (resetAfter) => {
    const api = createDiscordBotApi({
      token: 'bot-token',
      http: { request: vi.fn(async () => response({
        url: 'wss://gateway.discord.gg',
        session_start_limit: { total: 1_000, remaining: 1_000, reset_after: resetAfter, max_concurrency: 1 },
      })) },
    });

    await expect(api.getGatewayBot()).resolves.toMatchObject({
      kind: 'notReady',
      reason: 'invalidConfiguration',
    });
  });
});

describe('Discord application Message Content preflight', () => {
  it('uses both flags fields and fails closed on malformed or inconsistent permission evidence', () => {
    expect(readDiscordApplicationMessageContentIntentPermission({
      flags: DISCORD_APPLICATION_GATEWAY_MESSAGE_CONTENT_FLAG,
      flags_new: String(DISCORD_APPLICATION_GATEWAY_MESSAGE_CONTENT_FLAG),
    })).toEqual({ kind: 'enabled', source: 'flagsAndFlagsNew' });
    expect(readDiscordApplicationMessageContentIntentPermission({
      flags: 0,
      flags_new: '0',
    })).toEqual({ kind: 'disabled', source: 'flagsAndFlagsNew' });
    expect(readDiscordApplicationMessageContentIntentPermission({
      flags: DISCORD_APPLICATION_GATEWAY_MESSAGE_CONTENT_LIMITED_FLAG,
    })).toEqual({ kind: 'enabled', source: 'flags' });
    expect(readDiscordApplicationMessageContentIntentPermission({
      flags: 0,
      flags_new: String(DISCORD_APPLICATION_GATEWAY_MESSAGE_CONTENT_FLAG),
    })).toEqual({ kind: 'unknown', reason: 'inconsistent' });
    expect(readDiscordApplicationMessageContentIntentPermission({ flags: 'not-a-number' })).toEqual({
      kind: 'unknown',
      reason: 'malformed',
    });
    expect(readDiscordApplicationMessageContentIntentPermission({})).toEqual({ kind: 'unknown', reason: 'missing' });
  });

  it('reads current bot-member roles from Discord’s exact member route and does not trust a mismatched returned user', async () => {
    const request = vi.fn(async () => response({
      user: { id: 'bot-1' },
      roles: ['role-1', 'role-2'],
    }));
    const api = createDiscordBotApi({ token: 'bot-token', http: { request } });

    await expect(api.getGuildMember({ guildId: 'guild-1', userId: 'bot-1' })).resolves.toEqual({
      roleIds: ['role-1', 'role-2'],
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://discord.com/api/v10/guilds/guild-1/members/bot-1',
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bot bot-token' }),
      }),
      undefined,
    );

    const routeAuthenticated = createDiscordBotApi({
      token: 'bot-token',
      http: { request: vi.fn(async () => response({ roles: ['role-3'] })) },
    });
    await expect(routeAuthenticated.getGuildMember({ guildId: 'guild-1', userId: 'bot-1' })).resolves.toEqual({
      roleIds: ['role-3'],
    });

    const mismatched = createDiscordBotApi({
      token: 'bot-token',
      http: { request: vi.fn(async () => response({ user: { id: 'other-bot' }, roles: ['role-1'] })) },
    });
    await expect(mismatched.getGuildMember({ guildId: 'guild-1', userId: 'bot-1' })).resolves.toEqual({
      kind: 'notReady',
      reason: 'invalidConfiguration',
      diagnostic: 'Discord returned invalid current bot-member role evidence.',
    });
  });

  it('keeps exact Discord role-lookup failure classes distinct from an absent member', async () => {
    const rateLimited = createDiscordBotApi({
      token: 'bot-token',
      http: {
        request: vi.fn(async () => response({ message: 'You are being rate limited.', retry_after: 1.25 }, 429)),
      },
    });
    await expect(rateLimited.getGuildMember({ guildId: 'guild-1', userId: 'bot-1' })).resolves.toEqual({
      kind: 'notReady',
      reason: 'rateLimited',
      retryAfterMs: 1_250,
      diagnostic: 'You are being rate limited.',
    });

    const forbidden = createDiscordBotApi({
      token: 'bot-token',
      http: { request: vi.fn(async () => response({ message: 'Missing Access' }, 403)) },
    });
    await expect(forbidden.getGuildMember({ guildId: 'guild-1', userId: 'bot-1' })).resolves.toEqual({
      kind: 'notReady',
      reason: 'permissionMissing',
      diagnostic: 'Missing Access',
    });

    const unavailable = createDiscordBotApi({
      token: 'bot-token',
      http: { request: vi.fn(async () => { throw new Error('socket unavailable'); }) },
    });
    await expect(unavailable.getGuildMember({ guildId: 'guild-1', userId: 'bot-1' })).resolves.toEqual({
      kind: 'notReady',
      reason: 'network',
    });

    const malformed = createDiscordBotApi({
      token: 'bot-token',
      http: { request: vi.fn(async () => response({ user: { id: 'bot-1' }, roles: ['role-1', 7] })) },
    });
    await expect(malformed.getGuildMember({ guildId: 'guild-1', userId: 'bot-1' })).resolves.toEqual({
      kind: 'notReady',
      reason: 'invalidConfiguration',
      diagnostic: 'Discord returned invalid current bot-member role evidence.',
    });
  });
});

describe('Discord channel lookup', () => {
  it.each([15, 16])('decodes channel type %i only as permission-bearing thread-parent evidence', async (type) => {
    const api = createDiscordBotApi({
      token: 'bot-token',
      http: {
        request: vi.fn(async () => response({
          id: 'parent-1',
          type,
          guild_id: 'guild-1',
          name: 'Forum parent',
          permission_overwrites: [],
        })),
      },
    });

    await expect(api.getChannel({ channelId: 'parent-1' })).resolves.toEqual({
      channelId: 'parent-1',
      kind: 'permissionParent',
      guildId: 'guild-1',
      permissionOverwrites: [],
    });
  });

  it('keeps an authoritative 404 distinct from malformed successful channel responses', async () => {
    const absent = createDiscordBotApi({
      token: 'bot-token',
      http: { request: vi.fn(async () => response({ message: 'Unknown Channel' }, 404)) },
    });
    await expect(absent.getChannel({ channelId: 'channel-1' })).resolves.toBeNull();

    const malformedResponses = [
      ['mismatched channel id', { id: 'other-channel', type: 1 }],
      ['missing channel id', { type: 1 }],
      ['missing channel type', { id: 'channel-1' }],
      ['unsupported channel type', { id: 'channel-1', type: 2 }],
      ['thread without a usable parent', { id: 'channel-1', type: 11, parent_id: '' }],
      [
        'malformed permission overwrites',
        { id: 'channel-1', type: 0, permission_overwrites: [{ id: 'role-1', type: 0, allow: '0', deny: 7 }] },
      ],
    ] as const;

    for (const [name, body] of malformedResponses) {
      const api = createDiscordBotApi({
        token: 'bot-token',
        http: { request: vi.fn(async () => response(body)) },
      });

      await expect(api.getChannel({ channelId: 'channel-1' }), name).resolves.toEqual({
        kind: 'notReady',
        reason: 'invalidConfiguration',
        diagnostic: 'Discord returned an invalid channel response.',
      });
    }
  });
});
