import {
  MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import type { AzureDevOpsFailure, AzureDevOpsFailureClass } from './types.js';

/**
 * Projection of this source's provider failure vocabulary onto the closed contract classes.
 *
 * `code` is this source's own stable local id and is the value a reader should key on; `class`
 * is the coarse shared classification. Nothing here invents a retry schedule: `retryNotBeforeMs`
 * appears only when Azure's own response evidence produced one (`CONTRACT.md` §5.2).
 */
const FAILURE_PROJECTION: Readonly<Record<AzureDevOpsFailureClass, Readonly<{
  class: TriageSourceFailureV1['class'];
  code: string;
}>>> = {
  rateLimit: { class: 'rateLimit', code: 'azure-devops/rate-limited' },
  // Includes the sign-in interception: Azure answers an unusable credential with an HTML
  // sign-in page rather than a 401, and reporting that as a parsing fault would send a user
  // hunting a phantom bug instead of reconnecting the account.
  unauthorized: { class: 'authentication', code: 'azure-devops/unauthorized' },
  forbidden: { class: 'permission', code: 'azure-devops/forbidden' },
  /**
   * Azure documents `404` as nonexistent **or** not permitted to view, and no second read
   * separates them. Claiming `permission` would assert a cause we did not observe, and claiming
   * absence would delete a row the user may simply not be allowed to see, so the honest class is
   * `unknown` with this source's exact code.
   */
  notFoundOrForbidden: { class: 'unknown', code: 'azure-devops/not-found-or-forbidden' },
  invalidRequest: { class: 'unsupportedContract', code: 'azure-devops/invalid-request' },
  conflict: { class: 'unknown', code: 'azure-devops/conflict' },
  server: { class: 'transient', code: 'azure-devops/server-error' },
  transport: { class: 'transient', code: 'azure-devops/transport-error' },
  cancelled: { class: 'transient', code: 'azure-devops/cancelled' },
  unexpectedRedirect: { class: 'unsupportedContract', code: 'azure-devops/unexpected-redirect' },
  malformedResponse: { class: 'unsupportedContract', code: 'azure-devops/malformed-response' },
};

/**
 * Project one provider failure into the bounded public failure.
 *
 * The contract bound is enforced here rather than assumed from the client's own bound: this is
 * the last owner before the value crosses the plugin boundary, and a producer that grew a wider
 * detail must not be able to reject the whole trusted result. Nothing else from the response —
 * status line, headers, rate-limit diagnostics, or body — crosses here.
 */
export function projectAzureSourceFailure(failure: AzureDevOpsFailure): TriageSourceFailureV1 {
  const projection = FAILURE_PROJECTION[failure.class];
  // `detail` is a single-line V1 string, and a transport `Error.message` or provider body
  // routinely spans lines: normalizing here is what keeps a control-bearing detail from
  // rejecting the whole result it was written to explain.
  const detail = projectTriageDisplayTextV1(
    failure.detail,
    MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1,
  ).value;
  return {
    class: projection.class,
    code: projection.code,
    ...(detail.length === 0 ? {} : { detail }),
    ...(failure.retryNotBeforeMs === null || failure.retryNotBeforeMs < 0
      ? {}
      : { retryNotBeforeMs: Math.floor(failure.retryNotBeforeMs) }),
  };
}

/** A source-local failure that never touched the provider, in the same closed vocabulary. */
export function createAzureSourceFailure(input: Readonly<{
  class: TriageSourceFailureV1['class'];
  code: string;
  detail: string;
}>): TriageSourceFailureV1 {
  return {
    class: input.class,
    code: input.code,
    detail: projectTriageDisplayTextV1(
      input.detail,
      MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1,
    ).value,
  };
}
