import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { projectTriageSourceInvocationFailureV1 } from '@happier-dev/triage-sources/runtime';
import type {
  ReviewCommentClaimPublicationDispatchResponseV1,
  ReviewCommentPublicationResultV1,
} from '@happier-dev/plugin-sdk/reviews';

import { classifyGithubTransportFailure } from '../errors.js';
import { toTriageFailure } from '../mapping/protocol.js';

/**
 * Recording a publication with the canonical Reviews owner is an INTERNAL step, and
 * it happens after the external effect it describes already exists on GitHub.
 *
 * Letting that step's rejection propagate discards two things the user needs: the
 * publication result this invocation already proved by rereading the forge, and the
 * post-mutation exact `get` SCM 3.9.3 requires after every outcome that may have
 * changed provider state. Neither becomes less true because Happier's own server
 * could not be reached — and the comment is on a colleague's pull request either
 * way.
 *
 * So the failure is returned as a fact instead of thrown. Nothing is retried, no
 * receipt is written, and no uncertain entry is promoted: the canonical claim
 * remains outstanding at the server and a later rejoin settles it.
 */
export type GithubPublicationSettlementV1 = (
  claim: ReviewCommentClaimPublicationDispatchResponseV1,
  result: ReviewCommentPublicationResultV1,
) => Promise<void>;

/**
 * The publication is real; only Happier's record of it is missing. `transient`
 * because the exact same frozen claim can be settled by a later rejoin.
 */
export const GITHUB_PUBLICATION_UNRECORDED_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'transient',
  code: 'github_publication_settlement_unrecorded',
});

export async function recordGithubPublicationSettlement(
  settle: GithubPublicationSettlementV1 | undefined,
  claim: ReviewCommentClaimPublicationDispatchResponseV1,
  result: ReviewCommentPublicationResultV1,
): Promise<TriageSourceFailureV1 | undefined> {
  if (settle === undefined) return undefined;
  try {
    await settle(claim, result);
    return undefined;
  } catch (error) {
    if (isPluginError(error)) {
      return projectTriageSourceInvocationFailureV1(error, GITHUB_PUBLICATION_UNRECORDED_FAILURE.code);
    }
    // A cancelled invocation keeps its own name: the caller's lifetime ended, which
    // is a different fact from an unreachable settlement, and the same signal is
    // about to end the confirming read too.
    const classified = classifyGithubTransportFailure(error);
    return classified.code === 'github_request_cancelled'
      || classified.code === 'github_request_timed_out'
      ? toTriageFailure(classified)
      : GITHUB_PUBLICATION_UNRECORDED_FAILURE;
  }
}
