/** @moduleRealm daemon */
import {
  produceScmPullRequestReviewScope as canonicalProduceScmPullRequestReviewScope,
} from '@happier-dev/protocol';
import type {
  ScmPullRequestReviewScopeProductionV1 as ProtocolScmPullRequestReviewScopeProductionV1,
  ScmPullRequestReviewScopeV1 as ProtocolScmPullRequestReviewScopeV1,
} from '@happier-dev/protocol';

export {
  REVIEW_SCM_SCOPE_INPUT_KEY,
  ScmPullRequestReviewScopeV1Schema,
  ReviewScmScopeBaseRefSourceV1Schema,
  ReviewScmScopeBaseRefV1Schema,
  ReviewScmScopeDiagnosticCodeV1Schema,
  ReviewScmScopeDiagnosticV1Schema,
  ReviewScmScopeDiffV1Schema,
  ReviewScmScopePathDiffV1Schema,
  ReviewScmScopePathV1Schema,
  ReviewScmScopeV1Schema,
} from '@happier-dev/protocol';

export type {
  ReviewScmScopeBaseRefSourceV1,
  ReviewScmScopeBaseRefV1,
  ReviewScmScopeDiagnosticCodeV1,
  ReviewScmScopeDiagnosticV1,
  ReviewScmScopeDiffV1,
  ReviewScmScopePathDiffV1,
  ReviewScmScopePathV1,
  ReviewScmScopeV1,
} from '@happier-dev/protocol';

/** Protocol owns the strict schema; SDK owns the public author type identity. */
export type ScmPullRequestReviewScopeV1 = ProtocolScmPullRequestReviewScopeV1;

export type ScmPullRequestReviewScopeProductionV1 = ProtocolScmPullRequestReviewScopeProductionV1;

export const produceScmPullRequestReviewScope: typeof canonicalProduceScmPullRequestReviewScope =
  canonicalProduceScmPullRequestReviewScope;
