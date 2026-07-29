import type {
  PluginConnectedAccountCredentialReader,
  PluginConnectedAccountHealthResult,
  PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/runtime';

const TOKEN_CREDENTIAL_KEY = 'token';
const OPENAI_ORIGIN = 'https://api.openai.com';

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

async function readToken(credentials: PluginConnectedAccountCredentialReader): Promise<string> {
  return (await credentials.get(TOKEN_CREDENTIAL_KEY))?.trim() ?? '';
}

async function readHealth(
  credentials: PluginConnectedAccountCredentialReader,
): Promise<PluginConnectedAccountHealthResult> {
  return await readToken(credentials)
    ? { status: 'connected', displayName: 'OpenAI API key', scopes: [] }
    : {
        status: 'unavailable',
        diagnostic: diagnostic(
          'openai_api_key_unavailable',
          'The OpenAI API key is unavailable; reconnect the account.',
        ),
      };
}

function isExactOrigin(value: string, expected: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.origin === value && parsed.origin === expected;
  } catch {
    return false;
  }
}

const openAiConnectedAccountRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      'api-key': {
        kind: 'manual',
        async complete(input, context) {
          const token = input.fields.token?.trim() ?? '';
          if (!token) {
            return {
              status: 'rejected',
              diagnostic: diagnostic(
                'openai_api_key_invalid',
                'OpenAI requires a non-empty API key.',
              ),
            };
          }
          await context.attemptCredentials.set(TOKEN_CREDENTIAL_KEY, token);
          return {
            status: 'connected',
            ...(context.attempt.kind === 'reconnect'
              ? { accountId: context.attempt.account.accountId }
              : {}),
            displayName: 'OpenAI API key',
            scopes: [],
          };
        },
      },
    },
  },
  async refresh(context) {
    return readHealth(context.credentials);
  },
  async revoke() {
    return { status: 'remoteUnsupported' };
  },
  async status(context) {
    return readHealth(context.credentials);
  },
  async materialize(request, context) {
    const token = await readToken(context.credentials);
    if (!token) throw new Error('OpenAI connected-account credentials are unavailable');
    if (request.kind === 'environment') {
      const env: Record<string, string> = {};
      if (request.keys.includes('OPENAI_API_KEY')) env.OPENAI_API_KEY = token;
      return {
        kind: 'environment',
        env,
      };
    }
    if (request.kind === 'httpHeaders') {
      if (!isExactOrigin(request.origin, OPENAI_ORIGIN)) {
        throw new Error('OpenAI connected accounts cannot materialize credentials for this origin');
      }
      const headers: Record<string, string> = {};
      if (request.headerNames.some((name) => name.toLowerCase() === 'authorization')) {
        headers.Authorization = `Bearer ${token}`;
      }
      return {
        kind: 'httpHeaders',
        headers,
      };
    }
    throw new Error('OpenAI connected accounts do not support file materialization');
  },
};

export const openAiConnectedAccountRuntime: PluginConnectedAccountRuntime = Object.freeze(
  openAiConnectedAccountRuntimeDefinition,
);
