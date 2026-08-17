import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import type {
  BitbucketFailureClass,
  BitbucketTriageFailure,
} from '../failures.js';

/**
 * The source-neutral failure classes are closed, and Bitbucket observes two conditions the public
 * vocabulary does not enumerate. Neither is dropped and neither is silently promoted:
 *
 * - `notFound` becomes `unknown`. A `404` under a single Bitbucket credential cannot distinguish an
 *   invisible pull request from a missing one (§5.6), so it is explicitly not `permission` and
 *   explicitly not an absence proof. Its `route-not-found` code survives for the source's own
 *   diagnosis.
 * - `cancelled` becomes `transient`. A cancelled read learned nothing and is retryable; classifying
 *   it as `unknown` would present a deliberate abort as a provider defect.
 *
 * The stable Bitbucket `code` is preserved unchanged in both cases, so the projection loses the
 * generic class distinction and never the specific evidence.
 */
const TRIAGE_FAILURE_CLASS: Readonly<
  Record<BitbucketFailureClass, TriageSourceFailureV1['class']>
> = Object.freeze({
  authentication: 'authentication',
  permission: 'permission',
  rateLimit: 'rateLimit',
  notFound: 'unknown',
  transient: 'transient',
  unsupportedContract: 'unsupportedContract',
  cancelled: 'transient',
  unknown: 'unknown',
});

/**
 * Projects one bounded Bitbucket failure into the public source failure.
 *
 * `retryNotBeforeMs` travels only here, because a successful scan page has nowhere to express a
 * retry deadline. `detail` is already bounded, non-secret provider text at its producer.
 */
export function toTriageSourceFailure(
  failure: BitbucketTriageFailure,
): TriageSourceFailureV1 {
  return {
    class: TRIAGE_FAILURE_CLASS[failure.class] ?? 'unknown',
    code: failure.code,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    ...(failure.retryNotBeforeMs === undefined
      ? {}
      : { retryNotBeforeMs: failure.retryNotBeforeMs }),
  };
}
