import { describe, expect, it, vi } from 'vitest';

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
