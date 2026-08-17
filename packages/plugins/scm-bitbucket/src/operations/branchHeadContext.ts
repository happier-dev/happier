import type {
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';

function normalizeNameWithOwner(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!normalized) return null;
  const segments = normalized.split('/');
  return segments.length === 2 && segments.every((segment) => segment.length > 0) ? normalized : null;
}

export function matchesBitbucketBranchHeadContext(input: Readonly<{
  pullRequest: ScmPullRequestSummary;
  provider: ScmHostingProviderRef;
  baseBranch: string;
  headBranch: string;
}>): boolean {
  if (input.pullRequest.provider.id !== input.provider.id) return false;
  if (input.pullRequest.provider.kind !== input.provider.kind) return false;
  if (input.pullRequest.provider.baseUrl !== input.provider.baseUrl) return false;
  if (input.pullRequest.state !== 'open') return false;
  if (input.pullRequest.baseBranch !== input.baseBranch) return false;
  if (input.pullRequest.headBranch !== input.headBranch) return false;
  const expected = normalizeNameWithOwner(input.provider.nameWithOwner);
  const actual = normalizeNameWithOwner(input.pullRequest.headRepositoryNameWithOwner);
  return Boolean(expected && actual && expected === actual);
}

export function findMatchingBitbucketPullRequest(input: Readonly<{
  pullRequests: readonly ScmPullRequestSummary[];
  provider: ScmHostingProviderRef;
  baseBranch: string;
  headBranch: string;
}>): ScmPullRequestSummary | null {
  return input.pullRequests.find((pullRequest) => matchesBitbucketBranchHeadContext({
    pullRequest,
    provider: input.provider,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
  })) ?? null;
}

export function isPullRequestSummary(value: unknown): value is ScmPullRequestSummary {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { title?: unknown }).title === 'string'
    && typeof (value as { url?: unknown }).url === 'string'
    && typeof (value as { baseBranch?: unknown }).baseBranch === 'string'
    && typeof (value as { headBranch?: unknown }).headBranch === 'string'
  );
}
