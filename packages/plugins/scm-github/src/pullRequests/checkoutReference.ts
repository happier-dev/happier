import type {
  HostingProviderPullRequestCheckoutReferenceMetadata as ScmHostingProviderPullRequestCheckoutReferenceMetadata,
} from '@happier-dev/plugin-sdk/scm/hosting';
import type { ScmPullRequestSummary } from '@happier-dev/plugin-sdk/scm';

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
