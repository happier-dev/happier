import type {
  ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
  ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  ConnectedAccountManualCompletion as PluginConnectedAccountManualCompletion,
  ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

import { GITHUB_API_VERSION } from '../observations/githubProviderContracts.js';

const TOKEN_CREDENTIAL_KEY = 'token';
const GITHUB_IDENTITY_URL = 'https://api.github.com/user';
const GITHUB_HTTP_ORIGINS = new Set([
  'https://api.github.com',
  'https://github.com',
]);
const EMPTY_HTTP_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

function parseScopes(headers: Readonly<Record<string, string>>): readonly string[] {
  const value = readTriageResponseHeaderV1(headers, 'x-oauth-scopes');
  if (!value) return [];
  return [...new Set(value.split(',').map((scope) => scope.trim()).filter(Boolean))];
}

type ConfirmedGithubIdentity = Readonly<{
  status: 'confirmed';
  providerAccountId: string;
  displayName: string;
  email?: string;
  scopes: readonly string[];
}>;
type GithubIdentityFailure =
  | Readonly<{
      status: 'rejected';
      diagnostic: ReturnType<typeof diagnostic>;
    }>
  | Readonly<{
      status: 'unavailable';
      diagnostic: ReturnType<typeof diagnostic>;
    }>;
type GithubConnectedAccountReadContext = Parameters<
  PluginConnectedAccountRuntime['status']
>[0];

function parseConfirmedIdentity(
  body: Uint8Array,
  headers: Readonly<Record<string, string>>,
): ConfirmedGithubIdentity | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    const providerAccountId = typeof value.id === 'number'
      && Number.isSafeInteger(value.id)
      && value.id > 0
      ? String(value.id)
      : typeof value.id === 'string' && /^[1-9][0-9]*$/.test(value.id.trim())
        ? value.id.trim()
        : '';
    const displayName = typeof value.login === 'string' ? value.login.trim() : '';
    const email = typeof value.email === 'string' ? value.email.trim() : '';
    if (!providerAccountId || !displayName) return null;
    return {
      status: 'confirmed',
      providerAccountId,
      displayName,
      ...(email ? { email } : {}),
      scopes: parseScopes(headers),
    };
  } catch {
    return null;
  }
}

async function confirmGithubIdentity(
  token: string,
  context: Pick<PluginConnectedAccountAuthenticationContext, 'services' | 'signal'>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ConfirmedGithubIdentity | GithubIdentityFailure> {
  const signal = options?.signal ?? context.signal;
  try {
    const response = await context.services.http.request({
      url: GITHUB_IDENTITY_URL,
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      redirect: 'error',
    }, { signal });
    if (response.status === 401) {
      return {
        status: 'rejected',
        diagnostic: diagnostic(
          'github_pat_rejected',
          'GitHub rejected the personal access token.',
        ),
      };
    }
    if (response.status !== 200) {
      return {
        status: 'unavailable',
        diagnostic: diagnostic(
          'github_identity_unavailable',
          'GitHub account identity could not be confirmed.',
        ),
      };
    }
    const identity = parseConfirmedIdentity(response.body, response.headers);
    return identity ?? {
      status: 'unavailable',
      diagnostic: diagnostic(
        'github_identity_invalid',
        'GitHub returned an invalid account identity response.',
      ),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'github_identity_unavailable',
        'GitHub account identity could not be confirmed.',
      ),
    };
  }
}

async function readHealth(
  context: GithubConnectedAccountReadContext,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginConnectedAccountHealthResult> {
  const token = (await context.credentials.get(TOKEN_CREDENTIAL_KEY, options))?.trim() ?? '';
  if (!token) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'github_credentials_unavailable',
        'GitHub credentials are unavailable; reconnect the account.',
      ),
    };
  }
  const identity = await confirmGithubIdentity(token, context, options);
  if (identity.status === 'rejected') {
    return {
      status: 'reconnectRequired',
      diagnostic: identity.diagnostic,
    };
  }
  if (identity.status === 'unavailable') {
    return {
      status: 'unavailable',
      diagnostic: identity.diagnostic,
    };
  }
  if (identity.status !== 'confirmed') {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'github_identity_unavailable',
        'GitHub account identity could not be confirmed.',
      ),
    };
  }
  return {
    status: 'connected',
    displayName: identity.displayName,
    scopes: identity.scopes,
  };
}

function isAllowedGithubOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && GITHUB_HTTP_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

const githubConnectedAccountRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      'fine-grained-pat': {
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
                'github_pat_invalid',
                'GitHub requires a fine-grained personal access token.',
              ),
            };
          }
          const identity = await confirmGithubIdentity(token, context, options);
          if (identity.status !== 'confirmed') return identity;
          await context.attemptCredentials.set(TOKEN_CREDENTIAL_KEY, token, options);
          return {
            status: 'connected',
            accountId: identity.providerAccountId,
            providerIdentity: {
              accountId: identity.providerAccountId,
              ...(identity.email ? { email: identity.email } : {}),
            },
            displayName: identity.displayName,
            scopes: identity.scopes,
          };
        },
      },
    },
  },
  async refresh(context, options) {
    return readHealth(context, options);
  },
  async revoke() {
    return { status: 'remoteUnsupported' };
  },
  async status(context, options) {
    return readHealth(context, options);
  },
  async materialize(request, context, options) {
    if (request.kind !== 'httpHeaders') {
      throw new Error('GitHub connected accounts support HTTP-header materialization only');
    }
    if (!isAllowedGithubOrigin(request.origin)) {
      throw new Error('GitHub connected accounts cannot materialize credentials for this origin');
    }
    if (!request.headerNames.some((name) => name.toLowerCase() === 'authorization')) {
      return { kind: 'httpHeaders', headers: EMPTY_HTTP_HEADERS };
    }
    const token = (await context.credentials.get(TOKEN_CREDENTIAL_KEY, options))?.trim() ?? '';
    if (!token) {
      throw new Error('GitHub connected-account credentials are unavailable');
    }
    return {
      kind: 'httpHeaders',
      headers: { Authorization: `Bearer ${token}` },
    };
  },
};

export const githubConnectedAccountRuntime = Object.freeze(
  githubConnectedAccountRuntimeDefinition,
);
