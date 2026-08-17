/**
 * The `gitlab-account` Connected Account runtime (`SCM.md` §4.1).
 *
 * GitLab authenticates a personal access token as a bearer credential against a
 * configured deployment. The deployment is explicit non-secret Connected Account
 * configuration carrying `semantic: 'connectedAccountOrigin'`, so the host — not
 * this plugin — normalizes it, admits it at HostAccess, and republishes it as
 * the account's `connectedAccountOrigins`.
 *
 * This runtime deliberately admits every usable origin, including a
 * self-managed one. Which deployments a *feature* may read is that feature's
 * admission decision: the Triage source stops a non-`gitlab.com` deployment at
 * its own V1 admission check, before any item call, and refusing the connection
 * here would make that check unreachable and the failure unattributable.
 *
 * Confirmation is one minimal authenticated read of the token's own account. No
 * token, header, response body, or provider payload ever leaves this module;
 * only the observed username and the deployment host reach the connection label.
 */

import type {
  ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
  ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  ConnectedAccountManualCompletion as PluginConnectedAccountManualCompletion,
  ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { normalizeGitlabConfiguredBaseUrl } from '../triage/origin.js';

/** The one configuration field carrying this account's declared deployment. */
export const GITLAB_ORIGIN_CONFIGURATION_FIELD = 'baseUrl';
/** The single manual mode: GitLab issues no other credential for API reads. */
export const GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID = 'personal-access-token';
export const GITLAB_TOKEN_CREDENTIAL_KEY = 'token';

export const GITLAB_ACCOUNT_FAILURE_CODES = Object.freeze({
  tokenInvalid: 'gitlab_token_invalid',
  insufficientPermission: 'gitlab_insufficient_permission',
  originUndeclared: 'gitlab_origin_undeclared',
  rateLimited: 'gitlab_rate_limited',
  verificationUnavailable: 'gitlab_verification_unavailable',
  verificationUnknown: 'gitlab_verification_unknown',
});

/** The documented endpoint that returns the authenticated account, and nothing else. */
const GITLAB_CONFIRMATION_PATH = '/api/v4/user';
const EMPTY_HTTP_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

type GitlabReadContext = Parameters<PluginConnectedAccountRuntime['status']>[0];

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

type GitlabConfiguredDeployment = Readonly<{
  /** Scheme, host and non-default port — what a materialization request names. */
  origin: string;
  /** Origin plus any configured path prefix — what an API route is built from. */
  normalized: string;
  host: string;
}>;

/**
 * Reads the exact declared deployment from this account's own configuration.
 * There is no fallback: an account without a declared base URL has no route,
 * and defaulting to `gitlab.com` because a host looks familiar is how a
 * credential reaches a deployment its owner never named.
 */
function readConfiguredDeployment(
  configuration: Readonly<{ values: Readonly<Record<string, unknown>> }>,
): GitlabConfiguredDeployment | null {
  const configured = configuration.values[GITLAB_ORIGIN_CONFIGURATION_FIELD];
  if (typeof configured !== 'string') return null;
  const normalized = normalizeGitlabConfiguredBaseUrl(configured);
  if (normalized === null) return null;
  return {
    origin: normalized.origin,
    normalized: normalized.normalized,
    host: normalized.forgeHostId,
  };
}

type GitlabConfirmation =
  | Readonly<{ status: 'confirmed'; username: string; host: string }>
  | Readonly<{
    status: 'rejected' | 'unavailable';
    diagnostic: ReturnType<typeof diagnostic>;
  }>;

function readConfirmedUsername(body: Uint8Array): string | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    const username = record.username;
    const id = record.id;
    if (typeof username !== 'string' || username.trim() === '') return null;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null;
    return username.trim();
  } catch {
    return null;
  }
}

async function confirmGitlabIdentity(
  input: Readonly<{ token: string; deployment: GitlabConfiguredDeployment }>,
  context: Pick<PluginConnectedAccountAuthenticationContext, 'services' | 'signal'>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<GitlabConfirmation> {
  const signal = options?.signal ?? context.signal;
  let response: Awaited<ReturnType<typeof context.services.http.request>>;
  try {
    response = await context.services.http.request({
      url: `${input.deployment.normalized}${GITLAB_CONFIRMATION_PATH}`,
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.token}` },
      // A redirect is refused rather than followed: following one would send
      // this credential to whatever host the response named.
      redirect: 'error',
    }, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        GITLAB_ACCOUNT_FAILURE_CODES.verificationUnavailable,
        'GitLab could not be reached to confirm this connection.',
      ),
    };
  }

  if (response.status === 401) {
    return {
      status: 'rejected',
      diagnostic: diagnostic(
        GITLAB_ACCOUNT_FAILURE_CODES.tokenInvalid,
        'GitLab rejected this personal access token.',
      ),
    };
  }
  if (response.status === 403) {
    return {
      status: 'rejected',
      diagnostic: diagnostic(
        GITLAB_ACCOUNT_FAILURE_CODES.insufficientPermission,
        'This GitLab token is missing the read_api capability.',
      ),
    };
  }
  if (response.status === 429) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        GITLAB_ACCOUNT_FAILURE_CODES.rateLimited,
        'GitLab is rate limiting this connection; try again shortly.',
      ),
    };
  }
  if (response.status === 404 || response.status >= 500) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        GITLAB_ACCOUNT_FAILURE_CODES.verificationUnavailable,
        'GitLab could not be reached to confirm this connection.',
      ),
    };
  }
  if (response.status !== 200) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        GITLAB_ACCOUNT_FAILURE_CODES.verificationUnknown,
        'GitLab returned an unrecognized confirmation response.',
      ),
    };
  }

  const username = readConfirmedUsername(response.body);
  return username === null
    ? {
      status: 'unavailable',
      diagnostic: diagnostic(
        GITLAB_ACCOUNT_FAILURE_CODES.verificationUnknown,
        'GitLab returned an unrecognized confirmation response.',
      ),
    }
    : { status: 'confirmed', username, host: input.deployment.host };
}

/** Names the observed account and the deployment it was observed on. */
function connectionDisplayName(input: Readonly<{ username: string; host: string }>): string {
  return `@${input.username} · ${input.host}`;
}

async function completeManualConnection(
  input: PluginConnectedAccountManualCompletion,
  context: PluginConnectedAccountAuthenticationContext,
  options?: Readonly<{ signal?: AbortSignal }>,
) {
  const token = input.fields[GITLAB_TOKEN_CREDENTIAL_KEY]?.trim() ?? '';
  if (token === '') {
    return {
      status: 'rejected' as const,
      diagnostic: diagnostic(
        GITLAB_ACCOUNT_FAILURE_CODES.tokenInvalid,
        'GitLab requires a personal access token with at least the read_api scope.',
      ),
    };
  }
  const deployment = readConfiguredDeployment(context.configuration);
  if (deployment === null) {
    return {
      status: 'rejected' as const,
      diagnostic: diagnostic(
        GITLAB_ACCOUNT_FAILURE_CODES.originUndeclared,
        'This GitLab connection declares no deployment to reach.',
      ),
    };
  }

  const confirmation = await confirmGitlabIdentity({ token, deployment }, context, options);
  if (confirmation.status !== 'confirmed') return confirmation;

  await context.attemptCredentials.set(GITLAB_TOKEN_CREDENTIAL_KEY, token, options);
  return {
    status: 'connected' as const,
    displayName: connectionDisplayName(confirmation),
    // GitLab does not echo a token's scopes on this endpoint. Declaring scopes
    // the API never reported would be an unverifiable capability claim; the
    // first real operation returns the true answer.
    scopes: [],
  };
}

async function readHealth(
  context: GitlabReadContext,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginConnectedAccountHealthResult> {
  const deployment = readConfiguredDeployment(context.configuration);
  if (deployment === null) {
    return {
      status: 'reconnectRequired',
      diagnostic: diagnostic(
        GITLAB_ACCOUNT_FAILURE_CODES.originUndeclared,
        'This GitLab connection declares no deployment to reach.',
      ),
    };
  }
  const token = (await context.credentials.get(GITLAB_TOKEN_CREDENTIAL_KEY, options))?.trim() ?? '';
  if (token === '') {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        GITLAB_ACCOUNT_FAILURE_CODES.tokenInvalid,
        'GitLab credentials are unavailable; reconnect the account.',
      ),
    };
  }
  const confirmation = await confirmGitlabIdentity({ token, deployment }, context, options);
  if (confirmation.status === 'confirmed') {
    return { status: 'connected', displayName: connectionDisplayName(confirmation) };
  }
  return confirmation.status === 'rejected'
    ? { status: 'reconnectRequired', diagnostic: confirmation.diagnostic }
    : { status: 'unavailable', diagnostic: confirmation.diagnostic };
}

const gitlabConnectedAccountRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      [GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID]: {
        kind: 'manual',
        complete: completeManualConnection,
      },
    },
  },
  async refresh(context, options) {
    // A pasted personal access token has no refresh exchange. Reporting current
    // health is the honest answer rather than a rotation it never has.
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
      throw new Error('GitLab connected accounts support HTTP-header materialization only');
    }
    const deployment = readConfiguredDeployment(context.configuration);
    if (deployment === null || request.origin !== deployment.origin) {
      throw new Error('GitLab connected accounts cannot materialize credentials for this origin');
    }
    if (!request.headerNames.some((name) => name.toLowerCase() === 'authorization')) {
      return { kind: 'httpHeaders', headers: EMPTY_HTTP_HEADERS };
    }
    const token = (await context.credentials.get(GITLAB_TOKEN_CREDENTIAL_KEY, options))?.trim()
      ?? '';
    if (token === '') {
      throw new Error('GitLab connected-account credentials are unavailable');
    }
    return { kind: 'httpHeaders', headers: { Authorization: `Bearer ${token}` } };
  },
};

export const gitlabConnectedAccountRuntime = Object.freeze(
  gitlabConnectedAccountRuntimeDefinition,
);
