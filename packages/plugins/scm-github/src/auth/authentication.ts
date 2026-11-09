import type {
  ConnectedAccountPortableAuthenticationContext,
  ConnectedAccountPortableReadContext,
  ConnectedAccountPortableRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';
import { createGithubRequestHeaders } from '../observations/githubRequestHeaders.js';
import { getGithubAccountRequestOwnerV1 } from '../observations/githubApiClient.js';
import { GITHUB_API_ORIGIN } from '../observations/githubProviderContracts.js';
import { GITHUB_TOKEN_CREDENTIAL_KEY as TOKEN_CREDENTIAL_KEY, isGithubCopilotCompatibleToken } from './tokenKinds.js';
import { createGithubCopilotAuthentication } from './copilot.js';

const githubAuthenticationLifetime = {};

const GITHUB_IDENTITY_URL = 'https://api.github.com/user';

export function diagnostic(code: string, message: string) {
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
type GithubConnectedAccountReadContext = ConnectedAccountPortableReadContext;

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

export async function confirmGithubIdentity(
  token: string,
  context: Pick<ConnectedAccountPortableAuthenticationContext, 'services' | 'signal'>
    & Partial<Pick<GithubConnectedAccountReadContext, 'account'>>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ConfirmedGithubIdentity | GithubIdentityFailure> {
  const signal = options?.signal ?? context.signal;
  try {
    const account = context.account;
    const owner = getGithubAccountRequestOwnerV1({
      accountScope: account ? JSON.stringify([account.service.pluginId, account.service.localId, account.accountId]) : 'authentication',
      credentialScope: `Bearer ${token}`,
      executionOrigin: GITHUB_API_ORIGIN,
      fallbackLifetime: githubAuthenticationLifetime,
    });
    const response = await owner.request({
      url: GITHUB_IDENTITY_URL,
      method: 'GET',
      headers: createGithubRequestHeaders({ authorization: `Bearer ${token}` }),
      redirect: 'error',
    }, { signal, transport: (request, requestSignal) => context.services.http.request({
      ...request,
      redirect: request.redirect ?? 'error',
    }, { signal: requestSignal }) });
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

function manualTokenMode(copilot: boolean): Extract<NonNullable<ConnectedAccountPortableRuntime['authentication']>['modes'][string], { kind: 'manual' }> {
  return {
    kind: 'manual',
    async complete(input, context, options) {
      const token = input.fields.token?.trim() ?? '';
      if (!token || (copilot && !isGithubCopilotCompatibleToken(token))) {
        return { status: 'rejected', diagnostic: diagnostic(
          copilot ? 'github_copilot_token_unsupported' : 'github_pat_invalid',
          copilot ? 'Select a supported fine-grained, OAuth, or GitHub App user token for Copilot.' : 'GitHub requires a fine-grained personal access token.',
        ) };
      }
      const identity = await confirmGithubIdentity(token, context, options);
      if (identity.status !== 'confirmed') return identity;
      await context.attemptCredentials.set(TOKEN_CREDENTIAL_KEY, token, options);
      return {
        status: 'connected',
        credentialKind: 'token',
        accountId: identity.providerAccountId,
        providerIdentity: { accountId: identity.providerAccountId, ...(identity.email ? { email: identity.email } : {}) },
        displayName: identity.displayName,
        scopes: identity.scopes,
      };
    },
  };
}

/** One portable exchange for Account and Machine authentication attempts. */
export const githubPortableAuthentication = {
  modes: {
    'fine-grained-pat': manualTokenMode(false),
    'copilot-token': manualTokenMode(true),
    'copilot-device': createGithubCopilotAuthentication(confirmGithubIdentity),
  },
} satisfies ConnectedAccountPortableRuntime['authentication'];
