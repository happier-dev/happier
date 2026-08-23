import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  ConnectedAccountMaterialization,
  ConnectedAccountRef,
} from '@happier-dev/plugin-sdk/connected-accounts';
import {
  admitForgeRequestUrl,
  materializeTriageSourceAuthorizationV1,
  readTriageSourceAuthorizationV1,
  type TriageSourceAuthorizationFailureReasonV1,
} from '@happier-dev/triage-sources/runtime';
import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

import {
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  GITHUB_CONNECTED_ACCOUNT_ID,
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  isGithubConnectedAccountRef,
} from './githubProviderContracts.js';

export type GithubApiResponseV1 = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

/**
 * The verbs this client may send, and therefore the exact set the manifest's one
 * `github-api` grant admits. The host revalidates origin AND method at dispatch,
 * so a verb widened here without its grant fails at the host authority boundary
 * where no unit test can see it — and a verb granted without a declaring Action
 * is authority nothing consumes.
 */
export type GithubApiMethodV1 = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type GithubApiClientV1 = Readonly<{
  request(input: Readonly<{
    url: string;
    method?: GithubApiMethodV1;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
  }>): Promise<GithubApiResponseV1>;
  /**
   * The single narrow manual-redirect read, for the documented GitHub issue `301`
   * transfer contract only: a request configured with `redirect: 'error'` cannot
   * inspect the `Location` it must validate. It returns the FIRST response without
   * following it — the caller validates the destination and then issues one ordinary
   * request. No caller supplies a redirect mode, and a second client is a defect.
   */
  requestWithoutFollowingRedirects(input: Readonly<{
    url: string;
  }>): Promise<GithubApiResponseV1>;
}>;

/** GitHub requires at least one minute before retrying an unhinted limit response. */
export const GITHUB_RATE_LIMIT_FALLBACK_MS = 60_000;

/**
 * The credential-disclosure gate is the shared forge rule; what GitHub owns is the single
 * fixed API origin it is applied against.
 */
function assertGithubApiUrl(value: string): void {
  if (admitForgeRequestUrl(value, GITHUB_API_ORIGIN) === null) {
    throw new PluginError({
      code: 'github_api_origin_invalid',
      message: 'GitHub credentials may be sent only to the configured GitHub API origin.',
    });
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * GitHub's own wording for a throttled request, wherever it places it. The
 * secondary-limit family reports at the top level; content-creation throttling
 * reports through the `errors` detail of a `422`.
 */
const GITHUB_THROTTLE_MESSAGE_PATTERN =
  /\bsecondary\s+rate\s+limits?\b|\btoo\s+quickly\b|\babuse\s+detection\b|\bspam\b/iu;

function readGithubResponseMessages(response: GithubApiResponseV1): readonly string[] {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(response.body));
    if (!isRecord(value)) return [];
    const messages = typeof value.message === 'string' ? [value.message] : [];
    if (!Array.isArray(value.errors)) return messages;
    for (const detail of value.errors) {
      if (isRecord(detail) && typeof detail.message === 'string') messages.push(detail.message);
    }
    return messages;
  } catch {
    return [];
  }
}

function hasGithubThrottleMessage(response: GithubApiResponseV1): boolean {
  return readGithubResponseMessages(response)
    .some((message) => GITHUB_THROTTLE_MESSAGE_PATTERN.test(message));
}

function isGithubSecondaryRateLimitResponse(response: GithubApiResponseV1): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  return hasGithubThrottleMessage(response);
}

/**
 * GitHub documents its content-creation endpoints' `422` as "Validation failed,
 * OR the endpoint has been spammed", and warns that creating content too
 * quickly results in secondary rate limiting. A throttled `422` is therefore a
 * retryable limit, not the permanent contract failure a bare status implies.
 * Only GitHub's own throttle wording admits one — a documented validation
 * failure keeps its permanent classification, so this never widens the general
 * `422` contract meaning relied on elsewhere.
 */
export function isGithubContentCreationThrottled(response: GithubApiResponseV1): boolean {
  return response.status === 422 && hasGithubThrottleMessage(response);
}

/**
 * The retry instruction for a throttled content-creation `422`, or `null` when
 * the response is not one.
 */
export function readGithubContentCreationThrottleRetryAfterMs(
  response: GithubApiResponseV1,
  nowMs = Date.now(),
): number | null {
  if (!isGithubContentCreationThrottled(response)) return null;
  return readGithubRetryAfterMs(response.headers, nowMs) ?? GITHUB_RATE_LIMIT_FALLBACK_MS;
}

function withoutReservedGithubHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const reserved = new Set(['accept', 'authorization', 'x-github-api-version']);
  return Object.freeze(Object.fromEntries(
    Object.entries(headers).filter(([name]) => !reserved.has(name.toLowerCase())),
  ));
}

/**
 * The only GitHub REST client used by the new Channels/Automation provider
 * vertical. It consumes the existing Connected Account owner exactly once and
 * retains no token outside the current invocation closure.
 */
function assertGithubCredentialRef(
  context: PluginInvocationContext,
  credentialRef: ConnectedAccountRef,
): void {
  if (!isGithubConnectedAccountRef(credentialRef, context.plugin.id)) {
    throw new PluginError({
      code: 'github_credential_mismatch',
      message: 'The GitHub request did not carry this plugin’s selected Connected Account.',
    });
  }
}

/**
 * How the shared owner's four neutral refusal reasons are worded here.
 *
 * GitHub's vertical reports an unusable credential by throwing rather than by returning a
 * typed outcome, so the mapping is onto `PluginError` codes that `triage/errors.ts`
 * already classifies: a host refusal is an `authentication` problem the user fixes by
 * reconnecting, and a cancellation is transient. The host's own rejection is never echoed
 * — it can carry the very material it failed to deliver, and its code is not this source's
 * published failure vocabulary.
 */
const LISTED_ACCOUNT_AUTHORIZATION_REFUSALS: Readonly<Record<
  TriageSourceAuthorizationFailureReasonV1,
  Readonly<{ code: string; message: string }>
>> = Object.freeze({
  cancelled: {
    code: 'github_request_cancelled',
    message: 'The GitHub authorization was cancelled before it completed.',
  },
  materializationFailed: {
    code: 'github_credential_unavailable',
    message: 'The selected GitHub Connected Account could not materialize API authorization.',
  },
  unsupportedMaterialization: {
    code: 'github_credential_unavailable',
    message: 'GitHub requires HTTP-header materialization.',
  },
  authorizationHeaderMissing: {
    code: 'github_credential_unavailable',
    message: 'The selected GitHub Connected Account supplied no authorization header.',
  },
});

function createGithubApiClientWithAuthorization(
  context: PluginInvocationContext,
  authorizationHeader: string,
): GithubApiClientV1 {
  async function send(input: Readonly<{
    url: string;
    method?: GithubApiMethodV1;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
    redirect: 'error' | 'manual';
  }>): Promise<GithubApiResponseV1> {
    assertGithubApiUrl(input.url);
    context.signal.throwIfAborted();
    const response = await context.services.http.request({
      url: input.url,
      method: input.method ?? 'GET',
      headers: {
        ...withoutReservedGithubHeaders(input.headers ?? {}),
        Accept: 'application/vnd.github+json',
        Authorization: authorizationHeader,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      ...(input.body === undefined ? {} : { body: input.body }),
      redirect: input.redirect,
    }, { signal: context.signal });
    context.signal.throwIfAborted();
    return Object.freeze({
      status: response.status,
      headers: response.headers,
      body: response.body,
    });
  }

  return Object.freeze({
    request(input): Promise<GithubApiResponseV1> {
      return send({ ...input, redirect: 'error' });
    },
    requestWithoutFollowingRedirects(input): Promise<GithubApiResponseV1> {
      return send({ url: input.url, method: 'GET', redirect: 'manual' });
    },
  });
}

async function createGithubApiClientFromMaterialization(
  context: PluginInvocationContext,
  materialized: ConnectedAccountMaterialization,
): Promise<GithubApiClientV1> {
  context.signal.throwIfAborted();
  // Which materializations are admissible is the shared forge rule, applied identically to
  // GitHub's two account paths. What GitHub owns is the refusal: this vertical reports an
  // unusable credential by throwing, not by returning a typed outcome.
  const authorization = readTriageSourceAuthorizationV1(materialized);
  if (!authorization.ok) {
    throw new PluginError(LISTED_ACCOUNT_AUTHORIZATION_REFUSALS[authorization.reason]);
  }
  return createGithubApiClientWithAuthorization(context, authorization.authorization);
}

/**
 * Creates a client for one exact Action-owned account. The connected-account
 * owner compares `expectedAccount` with its exact current target, so a stored
 * ref cannot select a different same-service credential.
 */
export async function createGithubApiClient(
  context: PluginInvocationContext,
  credentialRef: ConnectedAccountRef,
): Promise<GithubApiClientV1> {
  assertGithubCredentialRef(context, credentialRef);
  const materialized = await context.services.connectedAccounts.materialize(
    GITHUB_CONNECTED_ACCOUNT_PURPOSE,
    {
      kind: 'httpHeaders',
      origin: GITHUB_API_ORIGIN,
      headerNames: ['authorization'],
    },
    { signal: context.signal, expectedAccount: credentialRef },
  );
  return createGithubApiClientFromMaterialization(context, materialized);
}

/**
 * Creates a client for a genuine background/source inventory member. The
 * account must still be admitted by the exact current purpose target.
 */
export async function createGithubListedAccountApiClient(
  context: PluginInvocationContext,
  credentialRef: ConnectedAccountRef,
): Promise<GithubApiClientV1> {
  assertGithubCredentialRef(context, credentialRef);
  // The exact-bound-account materialization request is the shared forge rule, not a
  // GitHub one: building it here made this the fourth copy of one request shape, and the
  // rejection then reached `classifyGithubTransportFailure` unclassified — so a revoked
  // account was reported as `unsupportedContract` where the other three forges report
  // `authentication`.
  const authorization = await materializeTriageSourceAuthorizationV1({
    connectedAccounts: context.services.connectedAccounts,
    purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
    account: credentialRef,
    origin: GITHUB_API_ORIGIN,
    signal: context.signal,
  });
  if (!authorization.ok) {
    throw new PluginError(LISTED_ACCOUNT_AUTHORIZATION_REFUSALS[authorization.reason]);
  }
  return createGithubApiClientWithAuthorization(context, authorization.authorization);
}

export function decodeGithubJsonResponse(response: GithubApiResponseV1): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
  } catch {
    throw new PluginError({
      code: 'github_api_response_invalid',
      message: 'GitHub returned an invalid JSON API response.',
    });
  }
}

export function readGithubRetryAfterMs(
  headers: Readonly<Record<string, string>>,
  nowMs = Date.now(),
): number | null {
  const retryAfter = readTriageResponseHeaderV1(headers, 'retry-after');
  if (retryAfter !== null && /^\d+$/u.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (Number.isSafeInteger(seconds) && seconds >= 0) return seconds * 1_000;
  }
  const reset = readTriageResponseHeaderV1(headers, 'x-ratelimit-reset');
  if (reset !== null && /^\d+$/u.test(reset)) {
    const resetAtMs = Number(reset) * 1_000;
    if (Number.isSafeInteger(resetAtMs)) return Math.max(0, resetAtMs - nowMs);
  }
  return null;
}

export function isGithubRateLimited(response: GithubApiResponseV1): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  const remaining = readTriageResponseHeaderV1(response.headers, 'x-ratelimit-remaining');
  return response.status === 429
    || remaining === '0'
    || isGithubSecondaryRateLimitResponse(response);
}

/**
 * Resolves the exact GitHub retry instruction when present, otherwise the
 * provider-documented minimum for a response classified as rate limited.
 */
export function readGithubRateLimitRetryAfterMs(
  response: GithubApiResponseV1,
  nowMs = Date.now(),
): number | null {
  if (!isGithubRateLimited(response)) return null;
  return readGithubRetryAfterMs(response.headers, nowMs) ?? GITHUB_RATE_LIMIT_FALLBACK_MS;
}
