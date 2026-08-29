/**
 * The `sentry-account` Connected Account runtime (`SENTRY.md` §2.1, §2.1a,
 * §2.3a).
 *
 * Both shipped modes are the same bearer credential on the same header: the API
 * gives a client no way to tell an internal-integration token from a personal
 * one at request time, so no unverifiable distinction is inferred from the
 * token bytes. What differs is the deployment, and that is explicit non-secret
 * Connected Account configuration — never a guess, a neutral-origin probe, or a
 * regional fan-out.
 *
 * Confirmation is one minimal public GET that proves the single capability V1
 * needs before a connection is staged: this token can enumerate at least one
 * Sentry organization. It returns only the normalized origin and a generic
 * label; no token, header, response body, organization name, slug, or provider
 * user id ever leaves this module.
 */

import type {
  ConnectedAccountAuthCompletionResult as PluginConnectedAccountAuthCompletionResult,
  ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
  ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  ConnectedAccountManualCompletion as PluginConnectedAccountManualCompletion,
  ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import {
  createBoundedInvocation,
} from '@happier-dev/triage-sources/runtime';
import {
  SENTRY_CLOUD_REGION_ORIGINS,
  SENTRY_FAILURE_CODES,
  isSentryCloudRegion,
} from '../sentryContracts.js';

import { normalizeSentryOrigin } from './sentryOrigin.js';
import {
  readSentryRateLimitSnapshot,
  resolveSentryRetryNotBeforeMs,
} from '../api/sentryRateLimit.js';

/**
 * The self-hosted configuration field: an exact origin the host normalizes and
 * republishes as this account's `connectedAccountOrigins`.
 */
export const SENTRY_ORIGIN_CONFIGURATION_FIELD = 'origin';
/**
 * The Cloud configuration field: a closed named region, never a URL. The
 * descriptor declares which origin each choice routes to, so a Cloud connection
 * cannot be pointed at an arbitrary deployment by editing a text box.
 */
export const SENTRY_REGION_CONFIGURATION_FIELD = 'region';
/** The two manual modes, keyed by the deployment family each one admits. */
export const SENTRY_CLOUD_MODE_ID = 'auth-token';
export const SENTRY_SELF_HOSTED_MODE_ID = 'self-hosted-auth-token';

const SENTRY_CLOUD_ORIGINS: ReadonlySet<string> = new Set(
  Object.values(SENTRY_CLOUD_REGION_ORIGINS),
);
export const SENTRY_TOKEN_CREDENTIAL_KEY = 'token';
/**
 * The deployment this account's stored bearer was actually confirmed against.
 *
 * It is written only by a successful confirmation, in the same staged custody as
 * the token itself, and it is read only to *refuse*: it never routes a request.
 * Without it, editing the account's configuration after connecting would send an
 * already-stored credential to a deployment that never accepted it — which is a
 * cross-deployment disclosure, not a reconfiguration.
 */
export const SENTRY_CONFIRMED_ORIGIN_CREDENTIAL_KEY = 'confirmed-origin';
/** `[SCHEMA]` the documented maximum-bounded page parameter of this listing. */
const SENTRY_CONFIRMATION_PATH = '/api/0/organizations/?per_page=1';
const EMPTY_HTTP_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

type SentryReadContext = Parameters<PluginConnectedAccountRuntime['status']>[0];

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

/**
 * Reads the exact declared deployment origin from this account's own
 * configuration.
 *
 * The mode — not the shape of a stored string — decides how that value is read,
 * and the switch is closed: an unrecognized mode has no deployment family and
 * therefore no route. There is no fallback, because inventing one would be the
 * region guess this vertical forbids.
 */
function readConfiguredOrigin(
  configuration: Readonly<{
    target: Readonly<{ modeId: string }>;
    values: Readonly<Record<string, unknown>>;
  }>,
): string | null {
  switch (configuration.target.modeId) {
    case SENTRY_CLOUD_MODE_ID: {
      // The persisted value is the closed choice, never an origin, so no user
      // text can widen where a Cloud token is sent.
      const region = configuration.values[SENTRY_REGION_CONFIGURATION_FIELD];
      return isSentryCloudRegion(region) ? SENTRY_CLOUD_REGION_ORIGINS[region] : null;
    }
    case SENTRY_SELF_HOSTED_MODE_ID: {
      const configured = configuration.values[SENTRY_ORIGIN_CONFIGURATION_FIELD];
      if (typeof configured !== 'string') return null;
      const normalized = normalizeSentryOrigin(configured);
      // A Cloud origin typed into the self-hosted mode is refused so the two
      // families never alias, and so a self-hosted connection can never be the
      // route by which a token reaches Sentry Cloud.
      if (!normalized.ok || SENTRY_CLOUD_ORIGINS.has(normalized.origin)) return null;
      return normalized.origin;
    }
    default:
      return null;
  }
}

type SentryConfirmation =
  | Readonly<{ status: 'confirmed'; origin: string }>
  | Extract<
    PluginConnectedAccountAuthCompletionResult,
    Readonly<{ status: 'rejected' | 'unavailable' }>
  >;

/**
 * Three distinct answers, because collapsing them lies to the user.
 *
 * "You can read no organization" is a true statement about this token's access.
 * A body this source cannot read says nothing about access at all, and reporting
 * it as an empty list would send a user hunting for permissions they already
 * have.
 */
type SentryOrganizationListing = 'present' | 'empty' | 'unparseable';

function readOrganizationListing(body: Uint8Array): SentryOrganizationListing {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return 'unparseable';
  }
  if (!Array.isArray(value)) return 'unparseable';
  if (value.length === 0) return 'empty';
  const enumerable = value.some((row) => (
    typeof row === 'object'
    && row !== null
    && typeof (row as Readonly<Record<string, unknown>>).id === 'string'
    && (row as Readonly<Record<string, unknown>>).id !== ''
  ));
  // Rows that carry no usable identity are a shape this source cannot
  // characterize, not proof that the listing was empty.
  return enumerable ? 'present' : 'unparseable';
}

async function confirmSentryIdentity(
  input: Readonly<{ token: string; origin: string }>,
  context: Pick<PluginConnectedAccountAuthenticationContext, 'services' | 'signal'>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<SentryConfirmation> {
  const callerSignal = options?.signal ?? context.signal;
  // One bound for the whole confirmation, so a deployment that accepts the
  // connection and then goes silent settles as an answer rather than as no
  // answer at all.
  const bounded = createBoundedInvocation({
    callerSignal,
  });
  try {
    let response: Awaited<ReturnType<typeof context.services.http.request>>;
    try {
      response = await context.services.http.request({
        url: `${input.origin}${SENTRY_CONFIRMATION_PATH}`,
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${input.token}` },
        redirect: 'error',
      }, { signal: bounded.signal });
    } catch (error) {
      // Caller cancellation propagates. Provider/transport failures become the
      // stated unavailable result; this source does not add a second timer.
      if (callerSignal.aborted) throw error;
      return {
        status: 'unavailable',
        diagnostic: diagnostic(
          SENTRY_FAILURE_CODES.verificationUnavailable,
          'Sentry could not be reached to confirm this connection.',
        ),
      };
    }

    if (response.status === 401) {
      return {
        status: 'rejected',
        diagnostic: diagnostic(
          SENTRY_FAILURE_CODES.tokenInvalid,
          'Sentry rejected this auth token.',
        ),
      };
    }
    if (response.status === 403) {
      return {
        status: 'rejected',
        diagnostic: diagnostic(
          SENTRY_FAILURE_CODES.insufficientPermission,
          'This Sentry token is missing the org:read capability.',
        ),
      };
    }
    if (response.status === 429) {
      const retryNotBeforeMs = resolveSentryRetryNotBeforeMs(
        readSentryRateLimitSnapshot(response.headers),
        Date.now(),
      );
      return {
        status: 'unavailable',
        diagnostic: diagnostic(
          SENTRY_FAILURE_CODES.rateLimited,
          'Sentry is rate limiting this connection; try again shortly.',
        ),
        failureClass: 'rateLimit',
        ...(retryNotBeforeMs === null ? {} : { retryNotBeforeMs }),
      };
    }
    if (response.status === 404 || response.status >= 500) {
      return {
        status: 'unavailable',
        diagnostic: diagnostic(
          SENTRY_FAILURE_CODES.verificationUnavailable,
          'Sentry could not be reached to confirm this connection.',
        ),
      };
    }
    if (response.status !== 200) {
      return {
        status: 'unavailable',
        diagnostic: diagnostic(
          SENTRY_FAILURE_CODES.verificationUnknown,
          'Sentry returned an unrecognized confirmation response.',
        ),
      };
    }
    switch (readOrganizationListing(response.body)) {
      case 'present':
        return { status: 'confirmed', origin: input.origin };
      case 'empty':
        // An empty organization list cannot produce a V1 source instance, so the
        // connection is not staged rather than staged and later found useless.
        return {
          status: 'rejected',
          diagnostic: diagnostic(
            SENTRY_FAILURE_CODES.noAccessibleOrganizations,
            'This Sentry token can read no organization.',
          ),
        };
      case 'unparseable':
        return {
          status: 'rejected',
          diagnostic: diagnostic(
            SENTRY_FAILURE_CODES.responseUnparseable,
            'Sentry returned an organization list this connection could not read.',
          ),
        };
    }
  } finally {
    bounded.dispose();
  }
}

/** The generic connection label; it names the deployment, never the account. */
function connectionDisplayName(origin: string): string {
  return `Sentry · ${new URL(origin).host}`;
}

async function completeManualConnection(
  input: PluginConnectedAccountManualCompletion,
  context: PluginConnectedAccountAuthenticationContext,
  options?: Readonly<{ signal?: AbortSignal }>,
) {
  const token = input.fields[SENTRY_TOKEN_CREDENTIAL_KEY]?.trim() ?? '';
  if (token === '') {
    return {
      status: 'rejected' as const,
      diagnostic: diagnostic(
        SENTRY_FAILURE_CODES.tokenInvalid,
        'Sentry requires an auth token with org:read and event:read.',
      ),
    };
  }
  const origin = readConfiguredOrigin(context.configuration);
  if (origin === null) {
    return {
      status: 'rejected' as const,
      diagnostic: diagnostic(
        SENTRY_FAILURE_CODES.regionOriginUndeclared,
        'This Sentry connection declares no deployment to reach.',
      ),
    };
  }

  const confirmation = await confirmSentryIdentity({ token, origin }, context, options);
  if (confirmation.status !== 'confirmed') return confirmation;

  await context.attemptCredentials.set(SENTRY_TOKEN_CREDENTIAL_KEY, token, options);
  // Stored with the credential it qualifies, so the two can never drift apart:
  // a later configuration edit changes where this account points, but not what
  // this token was ever proven against.
  await context.attemptCredentials.set(
    SENTRY_CONFIRMED_ORIGIN_CREDENTIAL_KEY,
    confirmation.origin,
    options,
  );
  return {
    status: 'connected' as const,
    displayName: connectionDisplayName(confirmation.origin),
    // The confirmation proves enumeration, not a scope grant. Claiming scopes
    // the API never echoed would be a capability assertion this source cannot
    // verify; the first real call reports the true answer.
    scopes: [],
  };
}

/**
 * The one gate every credential use passes: this account's currently configured
 * deployment must be the deployment its stored credential was confirmed against.
 *
 * It is checked before the token is read, so a configuration edit cannot turn
 * an established connection into a delivery of that credential to a deployment
 * that never accepted it.
 */
async function resolveConfirmedDeploymentOrigin(
  context: SentryReadContext,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<
  | Readonly<{ ok: true; origin: string }>
  | Readonly<{ ok: false; diagnostic: ReturnType<typeof diagnostic> }>
> {
  const origin = readConfiguredOrigin(context.configuration);
  if (origin === null) {
    return {
      ok: false,
      diagnostic: diagnostic(
        SENTRY_FAILURE_CODES.regionOriginUndeclared,
        'This Sentry connection declares no deployment to reach.',
      ),
    };
  }
  const confirmed = (
    await context.credentials.get(SENTRY_CONFIRMED_ORIGIN_CREDENTIAL_KEY, options)
  )?.trim() ?? '';
  if (confirmed !== origin) {
    return {
      ok: false,
      diagnostic: diagnostic(
        SENTRY_FAILURE_CODES.deploymentUnconfirmed,
        'This Sentry deployment changed since the connection was confirmed; reconnect it.',
      ),
    };
  }
  return { ok: true, origin };
}

async function readHealth(
  context: SentryReadContext,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginConnectedAccountHealthResult> {
  const confirmed = await resolveConfirmedDeploymentOrigin(context, options);
  if (!confirmed.ok) {
    return { status: 'reconnectRequired', diagnostic: confirmed.diagnostic };
  }
  const origin = confirmed.origin;
  const token = (await context.credentials.get(SENTRY_TOKEN_CREDENTIAL_KEY, options))?.trim() ?? '';
  if (token === '') {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        SENTRY_FAILURE_CODES.tokenInvalid,
        'Sentry credentials are unavailable; reconnect the account.',
      ),
    };
  }
  const confirmation = await confirmSentryIdentity({ token, origin }, context, options);
  if (confirmation.status === 'confirmed') {
    return { status: 'connected', displayName: connectionDisplayName(confirmation.origin) };
  }
  return confirmation.status === 'rejected'
    ? { status: 'reconnectRequired', diagnostic: confirmation.diagnostic }
    : { status: 'unavailable', diagnostic: confirmation.diagnostic };
}

const sentryConnectedAccountRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      'auth-token': { kind: 'manual', complete: completeManualConnection },
      'self-hosted-auth-token': { kind: 'manual', complete: completeManualConnection },
    },
  },
  async refresh(context, options) {
    // A pasted bearer token has no refresh exchange. Reporting current health
    // is the honest answer rather than a rotation this credential never has.
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
      throw new Error('Sentry connected accounts support HTTP-header materialization only');
    }
    const confirmed = await resolveConfirmedDeploymentOrigin(context, options);
    if (!confirmed.ok || request.origin !== confirmed.origin) {
      throw new Error('Sentry connected accounts cannot materialize credentials for this origin');
    }
    if (!request.headerNames.some((name) => name.toLowerCase() === 'authorization')) {
      return { kind: 'httpHeaders', headers: EMPTY_HTTP_HEADERS };
    }
    const token = (await context.credentials.get(SENTRY_TOKEN_CREDENTIAL_KEY, options))?.trim()
      ?? '';
    if (token === '') {
      throw new Error('Sentry connected-account credentials are unavailable');
    }
    return { kind: 'httpHeaders', headers: { Authorization: `Bearer ${token}` } };
  },
};

export const sentryConnectedAccountRuntime = Object.freeze(
  sentryConnectedAccountRuntimeDefinition,
);
