import type {
  ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
  ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  ConnectedAccountManualCompletion as PluginConnectedAccountManualCompletion,
  ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { createTelegramBotApi, type TelegramBotIdentity } from '../telegramBotApi.js';
import {
  TELEGRAM_BOT_TOKEN_ENVIRONMENT_KEY,
} from '../constants.js';

const TELEGRAM_BOT_TOKEN_CREDENTIAL_KEY = 'token';
const TELEGRAM_BOT_API_ORIGIN = 'https://api.telegram.org';
const EMPTY_HTTP_HEADERS: Readonly<Record<string, string>> = Object.freeze({});
const EMPTY_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({});

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

type ConfirmedTelegramBot = Readonly<{
  status: 'confirmed';
  identity: TelegramBotIdentity;
}>;
type TelegramBotProbeFailure = Readonly<{
  status: 'rejected' | 'unavailable';
  diagnostic: ReturnType<typeof diagnostic>;
}>;
type TelegramConnectedAccountReadContext = Parameters<PluginConnectedAccountRuntime['status']>[0];

function isAllowedTelegramOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && parsed.origin === TELEGRAM_BOT_API_ORIGIN;
  } catch {
    return false;
  }
}

async function confirmTelegramBot(
  token: string,
  context: Pick<PluginConnectedAccountAuthenticationContext, 'services' | 'signal'>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ConfirmedTelegramBot | TelegramBotProbeFailure> {
  const result = await createTelegramBotApi({ token, http: context.services.http }).getMe({
    signal: options?.signal ?? context.signal,
  });
  if (!('kind' in result)) return { status: 'confirmed', identity: result };
  if (result.kind === 'notReady' && result.reason === 'credentialInvalid') {
    return {
      status: 'rejected',
      diagnostic: diagnostic('telegram_bot_token_rejected', 'Telegram rejected the bot token.'),
    };
  }
  return {
    status: 'unavailable',
    diagnostic: diagnostic(
      'telegram_bot_identity_unavailable',
      'Telegram bot identity could not be confirmed.',
    ),
  };
}

async function readHealth(
  context: TelegramConnectedAccountReadContext,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginConnectedAccountHealthResult> {
  const token = (await context.credentials.get(TELEGRAM_BOT_TOKEN_CREDENTIAL_KEY, options))?.trim() ?? '';
  if (!token) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'telegram_bot_token_unavailable',
        'Telegram bot credentials are unavailable; reconnect the account.',
      ),
    };
  }
  const result = await confirmTelegramBot(token, context, options);
  if (result.status === 'confirmed') {
    return { status: 'connected', displayName: result.identity.displayName, scopes: [] };
  }
  if (result.status === 'rejected') {
    return { status: 'reconnectRequired', diagnostic: result.diagnostic };
  }
  return { status: 'unavailable', diagnostic: result.diagnostic };
}

const telegramConnectedAccountRuntimeDefinition: PluginConnectedAccountRuntime = {
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
              diagnostic: diagnostic(
                'telegram_bot_token_invalid',
                'Telegram requires a bot token.',
              ),
            };
          }
          const result = await confirmTelegramBot(token, context, options);
          if (result.status !== 'confirmed') return result;
          await context.attemptCredentials.set(TELEGRAM_BOT_TOKEN_CREDENTIAL_KEY, token, options);
          return {
            status: 'connected',
            accountId: `bot:${result.identity.id}`,
            providerIdentity: { accountId: result.identity.id },
            displayName: result.identity.displayName,
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
    const token = (await context.credentials.get(TELEGRAM_BOT_TOKEN_CREDENTIAL_KEY, options))?.trim() ?? '';
    if (!token) throw new Error('Telegram connected-account credentials are unavailable');
    if (request.kind === 'environment') {
      return {
        kind: 'environment',
        env: request.keys.includes(TELEGRAM_BOT_TOKEN_ENVIRONMENT_KEY)
          ? { [TELEGRAM_BOT_TOKEN_ENVIRONMENT_KEY]: token }
          : EMPTY_ENVIRONMENT,
      };
    }
    if (request.kind !== 'httpHeaders') {
      throw new Error('Telegram connected accounts do not support file materialization');
    }
    if (!isAllowedTelegramOrigin(request.origin)) {
      throw new Error('Telegram connected accounts cannot materialize credentials for this origin');
    }
    // Telegram uses an authorization path segment, which is intentionally never
    // exposed through generic header materialization.
    return { kind: 'httpHeaders', headers: EMPTY_HTTP_HEADERS };
  },
};

export const telegramConnectedAccountRuntime = Object.freeze(
  telegramConnectedAccountRuntimeDefinition,
);
