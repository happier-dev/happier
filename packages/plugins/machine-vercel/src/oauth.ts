import {
  isPluginError,
  projectActionFailureCauseV1,
  withActionFailureDiagnostic,
} from '@happier-dev/plugin-sdk/errors';
import type {
  ConnectedAccountAuthCompletionResult,
  ConnectedAccountAuthenticationContext,
  ConnectedAccountAuthenticationModeRuntime,
  ConnectedAccountCredentialStore,
  ConnectedAccountHealthResult,
  ConnectedAccountMutationContext,
  ConnectedAccountReadContext,
  ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';
import {
  diagnostic,
  discover,
  object,
  origin,
  parseBody,
  probe,
  scopeOf,
  stageToken,
  validToken,
} from './probe.js';

/**
 * Sign in with Vercel as a public PKCE client (token endpoint auth `none`):
 * every grant sends `client_id` only. Contract read 2026-11-18 from
 * https://vercel.com/.well-known/openid-configuration and
 * https://vercel.com/docs/sign-in-with-vercel. Access tokens last 1 h and
 * refresh tokens rotate; `prompt=consent` forces consent again.
 */
export const VERCEL_OAUTH_ISSUER = 'https://vercel.com';
export const VERCEL_IDENTITY_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
] as const;
const tokenUrl = `${origin}/login/oauth/token`;
const userinfoUrl = `${origin}/login/oauth/userinfo`;
const revokeUrl = `${origin}/login/oauth/token/revoke`;

type Context =
  | ConnectedAccountAuthenticationContext
  | ConnectedAccountReadContext;
type Failure = Extract<
  ConnectedAccountAuthCompletionResult,
  { status: 'rejected' | 'unavailable' | 'outcomeUnknown' }
>;
type Identity = Readonly<{ subject: string; email: string | null }>;

class OAuthFailure extends Error {
  constructor(readonly result: Failure) {
    super(result.diagnostic.code);
  }
}
function reconnect(
  message = 'Vercel rejected this sign-in. Reconnect the account.',
): Failure {
  return {
    status: 'rejected',
    diagnostic: diagnostic('vercel_oauth_reconnect_required', message),
  };
}
function unavailable(): Failure {
  return {
    status: 'unavailable',
    diagnostic: diagnostic(
      'vercel_oauth_unavailable',
      'Vercel could not verify this sign-in. Try again.',
    ),
  };
}
function signalOf(context: Pick<Context, 'signal'>, signal?: AbortSignal) {
  return signal ? AbortSignal.any([context.signal, signal]) : context.signal;
}

/** The grant's client: retained from its attempt, or this Home's advertised public client when beginning. */
async function client(
  context: Context,
  store: Pick<ConnectedAccountCredentialStore, 'get'>,
  signal: AbortSignal,
  beginning = false,
) {
  if (context.configuration.target.modeId !== 'oauth')
    throw new OAuthFailure(reconnect());
  const retained = await store.get('oauthClientId', { signal });
  signal.throwIfAborted();
  if (retained !== null) {
    if (!validToken(retained))
      throw new OAuthFailure(
        reconnect('Reconnect Vercel to restore the sign-in client.'),
      );
    return { clientId: retained, scopes: [...VERCEL_IDENTITY_SCOPES] };
  }
  if (!beginning)
    throw new OAuthFailure(
      reconnect('Reconnect Vercel to restore the sign-in client.'),
    );
  const selected = await context.configuration.getPublicOAuthClient?.({
    signal,
  });
  signal.throwIfAborted();
  if (!selected || !validToken(selected.clientId)) {
    throw new OAuthFailure({
      status: 'unavailable',
      diagnostic: diagnostic(
        'vercel_oauth_public_client_unavailable',
        'This Home does not offer Sign in with Vercel. Connect with an access token instead.',
      ),
    });
  }
  return {
    clientId: selected.clientId,
    scopes: [...new Set([...VERCEL_IDENTITY_SCOPES, ...selected.scopes])],
  };
}

async function request(
  context: Context,
  url: string,
  signal: AbortSignal,
  options: { token: string } | { form: URLSearchParams },
) {
  signal.throwIfAborted();
  const response = await context.services.http.request(
    {
      url,
      redirect: 'error',
      ...('token' in options
        ? {
            method: 'GET' as const,
            headers: { authorization: `Bearer ${options.token}` },
          }
        : {
            method: 'POST' as const,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new TextEncoder().encode(options.form.toString()),
          }),
    },
    { signal },
  );
  signal.throwIfAborted();
  if (
    response.finalUrl !== url ||
    (response.status >= 300 && response.status < 400)
  )
    throw new Error('Unexpected OAuth redirect');
  return response;
}

async function identify(
  context: Context,
  token: string,
  signal: AbortSignal,
): Promise<Identity> {
  const response = await request(context, userinfoUrl, signal, { token });
  if (response.status === 401 || response.status === 403)
    throw new OAuthFailure(reconnect());
  if (response.status !== 200) throw new OAuthFailure(unavailable());
  const body = parseBody(response);
  if (!object(body) || !validToken(body.sub))
    throw new OAuthFailure(unavailable());
  return {
    subject: body.sub,
    email:
      typeof body.email === 'string' && body.email.trim() ? body.email : null,
  };
}

async function exchange(
  context: Context,
  form: URLSearchParams,
  signal: AbortSignal,
  previousRefresh?: string,
) {
  let response: HttpResponse;
  try {
    response = await request(context, tokenUrl, signal, { form });
  } catch (error) {
    signal.throwIfAborted();
    // A rotated refresh grant may be spent before a reply is lost.
    const failureCause = projectActionFailureCauseV1(
      error,
      'vercel.oauth.exchange',
      { allowUnknownErrorCode: isPluginError(error) },
    );
    throw new OAuthFailure(
      withActionFailureDiagnostic(
        {
          status: 'outcomeUnknown',
          diagnostic: {
            ...diagnostic(
              failureCause.errorCode ?? 'action_failed',
              'Vercel did not confirm the sign-in. Reconnect before trying again.',
            ),
            details: { failureCause },
          },
        },
        {
          phase: 'vercel.oauth.exchange',
          causeKind: 'native_failure',
          error: new Error(failureCause.errorClass),
        },
      ),
    );
  }
  const body = parseBody(response);
  const receivedAtMs = Date.now();
  if (
    response.status === 401 ||
    (object(body) &&
      typeof body.error === 'string' &&
      [
        'invalid_grant',
        'invalid_client',
        'unauthorized_client',
        'access_denied',
      ].includes(body.error))
  )
    throw new OAuthFailure(reconnect());
  if (response.status !== 200) throw new OAuthFailure(unavailable());
  const refreshToken =
    object(body) && body.refresh_token === undefined
      ? previousRefresh
      : object(body)
        ? body.refresh_token
        : null;
  if (
    !object(body) ||
    typeof body.token_type !== 'string' ||
    body.token_type.toLowerCase() !== 'bearer' ||
    !validToken(body.access_token) ||
    typeof body.expires_in !== 'number' ||
    !Number.isSafeInteger(body.expires_in) ||
    body.expires_in <= 0
  )
    throw new OAuthFailure(unavailable());
  // Refresh is what keeps a sign-in usable past one hour.
  if (!validToken(refreshToken)) {
    throw new OAuthFailure({
      status: 'rejected',
      diagnostic: diagnostic(
        'vercel_oauth_refresh_grant_missing',
        'Vercel did not grant offline access to Happier. Reconnect, or connect with an access token.',
      ),
    });
  }
  return {
    token: body.access_token,
    refreshToken,
    expiresAtMs: receivedAtMs + body.expires_in * 1000,
  };
}

type Grant = Awaited<ReturnType<typeof exchange>>;
async function stage(
  store: ConnectedAccountCredentialStore,
  grant: Grant,
  clientId: string,
  identity: Identity | null,
  signal: AbortSignal,
) {
  for (const [key, value] of Object.entries({
    refreshToken: grant.refreshToken,
    expiresAtMs: String(grant.expiresAtMs),
    oauthClientId: clientId,
    ...(identity
      ? {
          subject: identity.subject,
          ...(identity.email ? { email: identity.email } : {}),
        }
      : {}),
  })) {
    signal.throwIfAborted();
    await store.set(key, value, { signal });
  }
  signal.throwIfAborted();
}

function failure(error: unknown, signal: AbortSignal): Failure {
  signal.throwIfAborted();
  if (error instanceof OAuthFailure) return error.result;
  const failureCause = projectActionFailureCauseV1(error, 'vercel.oauth', {
    allowUnknownErrorCode: isPluginError(error),
  });
  return withActionFailureDiagnostic(
    {
      status: 'unavailable',
      diagnostic: {
        ...diagnostic(
          failureCause.errorCode ?? 'action_failed',
          'Vercel sign-in failed on this device. Check its network access and reconnect.',
        ),
        details: { failureCause },
      },
    },
    {
      phase: 'vercel.oauth',
      causeKind: 'native_failure',
      error: new Error(failureCause.errorClass),
    },
  );
}

async function retainedIdentity(
  store: Pick<ConnectedAccountCredentialStore, 'get'>,
  signal: AbortSignal,
): Promise<Identity> {
  const [subject, email] = await Promise.all([
    store.get('subject', { signal }),
    store.get('email', { signal }),
  ]);
  signal.throwIfAborted();
  if (!validToken(subject))
    throw new OAuthFailure(
      reconnect('Reconnect Vercel to restore this sign-in.'),
    );
  return { subject, email };
}

/** The team probe is the token mode's; only the person's identity comes from the sign-in. */
function signedIn(
  result: Exclude<ConnectedAccountAuthCompletionResult, { status: 'configurationRequired' }>,
  identity: Identity,
  expiresAt?: number,
) {
  if (result.status !== 'connected') {
    return result.status === 'rejected' &&
      result.diagnostic.code === 'vercel_invalid_token'
      ? reconnect(
          'Vercel access has expired or been revoked. Reconnect this account.',
        )
      : result;
  }
  return {
    ...result,
    providerIdentity: {
      accountId: identity.subject,
      email: identity.email,
      organizationId: result.providerIdentity?.organizationId ?? null,
    },
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export const vercelOAuthMode: Extract<
  ConnectedAccountAuthenticationModeRuntime,
  { kind: 'oauthAuthorizationCode' }
> = {
  kind: 'oauthAuthorizationCode',
  async begin(input, context, options) {
    const signal = signalOf(context, options?.signal);
    signal.throwIfAborted();
    try {
      const selected = await client(
        context,
        context.attemptCredentials,
        signal,
        true,
      );
      if (input.pkce.method !== 'S256' || !validToken(input.pkce.challenge))
        return reconnect('Restart the connection with its PKCE challenge.');
      await context.attemptCredentials.set('oauthClientId', selected.clientId, {
        signal,
      });
      signal.throwIfAborted();
      const url = new URL(`${VERCEL_OAUTH_ISSUER}/oauth/authorize`);
      // The host owns the redirect URI (the Home's relay) and checks completions against it.
      url.search = new URLSearchParams({
        client_id: selected.clientId,
        redirect_uri: input.callbackUrl,
        response_type: 'code',
        scope: selected.scopes.join(' '),
        state: input.state,
        code_challenge: input.pkce.challenge,
        code_challenge_method: 'S256',
        // Owner ruling 2026-11-18: force consent only when reconnecting, never on first connect.
        ...(context.attempt.kind === 'reconnect' ? { prompt: 'consent' } : {}),
      }).toString();
      return {
        status: 'awaitingOAuthRedirect',
        authorizationUrl: url.href,
        issuer: VERCEL_OAUTH_ISSUER,
      };
    } catch (error) {
      return failure(error, signal);
    }
  },
  async complete(input, context, options) {
    const signal = signalOf(context, options?.signal);
    signal.throwIfAborted();
    try {
      const { clientId } = await client(
        context,
        context.attemptCredentials,
        signal,
      );
      if (!validToken(input.pkceVerifier))
        return reconnect('Restart the connection with its PKCE verifier.');
      const grant = await exchange(
        context,
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code: input.code,
          redirect_uri: input.callbackUrl,
          code_verifier: input.pkceVerifier,
        }),
        signal,
      );
      const identity = await identify(context, grant.token, signal);
      if (context.configuration.values.teamId === undefined) {
        // Team choice reuses the token mode's discovery; the grant stays in this attempt's custody.
        const discovered = await discover(grant.token, context, signal);
        if (
          discovered.status !== 'connected' &&
          discovered.status !== 'configurationRequired'
        )
          return signedIn(discovered, identity);
        await stage(
          context.attemptCredentials,
          grant,
          clientId,
          identity,
          signal,
        );
        return discovered.status === 'connected'
          ? signedIn(discovered, identity)
          : discovered;
      }
      const result = await probe(
        grant.token,
        scopeOf(context),
        context,
        signal,
      );
      if (result.status !== 'connected') return signedIn(result, identity);
      const staged = await stageToken(context, grant.token, signal);
      if (staged) return staged;
      await stage(
        context.attemptCredentials,
        grant,
        clientId,
        identity,
        signal,
      );
      return signedIn(result, identity);
    } catch (error) {
      return failure(error, signal);
    }
  },
  // Continues a discovered team choice with the grant already staged in this attempt.
  async reconcile(context, options) {
    const signal = signalOf(context, options?.signal);
    signal.throwIfAborted();
    try {
      const [token, expiry] = await Promise.all([
        context.attemptCredentials.get('token', { signal }),
        context.attemptCredentials.get('expiresAtMs', { signal }),
      ]);
      if (
        !validToken(token) ||
        expiry === null ||
        !(Number(expiry) > Date.now())
      )
        throw new OAuthFailure(reconnect('Sign in with Vercel again.'));
      const identity = await retainedIdentity(
        context.attemptCredentials,
        signal,
      );
      return signedIn(
        await probe(token, scopeOf(context), context, signal),
        identity,
      );
    } catch (error) {
      return failure(error, signal);
    }
  },
  // The host owns cancellation and discards attempt custody; no remote transaction exists before the code exchange.
  async cancel() {},
};

export async function vercelOAuthStatus(
  context: ConnectedAccountReadContext,
  options?: { signal?: AbortSignal },
): Promise<ConnectedAccountHealthResult> {
  const signal = signalOf(context, options?.signal);
  signal.throwIfAborted();
  try {
    const [token, expiry] = await Promise.all([
      context.credentials.get('token', { signal }),
      context.credentials.get('expiresAtMs', { signal }),
    ]);
    signal.throwIfAborted();
    const expiresAt = Number(expiry);
    if (
      !validToken(token) ||
      expiry === null ||
      !Number.isSafeInteger(expiresAt)
    )
      throw new OAuthFailure(
        reconnect('Reconnect Vercel to restore this sign-in.'),
      );
    if (expiresAt <= Date.now()) return { status: 'expired' };
    const identity = await retainedIdentity(context.credentials, signal);
    const result = signedIn(
      await probe(token, scopeOf(context), context, signal),
      identity,
      expiresAt,
    );
    if (result.status === 'connected') return result;
    return {
      status: result.status === 'rejected' ? 'reconnectRequired' : 'unavailable',
      diagnostic: result.diagnostic,
    };
  } catch (error) {
    const result = failure(error, signal);
    return {
      status:
        result.status === 'rejected' ? 'reconnectRequired' : 'unavailable',
      diagnostic: result.diagnostic,
    };
  }
}

/** Runs under the refresh coordinator's lease; one token call and the rotated pair staged. */
export async function refreshVercelOAuth(
  context: ConnectedAccountMutationContext,
  options?: { signal?: AbortSignal },
): ReturnType<ConnectedAccountRuntime['refresh']> {
  const signal = signalOf(context, options?.signal);
  signal.throwIfAborted();
  try {
    const { clientId } = await client(context, context.credentials, signal);
    const refresh = await context.credentials.get('refreshToken', { signal });
    if (!validToken(refresh))
      throw new OAuthFailure(
        reconnect('Reconnect Vercel to restore offline access.'),
      );
    const identity = await retainedIdentity(context.credentials, signal);
    const grant = await exchange(
      context,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refresh,
      }),
      signal,
      refresh,
    );
    await context.stagedCredentials.set('token', grant.token, { signal });
    await stage(context.stagedCredentials, grant, clientId, null, signal);
    const scope = scopeOf(context);
    return {
      status: 'connected',
      expiresAt: grant.expiresAtMs,
      scopes: [],
      providerIdentity: {
        accountId: identity.subject,
        email: identity.email,
        organizationId: scope?.teamId ?? null,
      },
    };
  } catch (error) {
    const result = failure(error, signal);
    return result.status === 'rejected'
      ? { status: 'reconnectRequired' as const, diagnostic: result.diagnostic }
      : result;
  }
}

export async function revokeVercelOAuth(
  context: ConnectedAccountReadContext,
  options?: { signal?: AbortSignal },
): ReturnType<ConnectedAccountRuntime['revoke']> {
  const signal = signalOf(context, options?.signal);
  signal.throwIfAborted();
  const manual = {
    status: 'remoteUnsupported' as const,
    diagnostic: diagnostic(
      'vercel_oauth_manual_revoke_required',
      'Remove Happier from the authorized applications in your Vercel account settings at https://vercel.com/account.',
    ),
  };
  try {
    const { clientId } = await client(context, context.credentials, signal);
    const token = await context.credentials.get('refreshToken', { signal });
    if (!validToken(token)) return manual;
    const response = await request(context, revokeUrl, signal, {
      form: new URLSearchParams({
        token,
        token_type_hint: 'refresh_token',
        client_id: clientId,
      }),
    });
    if (response.status === 200) return { status: 'remoteRevoked' };
    if ([400, 401, 403].includes(response.status)) return manual;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof OAuthFailure) return manual;
  }
  return {
    status: 'outcomeUnknown',
    diagnostic: diagnostic(
      'vercel_oauth_revocation_unknown',
      'Vercel did not confirm revocation. Check your authorized applications before retrying.',
    ),
  };
}
