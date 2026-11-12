import { computeCanonicalDomainSeparatedDigest, PluginError, type PluginInvocationContext, type PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { GithubHttpInvocationContextV1 } from './githubHttpInvocation.js';
import type {
  ConnectedAccountMaterialization,
  ConnectedAccountRef,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { parseRetryAfterHeader } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  admitForgeRequestUrl,
  materializeTriageSourceAuthorizationV1,
  readTriageSourceAuthorizationV1,
  TriageSourceAuthorizationErrorV1,
  type TriageSourceAuthorizationFailureReasonV1,
} from '@happier-dev/triage-sources/runtime';
import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

import {
  GITHUB_API_ORIGIN,
  GITHUB_CONNECTED_ACCOUNT_ID,
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_CONNECTED_ACCOUNT_SERVICE,
  isGithubConnectedAccountRef,
} from './githubProviderContracts.js';
import { createGithubRequestHeaders } from './githubRequestHeaders.js';

export type GithubApiResponseV1 = Readonly<{
  requestId?: string;
  status: number;
  statusText?: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

/**
 * Everything the shared failure ladder decides from, independent of how the body
 * reached this process. The `github-api` client hands back undecoded bytes; the
 * SCM forge seam hands back an already-parsed body. Re-encoding one to decode it
 * again is how a second throttle-message ladder gets written, so both carriers
 * project onto this instead.
 */
export type GithubResponseFactsV1 = Readonly<{
  requestId?: string;
  status: number;
  /** Lowercase-insensitive response headers; a carrier that has none supplies `{}`. */
  headers: Readonly<Record<string, string>>;
  /** Provider-reported messages already extracted from the response body. */
  messages: readonly string[];
}>;

/**
 * The verbs this client may send, and therefore the exact set the manifest's one
 * `github-api` grant admits. The host revalidates origin AND method at dispatch,
 * so a verb widened here without its grant fails at the host authority boundary
 * where no unit test can see it — and a verb granted without a declaring Action
 * is authority nothing consumes.
 */
export type GithubApiMethodV1 = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type GithubAccountRequestV1 = Readonly<{
  url: string;
  method?: GithubApiMethodV1;
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  redirect?: 'error' | 'manual' | 'follow';
  /** Only the native query owner can admit a POST as a read-only GraphQL query. */
  readOnlyGraphql?: boolean;
}>;

export type GithubAccountRequestOwnerV1 = Readonly<{
  request(input: GithubAccountRequestV1, options: Readonly<{
    signal?: AbortSignal;
    transport(input: GithubAccountRequestV1, signal: AbortSignal): Promise<GithubApiResponseV1>;
    disposeTransport?(): void | Promise<void>;
  }>): Promise<GithubApiResponseV1>;
  dispose(): void;
}>;

function isGithubSafeRead(input: GithubAccountRequestV1): boolean {
  const method = input.method ?? 'GET';
  return method === 'GET' || (method === 'POST' && input.readOnlyGraphql === true && new URL(input.url).pathname === '/graphql');
}

function githubRequestResource(input: GithubAccountRequestV1): string {
  const path = new URL(input.url).pathname;
  return path === '/graphql' ? 'graphql' : path.startsWith('/search/') ? 'search' : 'core';
}

type AccountRequestEntry = Readonly<{ credential: string; owner: GithubAccountRequestOwnerV1; clearJoins(): void }>;
const accountOwnersByLifetime = new WeakMap<object, Map<string, AccountRequestEntry>>();
let activeRequestOccurrence: object | null = null;

/** The existing definePlugin setup/cleanup owns the lifetime of account transport state. */
export function beginGithubAccountRequestOccurrenceV1(): () => void {
  if (activeRequestOccurrence !== null) throw new Error('GitHub request occurrence is already active');
  const occurrence = {};
  activeRequestOccurrence = occurrence;
  return () => {
    if (activeRequestOccurrence === occurrence) activeRequestOccurrence = null;
    disposeGithubAccountRequestLifetimeV1(occurrence);
  };
}

/** Both activation realms retire transport state at their existing cleanup boundary. */
export function disposeGithubAccountRequestLifetimeV1(lifetime: object): void {
  const entries = accountOwnersByLifetime.get(lifetime);
  for (const entry of entries?.values() ?? []) entry.owner.dispose();
  entries?.clear();
  accountOwnersByLifetime.delete(lifetime);
}

/**
 * Borrows transport state after credential admission. Each invocation supplies its
 * own admitted read; an executing handle is held only until its flight settles.
 */
export function getGithubAccountRequestOwnerV1(scope: Readonly<{
  lifetime?: object;
  fallbackLifetime?: object;
  accountScope: string;
  credentialScope: string;
  executionOrigin?: string;
  now?: () => number;
}>): GithubAccountRequestOwnerV1 {
  const lifetime = scope.lifetime ?? activeRequestOccurrence ?? scope.fallbackLifetime ?? {};
  let entries = accountOwnersByLifetime.get(lifetime);
  if (!entries) {
    entries = new Map();
    accountOwnersByLifetime.set(lifetime, entries);
  }
  const key = JSON.stringify([scope.accountScope, scope.executionOrigin ?? '']);
  // Keep no credential bytes beyond the admitted invocation's own client closure.
  const credential = computeCanonicalDomainSeparatedDigest('github-account-request-credential-v1', [scope.credentialScope]);
  const existing = entries.get(key);
  if (existing?.credential === credential) return existing.owner;
  existing?.clearJoins();

  const now = scope.now ?? Date.now;
  let retryNotBeforeMs = 0;
  const primaryRetryNotBeforeByResource = new Map<string, number>();
  let retired = false;
  type Flight = { controller: AbortController; promise: Promise<GithubApiResponseV1>; consumers: number };
  const reads = new Map<string, Flight>();
  const pending = new Set<Flight>();
  const clearJoins = () => { reads.clear(); };
  const owner: GithubAccountRequestOwnerV1 = Object.freeze({
    dispose(): void {
      retired = true;
      retryNotBeforeMs = 0;
      primaryRetryNotBeforeByResource.clear();
      clearJoins();
      for (const flight of pending) flight.controller.abort();
      pending.clear();
    },
    async request(input, options): Promise<GithubApiResponseV1> {
      if (options.signal?.aborted || retired) {
        await options.disposeTransport?.();
        options.signal?.throwIfAborted();
        throw new DOMException('GitHub request authority retired', 'AbortError');
      }
      const checkedAtMs = now();
      const parkedUntilMs = Math.max(retryNotBeforeMs, primaryRetryNotBeforeByResource.get(githubRequestResource(input)) ?? 0);
      if (parkedUntilMs > checkedAtMs) {
        await options.disposeTransport?.();
        return Object.freeze({
          status: 429,
          // This synthetic response stays inside the client; the shared timing parser
          // accepts an absolute timestamp, preserving the owner's exact deadline.
          headers: Object.freeze({ 'retry-after': new Date(parkedUntilMs).toISOString() }),
          body: new TextEncoder().encode('{"message":"GitHub account requests are rate limited."}'),
        });
      }
      const method = input.method ?? 'GET';
      const safe = isGithubSafeRead(input);
      const readKey = safe ? JSON.stringify([
        method, input.url, input.redirect ?? 'error',
        Object.entries(input.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value] as const).sort(([a], [b]) => a.localeCompare(b)),
        input.body === undefined ? null : Array.from(input.body),
      ]) : null;
      let flight = readKey === null ? undefined : reads.get(readKey);
      if (flight?.controller.signal.aborted) flight = undefined;
      const joined = flight !== undefined;
      if (!flight) {
        const controller = new AbortController();
        // Publish before starting transport so synchronous boundary re-entry shares it.
        let resolve!: (response: GithubApiResponseV1) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<GithubApiResponseV1>((yes, no) => { resolve = yes; reject = no; });
        flight = { controller, promise, consumers: 0 };
        const created = flight;
        pending.add(created);
        if (readKey !== null) reads.set(readKey, created);
        const settle = () => {
          pending.delete(created);
          if (readKey !== null && reads.get(readKey) === created) reads.delete(readKey);
        };
        void promise.then(settle, settle);
        try {
          void options.transport(input, controller.signal).then(async (response) => {
            try {
              controller.signal.throwIfAborted();
              const observedAtMs = now();
              // Primary bucket headers describe successful responses too. The
              // last successful slot parks only its resource without decoding its body
              // or changing that response's success classification. Primary refusals
              // use the same resource; secondary/content throttles remain global.
              const facts = response.status === 403 || response.status === 429 || response.status === 422
                ? readGithubApiResponseFacts(response) : null;
              const primary = readTriageResponseHeaderV1(response.headers, 'x-ratelimit-remaining') === '0'
                && (facts === null || !isGithubSecondaryRateLimitResponse(facts) && !isGithubContentCreationThrottled(facts));
              const retryAfterMs = (primary ? readGithubRetryAfterMs(response.headers, observedAtMs) : null)
                ?? (facts === null ? null : readGithubRateLimitRetryAfterMs(facts, observedAtMs)
                  ?? readGithubContentCreationThrottleRetryAfterMs(facts, observedAtMs));
              if (retryAfterMs !== null && !retired) {
                if (primary) {
                  const resource = readTriageResponseHeaderV1(response.headers, 'x-ratelimit-resource') ?? githubRequestResource(input);
                  primaryRetryNotBeforeByResource.set(resource, Math.max(primaryRetryNotBeforeByResource.get(resource) ?? 0, observedAtMs + retryAfterMs));
                } else retryNotBeforeMs = Math.max(retryNotBeforeMs, observedAtMs + retryAfterMs);
              }
            } finally {
              await options.disposeTransport?.();
            }
            controller.signal.throwIfAborted();
            resolve(response);
          }, async (error: unknown) => {
            await options.disposeTransport?.();
            reject(error);
          }).catch(reject);
        } catch (error) {
          void Promise.resolve().then(() => options.disposeTransport?.()).then(() => reject(error), reject);
        }
      }
      const current = flight;
      current.consumers += 1;
      // Join before disposing an unused prepared handle: disposal may cross the
      // background-process bridge while the original caller is cancelled.
      const result = joined
        ? Promise.all([current.promise, Promise.resolve().then(() => options.disposeTransport?.())]).then(([response]) => response)
        : current.promise;
      return await new Promise<GithubApiResponseV1>((resolve, reject) => {
        let settled = false;
        const finish = (complete: () => void) => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener('abort', abort);
          current.consumers -= 1;
          if (current.consumers === 0 && pending.has(current)) {
            current.controller.abort();
            if (readKey !== null && reads.get(readKey) === current) reads.delete(readKey);
          }
          complete();
        };
        const abort = () => finish(() => reject(options.signal?.reason));
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        void result.then((response) => finish(() => resolve(response)), (error) => finish(() => reject(error)));
      });
    },
  });
  entries.set(key, { credential, owner, clearJoins });
  return owner;
}

export type GithubApiClientV1 = Readonly<{
  /** Originating host-issued operation identity, distinct from provider request headers. */
  requestId?: string;
  /** Immutable workflow definitions share this admitted account/materialization lifetime. */
  immutableDefinitionLifetime?: object;
  request(input: Readonly<{
    url: string;
    method?: GithubApiMethodV1;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
    readOnlyGraphql?: boolean;
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

/** The same admitted client, with private media required only by byte consumers. */
export type GithubApiMediaClientV1 = GithubApiClientV1 & Readonly<{
  requestMedia(input: Readonly<{ url: string; media: 'json' | 'binary' }>): Promise<GithubApiResponseV1>;
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

function readGithubBodyMessages(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  const messages = typeof value.message === 'string' ? [value.message] : [];
  if (!Array.isArray(value.errors)) return messages;
  for (const detail of value.errors) {
    if (isRecord(detail) && typeof detail.message === 'string') messages.push(detail.message);
  }
  return messages;
}

/** The facts of a response whose body is still undecoded transport bytes. */
export function readGithubApiResponseFacts(response: GithubApiResponseV1): GithubResponseFactsV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    parsed = null;
  }
  return Object.freeze({
    status: response.status,
    headers: response.headers,
    messages: readGithubBodyMessages(parsed),
    ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
  });
}

/**
 * The facts of a response a seam already parsed for us — the SCM forge error
 * context, whose `body` is the decoded JSON value (or the raw text when GitHub
 * answered with something other than JSON).
 */
export function readGithubDecodedResponseFacts(input: Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}>): GithubResponseFactsV1 {
  return Object.freeze({
    status: input.status,
    headers: input.headers,
    messages: readGithubBodyMessages(input.body),
  });
}

function hasGithubThrottleMessage(facts: GithubResponseFactsV1): boolean {
  return facts.messages.some((message) => GITHUB_THROTTLE_MESSAGE_PATTERN.test(message));
}

function isGithubSecondaryRateLimitResponse(facts: GithubResponseFactsV1): boolean {
  if (facts.status !== 403 && facts.status !== 429) return false;
  return hasGithubThrottleMessage(facts);
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
export function isGithubContentCreationThrottled(facts: GithubResponseFactsV1): boolean {
  return facts.status === 422 && hasGithubThrottleMessage(facts);
}

/**
 * The retry instruction for a throttled content-creation `422`, or `null` when
 * the response is not one.
 */
export function readGithubContentCreationThrottleRetryAfterMs(
  facts: GithubResponseFactsV1,
  nowMs = Date.now(),
): number | null {
  if (!isGithubContentCreationThrottled(facts)) return null;
  return readGithubRetryAfterMs(facts.headers, nowMs) ?? GITHUB_RATE_LIMIT_FALLBACK_MS;
}

/**
 * The only GitHub REST client used by the new Channels/Automation provider
 * vertical. It consumes the existing Connected Account owner exactly once and
 * retains no token outside the current invocation closure.
 */
function assertGithubCredentialRef(
  context: GithubHttpInvocationContextV1,
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
  context: GithubHttpInvocationContextV1,
  authorizationHeader: string,
  credentialRef?: ConnectedAccountRef,
): GithubApiMediaClientV1 {
  const owner = getGithubAccountRequestOwnerV1({
    ...(context.githubRequestLifetime !== undefined ? { lifetime: context.githubRequestLifetime }
      : credentialRef === undefined ? { lifetime: context.services.connectedAccounts } : {}),
    accountScope: credentialRef === undefined ? 'unidentified-native' : JSON.stringify([credentialRef.service.pluginId, credentialRef.service.localId, credentialRef.accountId]),
    fallbackLifetime: context.services.connectedAccounts,
    credentialScope: authorizationHeader,
    executionOrigin: GITHUB_API_ORIGIN,
  });
  async function send(input: Readonly<{
    url: string;
    method?: GithubApiMethodV1;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
    readOnlyGraphql?: boolean;
    media?: 'json' | 'binary';
    redirect: 'error' | 'manual';
  }>): Promise<GithubApiResponseV1> {
    assertGithubApiUrl(input.url);
    context.signal.throwIfAborted();
    const safeRead = isGithubSafeRead(input);
    const request = {
      url: input.url,
      method: input.method ?? 'GET',
      headers: createGithubRequestHeaders({
        authorization: authorizationHeader,
        userAgent: context.plugin.id,
        headers: input.headers,
        media: input.media,
      }),
      ...(input.body === undefined ? {} : { body: safeRead ? input.body.slice() : input.body }),
      redirect: input.redirect,
    };
    const prepareExactRead = () => {
      return input.method === 'POST'
        ? context.services.http.prepareRead({ ...request, method: 'POST', intent: 'graphqlQuery' }, { signal: context.signal })
        : context.services.http.prepareRead({ ...request, method: 'GET', intent: 'get' }, { signal: context.signal });
    };
    const prepared = safeRead ? await prepareExactRead() : null;
    const response = await owner.request({ ...request, ...(input.readOnlyGraphql === undefined ? {} : { readOnlyGraphql: input.readOnlyGraphql }) }, {
      signal: context.signal,
      ...(prepared ? { disposeTransport: () => prepared.dispose() } : {}),
      transport: (request, signal) => prepared ? prepared.request({ signal }) : context.services.http.request({
        ...request,
        redirect: request.redirect ?? 'error',
      }, { signal }),
    });
    context.signal.throwIfAborted();
    return Object.freeze({
      status: response.status,
      headers: response.headers,
      body: response.body,
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    });
  }

  return Object.freeze({
    immutableDefinitionLifetime: owner,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    async requestMedia(input): Promise<GithubApiResponseV1> {
      const response = await send({ url: input.url, method: 'GET', media: input.media, redirect: 'manual' });
      if (response.status !== 302) return response;
      const location = readTriageResponseHeaderV1(response.headers, 'location');
      let destination: URL;
      try { destination = new URL(location ?? ''); } catch {
        throw new PluginError({ code: 'github_media_redirect_invalid', message: 'GitHub did not provide an admitted download location.' });
      }
      // The storage hop carries no authorization, so it must be HTTPS without embedded
      // credentials and must not lead back to the authorized API origin.
      if (destination.protocol !== 'https:' || destination.username || destination.password
        || destination.origin === new URL(input.url).origin) {
        throw new PluginError({ code: 'github_media_redirect_invalid', message: 'GitHub did not provide an admitted download location.' });
      }
      context.signal.throwIfAborted();
      const downloaded = await context.services.http.request({ url: destination.toString(), method: 'GET', headers: {}, redirect: 'error' }, { signal: context.signal });
      context.signal.throwIfAborted();
      // Never expose the API Location header or signed URL to an Action caller.
      return { status: downloaded.status, headers: {}, body: downloaded.body };
    },
    request(input): Promise<GithubApiResponseV1> {
      return send({ ...input, redirect: 'error' });
    },
    requestWithoutFollowingRedirects(input): Promise<GithubApiResponseV1> {
      return send({ url: input.url, method: 'GET', redirect: 'manual' });
    },
  });
}

async function createGithubApiClientFromMaterialization(
  context: GithubHttpInvocationContextV1,
  materialized: ConnectedAccountMaterialization,
  credentialRef?: ConnectedAccountRef,
): Promise<GithubApiMediaClientV1> {
  context.signal.throwIfAborted();
  // Which materializations are admissible is the shared forge rule, applied identically to
  // GitHub's two account paths. What GitHub owns is the refusal: this vertical reports an
  // unusable credential by throwing, not by returning a typed outcome.
  const authorization = readTriageSourceAuthorizationV1(materialized);
  if (!authorization.ok) {
    throw new PluginError(LISTED_ACCOUNT_AUTHORIZATION_REFUSALS[authorization.reason]);
  }
  return createGithubApiClientWithAuthorization(context, authorization.authorization, credentialRef);
}

/** An explicit service pins native login; omission retains the host's selected-account/native path. */
export async function createGithubNativeApiClient(
  context: GithubHttpInvocationContextV1,
  service?: PluginContributionRef,
): Promise<GithubApiMediaClientV1> {
  const nativeService = service ?? GITHUB_CONNECTED_ACCOUNT_SERVICE;
  if (nativeService.pluginId !== context.plugin.id || nativeService.localId !== GITHUB_CONNECTED_ACCOUNT_ID) {
    throw new PluginError({
      code: 'github_credential_mismatch',
      message: 'The GitHub request did not carry this plugin’s native Connected Service.',
    });
  }
  const binding = await context.services.connectedAccounts.getBinding(GITHUB_CONNECTED_ACCOUNT_PURPOSE, { signal: context.signal });
  if (service !== undefined && binding !== null) {
    throw new PluginError({ code: 'github_credential_mismatch', message: 'The explicit native GitHub service cannot substitute a Connected Account.' });
  }
  const materialized = await context.services.connectedAccounts.materialize(
    GITHUB_CONNECTED_ACCOUNT_PURPOSE,
    { kind: 'httpHeaders', origin: GITHUB_API_ORIGIN, headerNames: ['authorization'] },
    { signal: context.signal, ...(binding ? { expectedAccount: binding.account } : { nativeService }) },
  );
  return createGithubApiClientFromMaterialization(context, materialized, binding?.account);
}

/**
 * Creates a client for one exact Action-owned account. The connected-account
 * owner compares `expectedAccount` with its exact current target, so a stored
 * ref cannot select a different same-service credential.
 */
export async function createGithubApiClient(
  context: GithubHttpInvocationContextV1,
  credentialRef: ConnectedAccountRef | null,
): Promise<GithubApiMediaClientV1> {
  if (credentialRef === null) return createGithubNativeApiClient(context, GITHUB_CONNECTED_ACCOUNT_SERVICE);
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
  return createGithubApiClientFromMaterialization(context, materialized, credentialRef);
}

/**
 * Creates a client for a genuine background/source inventory member. The
 * account must still be admitted by the exact current purpose target.
 */
export async function createGithubListedAccountApiClient(
  context: GithubHttpInvocationContextV1 & Pick<PluginInvocationContext, 'invocationId'>,
  credentialRef: ConnectedAccountRef,
): Promise<GithubApiMediaClientV1> {
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
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
  });
  if (!authorization.ok) {
    if (authorization.failure !== undefined) throw new TriageSourceAuthorizationErrorV1(authorization.failure);
    throw new PluginError(LISTED_ACCOUNT_AUTHORIZATION_REFUSALS[authorization.reason]);
  }
  return createGithubApiClientWithAuthorization(context, authorization.authorization, credentialRef);
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
  if (retryAfter !== null) {
    const retry = parseRetryAfterHeader(retryAfter, { nowMs });
    if (retry.retryAfterMs !== null) return retry.retryAfterMs;
  }
  if (readTriageResponseHeaderV1(headers, 'x-ratelimit-remaining') !== '0') return null;
  const reset = readTriageResponseHeaderV1(headers, 'x-ratelimit-reset');
  if (reset !== null && /^\d+$/u.test(reset)) {
    const resetAtMs = Number(reset) * 1_000;
    if (Number.isSafeInteger(resetAtMs)) return Math.max(0, resetAtMs - nowMs);
  }
  return null;
}

export function isGithubRateLimited(facts: GithubResponseFactsV1): boolean {
  if (facts.status !== 403 && facts.status !== 429) return false;
  const remaining = readTriageResponseHeaderV1(facts.headers, 'x-ratelimit-remaining');
  return facts.status === 429
    || remaining === '0'
    || readTriageResponseHeaderV1(facts.headers, 'retry-after') !== null
    || isGithubSecondaryRateLimitResponse(facts);
}

/**
 * Resolves the exact GitHub retry instruction when present, otherwise the
 * provider-documented minimum for a response classified as rate limited.
 */
export function readGithubRateLimitRetryAfterMs(
  facts: GithubResponseFactsV1,
  nowMs = Date.now(),
): number | null {
  if (!isGithubRateLimited(facts)) return null;
  return readGithubRetryAfterMs(facts.headers, nowMs) ?? GITHUB_RATE_LIMIT_FALLBACK_MS;
}
