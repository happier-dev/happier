import type {
  ConnectedAccountRef,
  ConnectedAccountsService,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import {
  materializeForgeAuthorization,
  type ForgeAuthorizationFailureReason,
} from '@happier-dev/scm-forge-adapter';

import {
  BITBUCKET_CLOUD_API_ORIGIN,
  createBitbucketTriageApiClient,
  type BitbucketTriageApiClient,
} from '../apiClient.js';
import { createBitbucketFailure, type BitbucketTriageFailure } from '../failures.js';

/** Everything one bounded source invocation needs from the host, and nothing more. */
export type BitbucketSourceRuntime = Readonly<{
  connectedAccounts: ConnectedAccountsService;
  http: HttpService;
  now: () => number;
  signal?: AbortSignal;
}>;

export type BitbucketAuthorizedClientOutcome =
  | Readonly<{ ok: true; client: BitbucketTriageApiClient }>
  | Readonly<{ ok: false; failure: BitbucketTriageFailure }>;

/**
 * Classifies a throw from the host Connected Accounts service on the paths that call it
 * directly — account discovery, which materializes nothing.
 *
 * A rejection there means this exact account cannot currently authorize the request, so it is
 * reported as an authentication failure attributed to that binding rather than as a transport fault
 * that would invite a blind retry.
 */
export function classifyBitbucketAuthorizationThrow(error: unknown): BitbucketTriageFailure {
  const name = typeof error === 'object' && error !== null
    ? (error as { name?: unknown }).name
    : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return createBitbucketFailure('cancelled', 'invocation-cancelled');
  }
  return createBitbucketFailure('authentication', 'account-materialization-failed');
}

/**
 * Bitbucket's own name for each neutral refusal the shared forge materializer can report.
 *
 * A refused materialization means this exact account cannot currently authorize the request, so it
 * is an authentication failure attributed to that binding rather than a transport fault that would
 * invite a blind retry.
 */
const AUTHORIZATION_FAILURES: Readonly<
  Record<ForgeAuthorizationFailureReason, BitbucketTriageFailure>
> = Object.freeze({
  cancelled: createBitbucketFailure('cancelled', 'invocation-cancelled'),
  materializationFailed: createBitbucketFailure('authentication', 'account-materialization-failed'),
  unsupportedMaterialization: createBitbucketFailure(
    'unsupportedContract',
    'account-materialization-kind',
  ),
  // Sending the request without it would spend the read anonymously and then classify
  // Bitbucket's `401`/`404` as though this account had been refused.
  authorizationHeaderMissing: createBitbucketFailure(
    'authentication',
    'account-authorization-unavailable',
  ),
});

/**
 * Builds one invocation-scoped client bound to one exact authorized account.
 *
 * Authorization happens through the generic Connected Accounts owner for the exact listed account —
 * never through the selected binding, which is a user preference rather than this invocation's
 * authority. The materialized header lives only in this closure: it reaches no result, no
 * configuration token, no locator, no log line, and no persisted row.
 */
export async function createAuthorizedBitbucketClient(
  runtime: BitbucketSourceRuntime,
  request: Readonly<{ purpose: string; account: ConnectedAccountRef }>,
): Promise<BitbucketAuthorizedClientOutcome> {
  const authorization = await materializeForgeAuthorization({
    connectedAccounts: runtime.connectedAccounts,
    purpose: request.purpose,
    account: request.account,
    origin: BITBUCKET_CLOUD_API_ORIGIN,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  if (!authorization.ok) {
    // The host's rejection is never echoed: it can carry the very material it failed to deliver.
    return { ok: false, failure: AUTHORIZATION_FAILURES[authorization.reason] };
  }

  const headers = authorization.headers;
  return {
    ok: true,
    client: createBitbucketTriageApiClient({
      http: runtime.http,
      now: runtime.now,
      authorize: async () => headers,
    }),
  };
}
