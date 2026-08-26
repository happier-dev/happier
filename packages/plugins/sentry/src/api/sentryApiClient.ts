/**
 * The only Sentry HTTP client (`SENTRY.md` §2.3a).
 *
 * `INV-12` is about *containment* of the materialization, not denial of it. The
 * credential is materialized once inside this closure, sent only to the exact
 * configured deployment origin, and never returned, logged, memoized across
 * invocations, or echoed into any outcome. Every read is a `GET` that refuses to
 * follow a redirect, because a followed redirect would carry the bearer token to
 * an origin the HostAccess declaration never admitted.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  isBoundedInvocationDeadline,
  materializeTriageSourceAuthorizationV1,
  type TriageSourceAuthorizationFailureReasonV1,
} from '@happier-dev/triage-sources/runtime';

import {
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_FAILURE_CODES,
  type SentryFailureV1,
  type SentryOperationV1,
} from '../sentryContracts.js';
import type { SentryDeploymentV1 } from '../auth/sentryOrigin.js';

import { classifySentryFailure } from './sentryFailure.js';

export type SentryApiResponseV1 = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  bodyText: string;
}>;

export type SentryApiOutcomeV1 =
  | Readonly<{ kind: 'response'; response: SentryApiResponseV1 }>
  | Readonly<{ kind: 'failed'; failure: SentryFailureV1 }>;

export type SentryApiClientV1 = Readonly<{
  request(input: Readonly<{
    url: string;
    operation: SentryOperationV1;
  }>): Promise<SentryApiOutcomeV1>;
}>;

export type SentryApiClientInputV1 = Readonly<{
  account: ConnectedAccountRef;
  deployment: SentryDeploymentV1;
  nowMs: () => number;
  /**
   * The signal every request and the account materialization run under.
   *
   * Omitted by the three invocations Triage starts and bounds itself, which pass
   * nothing and therefore run under the caller's own signal unchanged. A caller
   * that Triage does not bound — a mounted detail read — supplies its own
   * invocation-bounded signal here, so the materialization is inside the bound
   * too rather than only the fetch that follows it.
   */
  signal?: AbortSignal;
}>;

/**
 * `llmFormat` returns provider-composed prose that would bypass this source's
 * redaction owner entirely, so no request may carry it.
 */
const FORBIDDEN_QUERY_PARAMETERS = Object.freeze(['llmFormat']);

function failed(failure: SentryFailureV1): SentryApiOutcomeV1 {
  return Object.freeze({ kind: 'failed' as const, failure });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * The exact-account materialization rule is the shared source contract and lives in
 * `@happier-dev/triage-protocol/v1`; Sentry's published failure vocabulary is not, so
 * the three settled refusal reasons are mapped here and nowhere else.
 *
 * A host refusal is a **credential** problem the user can fix, so it is
 * `authentication` — never `transient`. Reporting it as a transport failure would
 * route it into the aggregate's provider-pacing backoff, which deliberately exempts
 * `authentication` so that reconnecting and pressing Refresh works immediately
 * (`refresh/refreshEligibility.ts`).
 *
 * `cancelled` is deliberately absent: the shared owner has one neutral word for
 * every abort, and which abort it was is a fact only this side holds. It is
 * resolved per invocation against the signal instead, so a materialization that
 * outlived this source's own bound is not reported as somebody cancelling.
 */
const AUTHORIZATION_FAILURES: Readonly<
  Record<Exclude<TriageSourceAuthorizationFailureReasonV1, 'cancelled'>, SentryFailureV1>
> = Object.freeze({
  materializationFailed: {
    class: 'authentication' as const,
    code: SENTRY_FAILURE_CODES.accountMaterializationFailed,
  },
  unsupportedMaterialization: {
    class: 'unsupportedContract' as const,
    code: SENTRY_FAILURE_CODES.unsupportedMaterialization,
  },
  authorizationHeaderMissing: {
    class: 'authentication' as const,
    code: SENTRY_FAILURE_CODES.authorizationHeaderUnavailable,
  },
});

export async function createSentryApiClient(
  context: PluginInvocationContext,
  input: SentryApiClientInputV1,
): Promise<SentryApiClientV1> {
  const { origin } = input.deployment;
  const signal = input.signal ?? context.signal;
  let authorization: string | SentryFailureV1 | undefined;

  /**
   * An abort is not one fact. A person who navigated away cancelled; a
   * deployment that never answered inside this source's own bound did not, and
   * calling the second `cancelled` hides a stalled Sentry behind a word that
   * says nothing is wrong.
   */
  const abortFailure = (operation: SentryOperationV1): SentryFailureV1 => classifySentryFailure(
    isBoundedInvocationDeadline(signal.reason)
      ? { kind: 'deadline', operation }
      : { kind: 'cancelled', operation },
  );

  async function resolveAuthorization(
    operation: SentryOperationV1,
  ): Promise<string | SentryFailureV1> {
    if (authorization !== undefined) return authorization;
    // `CONTRACT.md` §3.1: every Sentry request is bound to one exact account
    // that this invocation already observed in the bounded metadata listing, so
    // the exact-account seam — not the selected binding — is the only correct
    // materializer. The host reauthorizes the purpose and revalidates the
    // origin against that account around the materialization; this source can
    // neither select nor fall through to a different authorized account.
    //
    // The rule itself is the shared source contract, so it is consumed rather
    // than re-spelled: a private copy is what let a host refusal escape as an
    // untyped rejection and be classified as an upstream outage.
    const outcome = await materializeTriageSourceAuthorizationV1({
      connectedAccounts: context.services.connectedAccounts,
      purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
      account: input.account,
      origin,
      signal,
    });
    if (outcome.ok) {
      authorization = outcome.authorization;
    } else {
      authorization = outcome.reason === 'cancelled'
        ? abortFailure(operation)
        : AUTHORIZATION_FAILURES[outcome.reason];
    }
    return authorization;
  }

  return Object.freeze({
    async request(request): Promise<SentryApiOutcomeV1> {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return failed(Object.freeze({
          class: 'unsupportedContract' as const,
          code: SENTRY_FAILURE_CODES.invokedOriginMismatch,
        }));
      }
      if (url.origin !== origin || url.username !== '' || url.password !== '') {
        return failed(Object.freeze({
          class: 'unsupportedContract' as const,
          code: SENTRY_FAILURE_CODES.invokedOriginMismatch,
        }));
      }
      if (FORBIDDEN_QUERY_PARAMETERS.some((name) => url.searchParams.has(name))) {
        return failed(Object.freeze({
          class: 'unsupportedContract' as const,
          code: SENTRY_FAILURE_CODES.responseUnparseable,
        }));
      }
      // A multi-request read whose deadline elapsed between two of its calls
      // reaches here rather than the transport, and must still say which of the
      // two aborts happened.
      if (signal.aborted) return failed(abortFailure(request.operation));

      const bearer = await resolveAuthorization(request.operation);
      if (typeof bearer !== 'string') return failed(bearer);

      let response: Awaited<ReturnType<typeof context.services.http.request>>;
      try {
        response = await context.services.http.request({
          url: request.url,
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: bearer },
          redirect: 'error',
        }, { signal });
      } catch (error) {
        return failed(
          isAbortError(error) || signal.aborted
            ? abortFailure(request.operation)
            : classifySentryFailure({ kind: 'transport', operation: request.operation }),
        );
      }

      return Object.freeze({
        kind: 'response' as const,
        response: Object.freeze({
          status: response.status,
          headers: response.headers,
          bodyText: new TextDecoder().decode(response.body),
        }),
      });
    },
  });
}
