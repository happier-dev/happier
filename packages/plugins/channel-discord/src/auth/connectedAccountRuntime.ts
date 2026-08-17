import type {
  ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
  ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  ConnectedAccountManualCompletion as PluginConnectedAccountManualCompletion,
  ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { createDiscordBotApi, type DiscordApiFailure, type DiscordBotIdentity } from '../discordApi.js';
import { DISCORD_BOT_TOKEN_ENVIRONMENT_KEY } from '../discordPluginConstants.js';

const DISCORD_BOT_TOKEN_CREDENTIAL_KEY = 'token';
const EMPTY_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({});

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

type ConfirmedDiscordBot = Readonly<{ status: 'confirmed'; identity: DiscordBotIdentity }>;
type DiscordBotProbeFailure = Readonly<{
  status: 'rejected' | 'unavailable';
  diagnostic: ReturnType<typeof diagnostic>;
}>;
type DiscordConnectedAccountReadContext = Parameters<PluginConnectedAccountRuntime['status']>[0];

function probeFailure(failure: DiscordApiFailure): DiscordBotProbeFailure {
  if (failure.reason === 'credentialInvalid') {
    return {
      status: 'rejected',
      diagnostic: diagnostic('discord_bot_token_rejected', 'Discord rejected the bot token.'),
    };
  }
  return {
    status: 'unavailable',
    diagnostic: diagnostic('discord_bot_identity_unavailable', 'Discord bot identity could not be confirmed.'),
  };
}

async function confirmDiscordBot(
  token: string,
  context: Pick<PluginConnectedAccountAuthenticationContext, 'services' | 'signal'>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ConfirmedDiscordBot | DiscordBotProbeFailure> {
  const identity = await createDiscordBotApi({ token, http: context.services.http }).getIdentity({
    signal: options?.signal ?? context.signal,
  });
  return 'kind' in identity ? probeFailure(identity) : { status: 'confirmed', identity };
}

async function readHealth(
  context: DiscordConnectedAccountReadContext,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginConnectedAccountHealthResult> {
  const token = (await context.credentials.get(DISCORD_BOT_TOKEN_CREDENTIAL_KEY, options))?.trim() ?? '';
  if (!token) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic('discord_bot_token_unavailable', 'Discord bot credentials are unavailable; reconnect the account.'),
    };
  }
  const result = await confirmDiscordBot(token, context, options);
  if (result.status === 'confirmed') return { status: 'connected', displayName: result.identity.botLabel, scopes: [] };
  if (result.status === 'rejected') return { status: 'reconnectRequired', diagnostic: result.diagnostic };
  return { status: 'unavailable', diagnostic: result.diagnostic };
}

const discordConnectedAccountRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      'bot-token': {
        kind: 'manual',
        async complete(
          input: PluginConnectedAccountManualCompletion,
          context: PluginConnectedAccountAuthenticationContext,
          options,
        ) {
          const token = input.fields.token?.trim() ?? '';
          if (!token) {
            return {
              status: 'rejected',
              diagnostic: diagnostic('discord_bot_token_invalid', 'Discord requires a bot token.'),
            };
          }
          const result = await confirmDiscordBot(token, context, options);
          if (result.status !== 'confirmed') return result;
          await context.attemptCredentials.set(DISCORD_BOT_TOKEN_CREDENTIAL_KEY, token, options);
          return {
            status: 'connected',
            accountId: `bot:${result.identity.botUserId}`,
            providerIdentity: { accountId: result.identity.botUserId },
            displayName: result.identity.botLabel,
            scopes: [],
          };
        },
      },
    },
  },
  async refresh(context, options) {
    return await readHealth(context, options);
  },
  async revoke() {
    return { status: 'remoteUnsupported' };
  },
  async status(context, options) {
    return await readHealth(context, options);
  },
  async materialize(request, context, options) {
    const token = (await context.credentials.get(DISCORD_BOT_TOKEN_CREDENTIAL_KEY, options))?.trim() ?? '';
    if (!token) throw new Error('Discord connected-account credentials are unavailable.');
    if (request.kind !== 'environment') {
      throw new Error('Discord connected accounts only support environment materialization.');
    }
    return {
      kind: 'environment',
      env: request.keys.includes(DISCORD_BOT_TOKEN_ENVIRONMENT_KEY)
        ? { [DISCORD_BOT_TOKEN_ENVIRONMENT_KEY]: token }
        : EMPTY_ENVIRONMENT,
    };
  },
};

export const discordConnectedAccountRuntime = Object.freeze(discordConnectedAccountRuntimeDefinition);
