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
}>;

/**
 * `llmFormat` returns provider-composed prose that would bypass this source's
 * redaction owner entirely, so no request may carry it.
 */
const FORBIDDEN_QUERY_PARAMETERS = Object.freeze(['llmFormat']);

function failed(failure: SentryFailureV1): SentryApiOutcomeV1 {
  return Object.freeze({ kind: 'failed' as const, failure });
}

function readAuthorizationHeader(headers: Readonly<Record<string, string>>): string | null {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization');
  const value = entry?.[1]?.trim();
  return value === undefined || value === '' ? null : value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export async function createSentryApiClient(
  context: PluginInvocationContext,
  input: SentryApiClientInputV1,
): Promise<SentryApiClientV1> {
  const { origin } = input.deployment;
  let authorization: string | null | undefined;

  async function resolveAuthorization(): Promise<string | null> {
    if (authorization !== undefined) return authorization;
    // `CONTRACT.md` §3.1: every Sentry request is bound to one exact account
    // that this invocation already observed in the bounded metadata listing, so
    // the exact-account seam — not the selected binding — is the only correct
    // materializer. The host reauthorizes the purpose and revalidates the
    // origin against that account around the materialization; this source can
    // neither select nor fall through to a different authorized account.
    const materialized = await context.services.connectedAccounts.materializeListedAccount(
      {
        purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
        account: input.account,
        materialization: { kind: 'httpHeaders', origin, headerNames: ['authorization'] },
      },
      { signal: context.signal },
    );
    authorization = materialized.kind === 'httpHeaders'
      ? readAuthorizationHeader(materialized.headers)
      : null;
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
      if (context.signal.aborted) {
        return failed(classifySentryFailure({ kind: 'cancelled', operation: request.operation }));
      }

      let response: Awaited<ReturnType<typeof context.services.http.request>>;
      try {
        const bearer = await resolveAuthorization();
        if (bearer === null) {
          return failed(Object.freeze({
            class: 'authentication' as const,
            code: SENTRY_FAILURE_CODES.tokenInvalid,
          }));
        }
        response = await context.services.http.request({
          url: request.url,
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: bearer },
          redirect: 'error',
        }, { signal: context.signal });
      } catch (error) {
        return failed(classifySentryFailure(
          isAbortError(error) || context.signal.aborted
            ? { kind: 'cancelled', operation: request.operation }
            : { kind: 'transport', operation: request.operation },
        ));
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
