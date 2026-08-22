import type { QualifiedConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  materializeTriageSourceAuthorizationV1,
  type TriageSourceAuthorizationFailureReasonV1,
} from '@happier-dev/triage-sources/runtime';

import { createAzureDevOpsFailure } from './failures.js';
import type {
  AzureDevOpsAuthorizationResult,
  AzureDevOpsListedAccountMaterializer,
  AzureDevOpsOrigin,
} from './types.js';

export const AZURE_DEVOPS_AUTHORIZATION_HEADER_NAME = 'authorization';

/**
 * Reauthorize and materialize the exact account this configured instance is bound to.
 *
 * `CONTRACT.md` §1 and §3.1: a Triage source reauthorizes the exact account its configured
 * instance is bound to, never the currently selected binding for the purpose. The host
 * re-verifies that the account is still authorized for the declared purpose before and after
 * materialization, and admits the request origin only if it is still a declared fixed origin or
 * one of that account's own configured origins.
 */
export async function materializeAzureDevOpsListedAuthorization(input: Readonly<{
  connectedAccounts: AzureDevOpsListedAccountMaterializer;
  purpose: string;
  account: QualifiedConnectedAccountRef;
  origin: AzureDevOpsOrigin;
  signal: AbortSignal;
}>): Promise<AzureDevOpsAuthorizationResult> {
  const authorization = await materializeTriageSourceAuthorizationV1({
    connectedAccounts: input.connectedAccounts,
    purpose: input.purpose,
    account: input.account,
    origin: input.origin.requestOrigin,
    signal: input.signal,
  });
  if (!authorization.ok) {
    // The host's rejection is deliberately not echoed: a materialization error can carry the
    // very material it failed to deliver.
    return { ok: false, failure: AUTHORIZATION_FAILURES[authorization.reason] };
  }
  return { ok: true, authorization: { headers: authorization.headers } };
}

/**
 * Azure DevOps's own name for each neutral refusal the shared forge materializer can report.
 *
 * The host materializes and this source consumes: no token is read from settings, accepted as an
 * operation parameter, or resolved through a hosting-provider credential helper. The result is
 * used inside the invocation that requested it and is never cached, memoized onto a client,
 * captured by a paging frontier, or written into any result, log line, or failure detail.
 */
const AUTHORIZATION_FAILURES: Readonly<
  Record<TriageSourceAuthorizationFailureReasonV1, ReturnType<typeof createAzureDevOpsFailure>>
> = Object.freeze({
  cancelled: createAzureDevOpsFailure({
    failureClass: 'cancelled',
    detail: 'Azure DevOps authorization was cancelled.',
  }),
  materializationFailed: createAzureDevOpsFailure({
    failureClass: 'unauthorized',
    detail: 'The configured Azure DevOps account could not be authorized.',
  }),
  unsupportedMaterialization: createAzureDevOpsFailure({
    failureClass: 'unauthorized',
    detail: 'The configured Azure DevOps account did not materialize HTTP headers.',
  }),
  authorizationHeaderMissing: createAzureDevOpsFailure({
    failureClass: 'unauthorized',
    detail: 'The configured Azure DevOps account materialized no authorization header.',
  }),
});
