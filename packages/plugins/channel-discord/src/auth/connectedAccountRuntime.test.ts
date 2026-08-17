import { describe, expect, it } from 'vitest';

import { discordConnectedAccountRuntime } from './connectedAccountRuntime.js';

function jsonResponse(value: unknown, status = 200): Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}> {
  return {
    status,
    finalUrl: 'https://discord.com/api/v10/',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

describe('Discord bot Connected Account runtime', () => {
  it('stores a manual token only after Discord proves both the application and bot identities', async () => {
    const mode = discordConnectedAccountRuntime.authentication.modes['bot-token'];
    if (!mode || mode.kind !== 'manual') throw new Error('Expected the Discord manual authentication mode');
    const stored = new Map<string, string>();

    await expect(mode.complete({ fields: { token: 'bot-token' } }, {
      signal: new AbortController().signal,
      services: {
        http: {
          async request(input: Readonly<{ url: string }>) {
            if (input.url.endsWith('/oauth2/applications/@me')) {
              return jsonResponse({ id: 'application-1', name: 'Happier Discord' });
            }
            if (input.url.endsWith('/users/@me')) {
              return jsonResponse({ id: 'bot-1', username: 'Happier', bot: true });
            }
            throw new Error(`Unexpected Discord request: ${input.url}`);
          },
        },
      },
      attemptCredentials: {
        async get(key: string) { return stored.get(key) ?? null; },
        async set(key: string, value: string) { stored.set(key, value); },
        async delete(key: string) { stored.delete(key); },
      },
    } as Parameters<typeof mode.complete>[1])).resolves.toEqual({
      status: 'connected',
      accountId: 'bot:bot-1',
      providerIdentity: { accountId: 'bot-1' },
      displayName: 'Happier',
      scopes: [],
    });

    expect(stored.get('token')).toBe('bot-token');
  });

  it('does not expose the bot token through unrelated environment keys', async () => {
    await expect(discordConnectedAccountRuntime.materialize({
      kind: 'environment',
      keys: ['DISCORD_BOT_TOKEN', 'UNRELATED_KEY'],
    }, {
      credentials: {
        async get(key: string) { return key === 'token' ? 'bot-token' : null; },
      },
    } as Parameters<typeof discordConnectedAccountRuntime.materialize>[1])).resolves.toEqual({
      kind: 'environment',
      env: { DISCORD_BOT_TOKEN: 'bot-token' },
    });
  });
});
