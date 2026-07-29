import type {
  ScmHostingProviderPullRequestCheckoutReferenceMetadata,
} from '@happier-dev/plugin-sdk/experimental/scm/hostingProvider';
import type { ScmPullRequestSummary } from '@happier-dev/plugin-sdk/experimental/scm';

export function resolveGithubCheckoutReferenceFromPullRequest(
  pullRequest: ScmPullRequestSummary,
): ScmHostingProviderPullRequestCheckoutReferenceMetadata {
  return {
    pullRequest,
    branch: pullRequest.headBranch,
    ...(pullRequest.number ? { remoteRef: `refs/pull/${pullRequest.number}/head` } : {}),
    ...(pullRequest.headSha !== undefined ? { headSha: pullRequest.headSha } : {}),
    ...(pullRequest.baseSha !== undefined ? { baseSha: pullRequest.baseSha } : {}),
  };
}
