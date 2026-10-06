import type {
  ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

type ConnectedAccountCredentialReader =
  Parameters<PluginConnectedAccountRuntime['status']>[0]['credentials'];

const TOKEN_CREDENTIAL_KEY = 'token';
const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';

// Input admission only: retained credentials stay readable without revalidation.
export const ANTHROPIC_API_KEY_INPUT_SCHEMA = Object.freeze({
  type: 'string', minLength: 1, pattern: '^\\s*sk-ant-[A-Za-z0-9_-]+\\s*$',
} as const);

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

async function readToken(credentials: ConnectedAccountCredentialReader): Promise<string> {
  return (await credentials.get(TOKEN_CREDENTIAL_KEY))?.trim() ?? '';
}

async function readHealth(
  credentials: ConnectedAccountCredentialReader,
): Promise<PluginConnectedAccountHealthResult> {
  return await readToken(credentials)
    ? { status: 'connected', displayName: 'Anthropic API key', scopes: [] }
    : {
        status: 'unavailable',
        diagnostic: diagnostic(
          'anthropic_api_key_unavailable',
          'The Anthropic API key is unavailable; reconnect the account.',
        ),
      };
}

function isExactAnthropicOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.origin === value && parsed.origin === ANTHROPIC_ORIGIN;
  } catch {
    return false;
  }
}

const anthropicConnectedAccountRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      'api-key': {
        kind: 'manual',
        async complete(input, context) {
          const token = input.fields.token?.trim() ?? '';
          if (!new RegExp(ANTHROPIC_API_KEY_INPUT_SCHEMA.pattern).test(token)) {
            return {
              status: 'rejected',
              diagnostic: diagnostic(
                'anthropic_api_key_invalid',
                'Enter an Anthropic API key beginning with sk-ant-.',
              ),
            };
          }
          const signal = context.signal;
          let response: Awaited<ReturnType<typeof context.services.http.request>>;
          try {
            // Authentication-only read; no model inference or billable prompt.
            response = await context.services.http.request({
              url: `${ANTHROPIC_ORIGIN}/v1/models`, method: 'GET',
              headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
              redirect: 'error',
            }, { signal });
          } catch (error) {
            if (signal.aborted) throw error;
            return { status: 'unavailable', diagnostic: diagnostic(
              'anthropic_api_key_verification_unavailable',
              'Could not verify the Anthropic key. Retry when the service is available.',
            ) };
          }
          signal.throwIfAborted();
          if (response.status === 401 || response.status === 403) {
            return { status: 'rejected', diagnostic: diagnostic(
              'anthropic_api_key_rejected',
              'Anthropic rejected this key. Retry with an active API key.',
            ) };
          }
          if (response.status !== 200) {
            return { status: 'unavailable', diagnostic: diagnostic(
              'anthropic_api_key_verification_unavailable',
              'Could not verify the Anthropic key. Retry when the service is available.',
            ) };
          }
          await context.attemptCredentials.set(TOKEN_CREDENTIAL_KEY, token, { signal });
          return {
            status: 'connected',
            ...(context.attempt.kind === 'reconnect'
              ? { accountId: context.attempt.account.accountId }
              : {}),
            displayName: 'Anthropic API key',
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
    if (!token) throw new Error('Anthropic connected-account credentials are unavailable');
    if (request.kind === 'environment') {
      const env: Record<string, string> = {};
      if (request.keys.includes('ANTHROPIC_API_KEY')) env.ANTHROPIC_API_KEY = token;
      return {
        kind: 'environment',
        env,
      };
    }
    if (request.kind === 'httpHeaders') {
      if (!isExactAnthropicOrigin(request.origin)) {
        throw new Error('Anthropic connected accounts cannot materialize credentials for this origin');
      }
      const headers: Record<string, string> = {};
      if (request.headerNames.some((name) => name.toLowerCase() === 'x-api-key')) {
        headers['x-api-key'] = token;
      }
      return {
        kind: 'httpHeaders',
        headers,
      };
    }
    throw new Error('Anthropic connected accounts do not support file materialization');
  },
};

export const anthropicConnectedAccountRuntime: PluginConnectedAccountRuntime = Object.freeze(
  anthropicConnectedAccountRuntimeDefinition,
);
