import type {
  ScmHostingProviderPullRequestCheckoutReferenceMetadata,
} from '@happier-dev/plugin-sdk';
import type { ScmPullRequestSummary } from '@happier-dev/protocol';

export function resolveGithubCheckoutReferenceFromPullRequest(
  pullRequest: ScmPullRequestSummary,
): ScmHostingProviderPullRequestCheckoutReferenceMetadata {
  return {
    pullRequest,
    branch: pullRequest.headBranch,
    ...(pullRequest.headSha !== undefined ? { headSha: pullRequest.headSha } : {}),
    ...(pullRequest.baseSha !== undefined ? { baseSha: pullRequest.baseSha } : {}),
  };
}
