import type {
  ConnectedAccountAuthenticationContext,
  ConnectedAccountCredentialStore,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { telegramConnectedAccountRuntime } from './connectedAccountRuntime.js';

/**
 * The manual mode consumes exactly two boundaries: the HTTP client and the
 * attempt credential store. The host stamps the rest of the authentication
 * context (`service`, `attempt`, `configuration`) and this unit never reads it,
 * so those members are supplied by one documented cast rather than restated as
 * a second fixture of the host contract.
 */
function authenticationContext(input: Readonly<{
  http: Partial<PluginInvocationContext['services']['http']>;
  attemptCredentials: ConnectedAccountCredentialStore;
}>): ConnectedAccountAuthenticationContext {
  return {
    plugin: { id: 'happier.channel.telegram', version: '0.0.0' },
    contribution: {
      id: 'telegram-bot',
      qualifiedId: 'happier.channel.telegram/connectedAccountDescriptors/telegram-bot',
    },
    surface: 'plugin',
    signal: new AbortController().signal,
    services: { http: input.http },
    attemptCredentials: input.attemptCredentials,
  } as unknown as ConnectedAccountAuthenticationContext;
}

function jsonResponse(value: unknown, status = 200): Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}> {
  return {
    status,
    finalUrl: 'https://api.telegram.org/',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

describe('Telegram connected account runtime', () => {
  it('verifies a manual bot token with getMe before storing its immutable bot identity', async () => {
    const mode = telegramConnectedAccountRuntime.authentication.modes['bot-token'];
    if (!mode || mode.kind !== 'manual') throw new Error('Expected the Telegram manual authentication mode');
    const stored = new Map<string, string>();

    await expect(mode.complete({ fields: { token: '123:bot-token' } }, authenticationContext({
      http: {
        async request() {
          return jsonResponse({
            ok: true,
            result: {
              id: 123,
              is_bot: true,
              first_name: 'Happier Bot',
              username: 'HappierBot',
              can_read_all_group_messages: false,
            },
          });
        },
      },
      attemptCredentials: {
        async get(key: string) { return stored.get(key) ?? null; },
        async set(key: string, value: string) { stored.set(key, value); },
        async delete(key: string) { stored.delete(key); },
      },
    }))).resolves.toEqual({
      status: 'connected',
      accountId: 'bot:123',
      providerIdentity: { accountId: '123' },
      displayName: 'Happier Bot',
      scopes: [],
    });
    expect(stored.get('token')).toBe('123:bot-token');
  });

  it('rejects an invalid bot token instead of storing it', async () => {
    const mode = telegramConnectedAccountRuntime.authentication.modes['bot-token'];
    if (!mode || mode.kind !== 'manual') throw new Error('Expected the Telegram manual authentication mode');
    const stored = new Map<string, string>();

    await expect(mode.complete({ fields: { token: 'invalid-token' } }, authenticationContext({
      http: {
        async request() {
          return jsonResponse({
            ok: false,
            error_code: 401,
            description: 'Unauthorized',
          }, 401);
        },
      },
      attemptCredentials: {
        async get(key: string) { return stored.get(key) ?? null; },
        async set(key: string, value: string) { stored.set(key, value); },
        async delete(key: string) { stored.delete(key); },
      },
    }))).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: { code: 'telegram_bot_token_rejected' },
    });
    expect(stored.size).toBe(0);
  });

  it('materializes the bot token only for the declared Telegram environment key', async () => {
    const materialized = await telegramConnectedAccountRuntime.materialize({
      kind: 'environment',
      keys: ['TELEGRAM_BOT_TOKEN', 'UNRELATED_KEY'],
    }, {
      credentials: {
        async get(key: string) {
          return key === 'token' ? '123:bot-token' : null;
        },
      },
    } as Parameters<typeof telegramConnectedAccountRuntime.materialize>[1]);

    expect(materialized).toEqual({
      kind: 'environment',
      env: { TELEGRAM_BOT_TOKEN: '123:bot-token' },
    });
  });
});
