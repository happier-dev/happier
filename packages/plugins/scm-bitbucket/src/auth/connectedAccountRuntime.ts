import type {
  PluginConnectedAccountAuthenticationContext,
  PluginConnectedAccountCredentialReader,
  PluginConnectedAccountHealthResult,
  PluginConnectedAccountManualCompletion,
  PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/runtime';

import {
  encodeBitbucketBasicAuthorization,
  readBitbucketBasicAuthCredentials,
} from './basicCredentials.js';

const IDENTITY_CREDENTIAL_KEY = 'identity';
const TOKEN_CREDENTIAL_KEY = 'token';
const BITBUCKET_HTTP_ORIGINS = new Set([
  'https://api.bitbucket.org',
  'https://bitbucket.org',
]);
const EMPTY_HTTP_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

async function readStoredCredentials(credentials: PluginConnectedAccountCredentialReader) {
  return readBitbucketBasicAuthCredentials(
    await credentials.get(IDENTITY_CREDENTIAL_KEY),
    await credentials.get(TOKEN_CREDENTIAL_KEY),
  );
}

async function readHealth(
  credentials: PluginConnectedAccountCredentialReader,
): Promise<PluginConnectedAccountHealthResult> {
  const stored = await readStoredCredentials(credentials);
  if (!stored) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'bitbucket_credentials_unavailable',
        'Bitbucket credentials are incomplete; reconnect the account.',
      ),
    };
  }
  return { status: 'connected', displayName: stored.username, scopes: [] };
}

function isAllowedBitbucketOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && BITBUCKET_HTTP_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

const bitbucketConnectedAccountRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      manual: {
        kind: 'manual',
        async complete(
          input: PluginConnectedAccountManualCompletion,
          context: PluginConnectedAccountAuthenticationContext,
        ) {
          const stored = readBitbucketBasicAuthCredentials(
            input.fields.identity,
            input.fields.token,
          );
          if (!stored) {
            return {
              status: 'rejected' as const,
              diagnostic: diagnostic(
                'bitbucket_manual_credentials_invalid',
                'Bitbucket requires both an email or username and an API token.',
              ),
            };
          }
          await context.attemptCredentials.set(IDENTITY_CREDENTIAL_KEY, stored.username);
          await context.attemptCredentials.set(TOKEN_CREDENTIAL_KEY, stored.password);
          return {
            status: 'connected' as const,
            ...(context.attempt.kind === 'reconnect'
                ? { accountId: context.attempt.account.accountId }
                : {}),
            providerIdentity: { accountId: stored.username },
            displayName: stored.username,
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
    return { status: 'remoteUnsupported' as const };
  },
  async status(context) {
    return readHealth(context.credentials);
  },
  async materialize(request, context) {
    if (request.kind !== 'httpHeaders') {
      throw new Error('Bitbucket connected accounts support HTTP-header materialization only');
    }
    if (!isAllowedBitbucketOrigin(request.origin)) {
      throw new Error('Bitbucket connected accounts cannot materialize credentials for this origin');
    }
    if (!request.headerNames.some((name) => name.toLowerCase() === 'authorization')) {
      return { kind: 'httpHeaders' as const, headers: EMPTY_HTTP_HEADERS };
    }
    const stored = await readStoredCredentials(context.credentials);
    if (!stored) {
      throw new Error('Bitbucket connected-account credentials are unavailable');
    }
    return {
      kind: 'httpHeaders' as const,
      headers: { Authorization: encodeBitbucketBasicAuthorization(stored) },
    };
  },
};

export const bitbucketConnectedAccountRuntime = Object.freeze(
  bitbucketConnectedAccountRuntimeDefinition,
);
