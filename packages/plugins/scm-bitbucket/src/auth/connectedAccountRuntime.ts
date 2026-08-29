/**
 * The `bitbucket-account` Connected Account runtime.
 *
 * Bitbucket Cloud authenticates an Atlassian API token as HTTP Basic against one fixed
 * deployment, `https://api.bitbucket.org/2.0`. There is no self-managed variant and no
 * configured origin, so the account carries a credential and nothing else.
 *
 * Completion and health are the SAME question — *can this credential read this account, and
 * whose account is it?* — so both are answered by one minimal authenticated read of
 * `GET /2.0/user` and neither answers it from stored bytes. Credential PRESENCE is not
 * credential health: reporting `connected` because two strings are non-empty connects an
 * account that cannot read anything, and the reader discovers it at the next scan instead of
 * in the connect flow that told them it worked.
 *
 * The account's provider identity is Bitbucket's own `uuid`, documented as the account's
 * immutable id. The typed login is a mutable display value: two people can type the same email
 * and one person can type two, so a provider identity built from it is not an identity at all.
 *
 * No token, header, response body, or provider payload leaves this module; only the observed
 * nickname reaches the connection label.
 */

import type {
  ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
  ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  ConnectedAccountManualCompletion as PluginConnectedAccountManualCompletion,
  ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { readBitbucketBracedUuid } from '../triage/identity.js';
import { buildBitbucketViewerUrl } from '../triage/viewer.js';

import {
  encodeBitbucketBasicAuthorization,
  readBitbucketBasicAuthCredentials,
  type BitbucketBasicAuthCredentials,
} from './basicCredentials.js';

type ConnectedAccountCredentialReader =
  Parameters<PluginConnectedAccountRuntime['status']>[0]['credentials'];
type BitbucketReadContext = Parameters<PluginConnectedAccountRuntime['status']>[0];

const IDENTITY_CREDENTIAL_KEY = 'identity';
const TOKEN_CREDENTIAL_KEY = 'token';
const BITBUCKET_HTTP_ORIGINS = new Set([
  'https://api.bitbucket.org',
  'https://bitbucket.org',
]);
const EMPTY_HTTP_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

export const BITBUCKET_ACCOUNT_FAILURE_CODES = Object.freeze({
  credentialsIncomplete: 'bitbucket_manual_credentials_invalid',
  credentialsUnavailable: 'bitbucket_credentials_unavailable',
  credentialsRejected: 'bitbucket_credentials_rejected',
  insufficientPermission: 'bitbucket_insufficient_permission',
  rateLimited: 'bitbucket_rate_limited',
  verificationUnavailable: 'bitbucket_verification_unavailable',
  verificationUnknown: 'bitbucket_verification_unknown',
});

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

async function readStoredCredentials(
  credentials: ConnectedAccountCredentialReader,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<BitbucketBasicAuthCredentials | null> {
  return readBitbucketBasicAuthCredentials(
    await credentials.get(IDENTITY_CREDENTIAL_KEY, options),
    await credentials.get(TOKEN_CREDENTIAL_KEY, options),
  );
}

type BitbucketAccountConfirmation =
  | Readonly<{ status: 'confirmed'; accountUuid: string; label: string }>
  | Readonly<{
    status: 'rejected' | 'unavailable';
    diagnostic: ReturnType<typeof diagnostic>;
  }>;

/**
 * Reads the confirming account from the response body.
 *
 * The `uuid` is required because it is the whole point of the read: an answer this client
 * cannot identify is an unrecognized answer, never a confirmed account. The display fields are
 * optional and are presentation only.
 */
function readConfirmedAccount(
  body: Uint8Array,
): Readonly<{ accountUuid: string; label: string }> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    const accountUuid = readBitbucketBracedUuid(record.uuid);
    if (accountUuid === null) return null;
    const nickname = typeof record.nickname === 'string' ? record.nickname.trim() : '';
    const displayName = typeof record.display_name === 'string' ? record.display_name.trim() : '';
    const label = nickname !== '' ? nickname : displayName;
    return { accountUuid, label: label === '' ? accountUuid : label };
  } catch {
    return null;
  }
}

/**
 * One minimal authenticated read of the credential's own account.
 *
 * It is the single owner of what each Bitbucket answer means, because completion and health ask
 * exactly the same question and a second classifier would eventually disagree with this one
 * about whether a reader should rotate their token or wait for the network.
 */
async function confirmBitbucketAccount(
  credentials: BitbucketBasicAuthCredentials,
  context: Pick<PluginConnectedAccountAuthenticationContext, 'services' | 'signal'>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<BitbucketAccountConfirmation> {
  const signal = options?.signal ?? context.signal;
  let response: Awaited<ReturnType<typeof context.services.http.request>>;
  try {
    response = await context.services.http.request({
      url: buildBitbucketViewerUrl(),
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: encodeBitbucketBasicAuthorization(credentials),
      },
      // A redirect is refused rather than followed: Bitbucket answers an unusable credential
      // with a redirect to a sign-in host, and following one would both deliver this credential
      // there and hand back that page as if it were the account.
      redirect: 'error',
    }, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        BITBUCKET_ACCOUNT_FAILURE_CODES.verificationUnavailable,
        'Bitbucket could not be reached to confirm this connection.',
      ),
    };
  }

  if (response.status === 401) {
    return {
      status: 'rejected',
      diagnostic: diagnostic(
        BITBUCKET_ACCOUNT_FAILURE_CODES.credentialsRejected,
        'Bitbucket rejected this Atlassian account email and API token.',
      ),
    };
  }
  if (response.status === 403) {
    return {
      status: 'rejected',
      diagnostic: diagnostic(
        BITBUCKET_ACCOUNT_FAILURE_CODES.insufficientPermission,
        'This Bitbucket API token cannot read its own account.',
      ),
    };
  }
  if (response.status === 429) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        BITBUCKET_ACCOUNT_FAILURE_CODES.rateLimited,
        'Bitbucket is rate limiting this connection; try again shortly.',
      ),
    };
  }
  if (response.status === 404 || response.status >= 500) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        BITBUCKET_ACCOUNT_FAILURE_CODES.verificationUnavailable,
        'Bitbucket could not be reached to confirm this connection.',
      ),
    };
  }
  if (response.status !== 200) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        BITBUCKET_ACCOUNT_FAILURE_CODES.verificationUnknown,
        'Bitbucket returned an unrecognized confirmation response.',
      ),
    };
  }

  const account = readConfirmedAccount(response.body);
  return account === null
    ? {
      status: 'unavailable',
      diagnostic: diagnostic(
        BITBUCKET_ACCOUNT_FAILURE_CODES.verificationUnknown,
        'Bitbucket returned an unrecognized confirmation response.',
      ),
    }
    : { status: 'confirmed', accountUuid: account.accountUuid, label: account.label };
}

async function completeManualConnection(
  input: PluginConnectedAccountManualCompletion,
  context: PluginConnectedAccountAuthenticationContext,
  options?: Readonly<{ signal?: AbortSignal }>,
) {
  const attempted = readBitbucketBasicAuthCredentials(input.fields.identity, input.fields.token);
  if (!attempted) {
    return {
      status: 'rejected' as const,
      diagnostic: diagnostic(
        BITBUCKET_ACCOUNT_FAILURE_CODES.credentialsIncomplete,
        'Bitbucket requires both your Atlassian account email and an API token.',
      ),
    };
  }

  // Proven before it is stored. A credential written first and confirmed second leaves a
  // rejected attempt's bytes behind for a later read to succeed with.
  const confirmation = await confirmBitbucketAccount(attempted, context, options);
  if (confirmation.status !== 'confirmed') return confirmation;

  await context.attemptCredentials.set(IDENTITY_CREDENTIAL_KEY, attempted.username, options);
  await context.attemptCredentials.set(TOKEN_CREDENTIAL_KEY, attempted.password, options);
  return {
    status: 'connected' as const,
    ...(context.attempt.kind === 'reconnect'
      ? { accountId: context.attempt.account.accountId }
      : {}),
    // Bitbucket's own immutable account id, not the mutable string the reader typed.
    providerIdentity: { accountId: confirmation.accountUuid },
    displayName: confirmation.label,
    // Bitbucket echoes no scope census for an API token on this endpoint. Declaring scopes the
    // API never reported would be an unverifiable capability claim.
    scopes: [],
  };
}

async function readHealth(
  context: BitbucketReadContext,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginConnectedAccountHealthResult> {
  const stored = await readStoredCredentials(context.credentials, options);
  if (!stored) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        BITBUCKET_ACCOUNT_FAILURE_CODES.credentialsUnavailable,
        'Bitbucket credentials are incomplete; reconnect the account.',
      ),
    };
  }
  const confirmation = await confirmBitbucketAccount(stored, context, options);
  if (confirmation.status === 'confirmed') {
    return { status: 'connected', displayName: confirmation.label, scopes: [] };
  }
  return confirmation.status === 'rejected'
    ? { status: 'reconnectRequired', diagnostic: confirmation.diagnostic }
    : { status: 'unavailable', diagnostic: confirmation.diagnostic };
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
        complete: completeManualConnection,
      },
    },
  },
  async refresh(context, options) {
    // A pasted API token has no refresh exchange. Reporting current health is the honest answer
    // rather than a rotation it never has.
    return readHealth(context, options);
  },
  async revoke() {
    return { status: 'remoteUnsupported' as const };
  },
  async status(context, options) {
    return readHealth(context, options);
  },
  async materialize(request, context, options) {
    if (request.kind !== 'httpHeaders') {
      throw new Error('Bitbucket connected accounts support HTTP-header materialization only');
    }
    if (!isAllowedBitbucketOrigin(request.origin)) {
      throw new Error('Bitbucket connected accounts cannot materialize credentials for this origin');
    }
    if (!request.headerNames.some((name) => name.toLowerCase() === 'authorization')) {
      return { kind: 'httpHeaders' as const, headers: EMPTY_HTTP_HEADERS };
    }
    const stored = await readStoredCredentials(context.credentials, options);
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
