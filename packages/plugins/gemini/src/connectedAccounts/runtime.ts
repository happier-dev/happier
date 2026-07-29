import type {
  PluginConnectedAccountCredentialReader,
  PluginConnectedAccountHealthResult,
  PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/runtime';

const API_KEY_CREDENTIAL_KEY = 'apiKey';
const SERVICE_ACCOUNT_CREDENTIAL_KEY = 'serviceAccountJson';
const SERVICE_ACCOUNT_FILE_ID = 'google-service-account.json';
const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com';

type GeminiServiceAccount = Readonly<{
  type: 'service_account';
  client_id: string;
  client_email: string;
  project_id: string;
}> & Readonly<Record<string, unknown>>;

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

function parseServiceAccount(value: string): GeminiServiceAccount | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.type !== 'service_account'
      || typeof parsed.client_id !== 'string'
      || !/^[0-9]+$/u.test(parsed.client_id.trim())
      || typeof parsed.client_email !== 'string'
      || !parsed.client_email.trim()
      || typeof parsed.project_id !== 'string'
      || !parsed.project_id.trim()
      || typeof parsed.private_key !== 'string'
      || !parsed.private_key.trim()
    ) {
      return null;
    }
    return {
      ...parsed,
      type: 'service_account',
      client_id: parsed.client_id.trim(),
      client_email: parsed.client_email.trim(),
      project_id: parsed.project_id.trim(),
    };
  } catch {
    return null;
  }
}

async function readCredential(
  credentials: PluginConnectedAccountCredentialReader,
  key: string,
): Promise<string> {
  return (await credentials.get(key))?.trim() ?? '';
}

async function readHealth(
  modeId: string,
  credentials: PluginConnectedAccountCredentialReader,
): Promise<PluginConnectedAccountHealthResult> {
  if (modeId === 'api-key') {
    return await readCredential(credentials, API_KEY_CREDENTIAL_KEY)
      ? { status: 'connected', displayName: 'Gemini API key', scopes: [] }
      : {
          status: 'unavailable',
          diagnostic: diagnostic(
            'gemini_api_key_unavailable',
            'The Gemini API key is unavailable; reconnect the account.',
          ),
        };
  }
  if (modeId === 'service-account') {
    const serviceAccount = parseServiceAccount(
      await readCredential(credentials, SERVICE_ACCOUNT_CREDENTIAL_KEY),
    );
    return serviceAccount
      ? {
          status: 'connected',
          displayName: serviceAccount.client_email,
          scopes: [],
        }
      : {
          status: 'unavailable',
          diagnostic: diagnostic(
            'gemini_service_account_unavailable',
            'The Gemini service-account credential is unavailable; reconnect the account.',
          ),
        };
  }
  return {
    status: 'unavailable',
    diagnostic: diagnostic(
      'gemini_authentication_mode_invalid',
      'The Gemini account authentication mode is unavailable.',
    ),
  };
}

function modeId(context: Parameters<PluginConnectedAccountRuntime['status']>[0]): string {
  return context.configuration.target.modeId;
}

function isExactGeminiOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.origin === value && parsed.origin === GEMINI_API_ORIGIN;
  } catch {
    return false;
  }
}

const geminiConnectedAccountRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      'api-key': {
        kind: 'manual',
        async complete(input, context) {
          const apiKey = input.fields.token?.trim() ?? '';
          if (!apiKey) {
            return {
              status: 'rejected',
              diagnostic: diagnostic(
                'gemini_api_key_invalid',
                'Gemini requires a non-empty API key.',
              ),
            };
          }
          await context.attemptCredentials.set(API_KEY_CREDENTIAL_KEY, apiKey);
          return {
            status: 'connected',
            ...(context.attempt.kind === 'reconnect'
              ? { accountId: context.attempt.account.accountId }
              : {}),
            displayName: 'Gemini API key',
            scopes: [],
          };
        },
      },
      'service-account': {
        kind: 'manual',
        async complete(input, context) {
          const serviceAccount = parseServiceAccount(input.fields.credentialsJson ?? '');
          if (!serviceAccount) {
            return {
              status: 'rejected',
              diagnostic: diagnostic(
                'gemini_service_account_invalid',
                'Gemini requires a valid Google service-account JSON credential.',
              ),
            };
          }
          await context.attemptCredentials.set(
            SERVICE_ACCOUNT_CREDENTIAL_KEY,
            JSON.stringify(serviceAccount),
          );
          return {
            status: 'connected',
            accountId: serviceAccount.client_id,
            providerIdentity: {
              email: serviceAccount.client_email,
            },
            displayName: serviceAccount.client_email,
            scopes: [],
          };
        },
      },
    },
  },
  async refresh(context) {
    return readHealth(modeId(context), context.credentials);
  },
  async revoke() {
    return { status: 'remoteUnsupported' };
  },
  async status(context) {
    return readHealth(modeId(context), context.credentials);
  },
  async materialize(request, context) {
    const authenticationModeId = modeId(context);
    if (authenticationModeId === 'api-key') {
      const apiKey = await readCredential(context.credentials, API_KEY_CREDENTIAL_KEY);
      if (!apiKey) throw new Error('Gemini connected-account API key is unavailable');
      if (request.kind === 'files') {
        return { kind: 'files', files: {} };
      }
      if (request.kind === 'environment') {
        const env: Record<string, string> = {};
        if (request.keys.includes('GEMINI_API_KEY')) env.GEMINI_API_KEY = apiKey;
        if (request.keys.includes('GOOGLE_API_KEY')) env.GOOGLE_API_KEY = apiKey;
        return { kind: 'environment', env };
      }
      if (request.kind === 'httpHeaders') {
        if (!isExactGeminiOrigin(request.origin)) {
          throw new Error('Gemini connected accounts cannot materialize credentials for this origin');
        }
        const headers: Record<string, string> = {};
        if (request.headerNames.some((name) => name.toLowerCase() === 'x-goog-api-key')) {
          headers['x-goog-api-key'] = apiKey;
        }
        return {
          kind: 'httpHeaders',
          headers,
        };
      }
      throw new Error('Gemini API-key accounts do not support this materialization');
    }
    if (authenticationModeId === 'service-account') {
      const value = await readCredential(context.credentials, SERVICE_ACCOUNT_CREDENTIAL_KEY);
      const serviceAccount = parseServiceAccount(value);
      if (!serviceAccount) {
        throw new Error('Gemini service-account credentials are unavailable');
      }
      if (request.kind === 'files') {
        const files: Record<string, Uint8Array> = {};
        if (request.fileIds.includes(SERVICE_ACCOUNT_FILE_ID)) {
          files[SERVICE_ACCOUNT_FILE_ID] = new TextEncoder().encode(value);
        }
        return { kind: 'files', files };
      }
      if (request.kind === 'environment') {
        const available: Readonly<Record<string, string>> = {
          GOOGLE_GENAI_USE_VERTEXAI: '1',
          GOOGLE_CLOUD_PROJECT: serviceAccount.project_id,
          GOOGLE_CLOUD_LOCATION: 'global',
        };
        const env: Record<string, string> = {};
        for (const key of request.keys) {
          const valueForKey = available[key];
          if (valueForKey) env[key] = valueForKey;
        }
        return { kind: 'environment', env };
      }
      throw new Error('Gemini service accounts do not support HTTP-header materialization');
    }
    throw new Error('Gemini connected-account authentication mode is unavailable');
  },
};

export const geminiConnectedAccountRuntime: PluginConnectedAccountRuntime = Object.freeze(
  geminiConnectedAccountRuntimeDefinition,
);
