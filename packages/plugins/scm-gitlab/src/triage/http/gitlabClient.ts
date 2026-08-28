/**
 * The GitLab provider API client.
 *
 * Two rules shape everything here:
 *
 * 1. **The host materializes; this client consumes, inside one invocation.** The
 *    credential is requested once per invocation for the declared purpose and the
 *    exact configured origin, lives only in this closure, and is never returned,
 *    logged, cached, memoized, or attached to a frontier. Material minted for one
 *    origin can never be sent to another because the origin travels in the
 *    materialization request itself.
 * 2. **A response never becomes a scheduler.** A rate limit settles as an ordinary
 *    failure carrying GitLab's own absolute deadline when GitLab supplied one. This
 *    client never sleeps, never retries, and never waits through a reset.
 */

import type {
  ConnectedAccountRef,
  ConnectedAccountsService,
} from '@happier-dev/plugin-sdk/connected-accounts';
import {
  isBoundedInvocationDeadline,
  materializeTriageSourceAuthorizationV1,
  type TriageSourceAuthorizationFailureReasonV1,
} from '@happier-dev/triage-sources/runtime';

import type { GitlabConfiguredOrigin } from '../origin.js';
import type { GitlabFailure } from '../types.js';
import type { GitlabResponseHeaders } from './gitlabHeaders.js';
import { readGitlabRetryEvidence } from './gitlabRateLimit.js';

/** GitLab REST collections accept at most 100 rows through `per_page`. */
export const GITLAB_REST_MAX_PAGE_SIZE = 100;

export type GitlabHttpResponse = Readonly<{
  status: number;
  statusText: string;
  headers: GitlabResponseHeaders;
  text(): Promise<string>;
}>;

export type GitlabHttpFetcher = (
  url: string,
  init: Readonly<{
    method: GitlabRequestMethod;
    headers: Readonly<Record<string, string>>;
    /** Already-encoded request bytes. Absent on every read. */
    body?: Uint8Array;
    redirect: 'error';
    signal: AbortSignal;
  }>,
) => Promise<GitlabHttpResponse>;

/**
 * The verbs this source may send.
 *
 * It is deliberately a closed set rather than `string`: the manifest network
 * grant enumerates exactly these, and the host revalidates the method at
 * dispatch, so a verb that is expressible here but ungranted there is a runtime
 * refusal no unit test would see.
 */
export type GitlabRequestMethod = 'GET' | 'POST' | 'PUT';

/**
 * The narrow slice of the host Connected Accounts service this client consumes.
 * Nothing here reads settings, resolves a hosting token, or accepts a credential as
 * an operation parameter.
 */
export type GitlabConnectedAccounts = Pick<
  ConnectedAccountsService,
  'listAccounts' | 'getBinding' | 'materializeListedAccount'
>;

export type GitlabAuthorizationInput = Readonly<{
  connectedAccounts: GitlabConnectedAccounts;
  /** The declared Connected Account purpose for this source. */
  purpose: string;
  /**
   * The exact configured account this invocation was asked to observe. It is
   * reauthorized on every invocation and never falls through to whichever
   * account happens to be selected for the purpose: a source that observes two
   * accounts must be able to reach the one it was invoked for, and only that one.
   */
  account: ConnectedAccountRef;
  origin: GitlabConfiguredOrigin;
  signal: AbortSignal;
}>;

/**
 * One invocation's authorization. It is deliberately not exported as a reusable
 * client object: holding it past the invocation would keep the credential alive in a
 * closure the host can no longer revoke.
 */
export type GitlabAuthorizedInvocation = Readonly<{
  origin: GitlabConfiguredOrigin;
  headers: Readonly<Record<string, string>>;
}>;

export type GitlabAuthorizationResult =
  | Readonly<{ kind: 'authorized'; invocation: GitlabAuthorizedInvocation }>
  | Readonly<{ kind: 'failed'; failure: GitlabFailure }>;

/**
 * The exact-account materialization is the shared forge rule and lives in
 * `@happier-dev/triage-sources`; GitLab's published failure vocabulary is not, so the
 * neutral refusal reason is mapped here and nowhere else.
 */
const AUTHORIZATION_FAILURES: Readonly<
  Record<TriageSourceAuthorizationFailureReasonV1, GitlabFailure>
> = Object.freeze({
  cancelled: {
    class: 'transient',
    code: 'cancelled',
    detail: 'The configured GitLab account could not be authorized for this origin.',
  },
  materializationFailed: {
    class: 'authentication',
    code: 'materialization-failed',
    detail: 'The configured GitLab account could not be authorized for this origin.',
  },
  unsupportedMaterialization: {
    class: 'unsupportedContract',
    code: 'unsupported-materialization',
    detail: 'GitLab requires HTTP-header materialization.',
  },
  authorizationHeaderMissing: {
    class: 'authentication',
    code: 'authorization-header-unavailable',
    detail: 'The configured GitLab account supplied no authorization header.',
  },
});

export async function authorizeGitlabInvocation(
  input: GitlabAuthorizationInput,
): Promise<GitlabAuthorizationResult> {
  const authorization = await materializeTriageSourceAuthorizationV1({
    connectedAccounts: input.connectedAccounts,
    purpose: input.purpose,
    account: input.account,
    origin: input.origin.origin,
    signal: input.signal,
  });
  if (!authorization.ok) {
    // The host's rejection is deliberately not echoed: it can carry the very material it
    // failed to deliver.
    return { kind: 'failed', failure: AUTHORIZATION_FAILURES[authorization.reason] };
  }

  return {
    kind: 'authorized',
    invocation: {
      origin: input.origin,
      headers: Object.freeze({ ...authorization.headers, Accept: 'application/json' }),
    },
  };
}

/**
 * Builds an absolute `/api/v4` URL under the exact configured origin. A configured
 * path prefix is part of the binding and is preserved verbatim.
 */
export function buildGitlabApiUrl(
  origin: GitlabConfiguredOrigin,
  path: string,
  query?: ReadonlyArray<readonly [string, string]>,
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${origin.normalized}/api/v4${normalizedPath}`);
  for (const [key, value] of query ?? []) {
    url.searchParams.append(key, value);
  }
  return url.toString();
}

/**
 * The GraphQL endpoint of the exact configured deployment.
 *
 * It is NOT under `/api/v4`, so it cannot be built by `buildGitlabApiUrl`, and it
 * is built here rather than in a mutation module so every URL this source sends a
 * credential to is minted under one origin rule.
 */
export function buildGitlabGraphqlUrl(origin: GitlabConfiguredOrigin): string {
  return new URL(`${origin.normalized}/api/graphql`).toString();
}

export type GitlabJsonResponse = Readonly<{
  body: unknown;
  headers: GitlabResponseHeaders;
  /** Raw item count of the decoded array, before any tolerant row decoding. */
  rawItemCount: number | null;
}>;

export type GitlabRequestResult =
  | Readonly<{ kind: 'ok'; response: GitlabJsonResponse }>
  /**
   * `status` is present exactly when GitLab answered and the answer was not
   * 2xx. A mutation branches on the provider's own documented codes — `405`
   * cannot-merge, `409` head race and `422` merge-ran-and-failed are three
   * different answers to the user — and reconstructing them from the mapped
   * failure code would be a second classifier.
   */
  | Readonly<{ kind: 'failed'; failure: GitlabFailure; status?: number }>;

export type GitlabTextRequestResult =
  | Readonly<{
    kind: 'ok';
    response: Readonly<{ bodyText: string; headers: GitlabResponseHeaders }>;
  }>
  | Readonly<{ kind: 'failed'; failure: GitlabFailure; status?: number }>;

export type GitlabRequestInput = Readonly<{
  invocation: GitlabAuthorizedInvocation;
  /** Absolute URL. A next-page URL is passed through byte-for-byte. */
  url: string;
  /** Absent means `GET`, which is what every read of this source sends. */
  method?: GitlabRequestMethod;
  /**
   * The request document, JSON-encoded here so a mutation never hand-builds a
   * body or a content type. Absent on every read.
   */
  body?: unknown;
  /** Overrides the invocation's JSON default for a declared raw-text resource. */
  accept?: 'application/json' | 'text/plain';
  fetcher: GitlabHttpFetcher;
  signal: AbortSignal;
  /** Injected clock. Reading the ambient clock here makes every deadline untestable. */
  nowMs: number;
}>;

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'AbortError';
}

function isSameConfiguredOrigin(url: string, origin: GitlabConfiguredOrigin): boolean {
  try {
    const parsed = new URL(url);
    const expected = new URL(origin.normalized);
    if (parsed.origin !== expected.origin) return false;
    return parsed.pathname.startsWith(expected.pathname === '/' ? '/' : `${expected.pathname}/`);
  } catch {
    return false;
  }
}

/** Classifies a GitLab response status. `403` is a permission answer, not a throttle. */
export function classifyGitlabFailure(
  status: number,
  headers: GitlabResponseHeaders,
  nowMs: number,
): GitlabFailure {
  if (status === 401) {
    return { class: 'authentication', code: 'unauthorized' };
  }
  if (status === 403) {
    return { class: 'permission', code: 'forbidden' };
  }
  if (status === 404) {
    return { class: 'unknown', code: 'not-found' };
  }
  if (status === 429) {
    const evidence = readGitlabRetryEvidence(headers, nowMs);
    return {
      class: 'rateLimit',
      code: 'too-many-requests',
      ...(evidence ? { retryNotBeforeMs: evidence.retryNotBeforeMs } : {}),
    };
  }
  if (status >= 300 && status < 400) {
    return { class: 'unsupportedContract', code: 'unexpected-redirect' };
  }
  if (status >= 500) {
    return { class: 'transient', code: 'server-error' };
  }
  return { class: 'unknown', code: `http-${status}` };
}

export async function requestGitlabText(
  input: GitlabRequestInput,
): Promise<GitlabTextRequestResult> {
  if (!isSameConfiguredOrigin(input.url, input.invocation.origin)) {
    return {
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'origin-mismatch',
        detail: 'A GitLab request may only address the configured binding origin.',
      },
    };
  }

  const method = input.method ?? 'GET';
  if (method === 'GET' && input.body !== undefined) {
    // A read that carries a document is a mutation someone forgot to declare.
    return {
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'unexpected-request-body',
        detail: 'A GitLab read may not carry a request document.',
      },
    };
  }

  let response: GitlabHttpResponse;
  try {
    response = await input.fetcher(input.url, {
      method,
      headers: input.body === undefined
        ? { ...input.invocation.headers, ...(input.accept ? { Accept: input.accept } : {}) }
        : {
          ...input.invocation.headers,
          ...(input.accept ? { Accept: input.accept } : {}),
          'Content-Type': 'application/json',
        },
      ...(input.body === undefined
        ? {}
        : { body: new TextEncoder().encode(JSON.stringify(input.body)) }),
      // A redirect is refused rather than followed: following one would send the
      // binding's credential to whatever host the response named.
      redirect: 'error',
      signal: input.signal,
    });
  } catch (error) {
    return {
      kind: 'failed',
      // Three different things, and the reader is owed the one that is true: this source's own
      // deadline elapsed, the caller went away, or the request never completed. Folding the first
      // into either of the others tells a person their panel was cancelled when in fact GitLab
      // stopped answering.
      failure: isBoundedInvocationDeadline(error)
        ? { class: 'transient', code: 'deadline-exceeded' }
        : isAbortError(error)
          ? { class: 'transient', code: 'cancelled' }
          : { class: 'transient', code: 'transport-failed' },
    };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      kind: 'failed',
      status: response.status,
      failure: classifyGitlabFailure(response.status, response.headers, input.nowMs),
    };
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    return {
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'undecodable-body' },
    };
  }

  return {
    kind: 'ok',
    response: {
      bodyText,
      headers: response.headers,
    },
  };
}

export async function requestGitlabJson(input: GitlabRequestInput): Promise<GitlabRequestResult> {
  const result = await requestGitlabText(input);
  if (result.kind === 'failed') return result;

  let body: unknown;
  try {
    body = result.response.bodyText === '' ? null : JSON.parse(result.response.bodyText);
  } catch {
    return {
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'undecodable-body' },
    };
  }

  return {
    kind: 'ok',
    response: {
      body,
      headers: result.response.headers,
      rawItemCount: Array.isArray(body) ? body.length : null,
    },
  };
}
