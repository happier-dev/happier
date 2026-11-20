import { GITHUB_FEEDBACK_THREAD_PAGE_SIZE_V1, GITHUB_FEEDBACK_REVIEW_PAGE_SIZE_V1, GITHUB_FEEDBACK_REQUEST_PAGE_SIZE_V1 } from './feedbackPageSizes.js';
import { buildGithubRepositoryKey } from './locator.js';

// GitHub GraphQL Checks/Commits schema, checked 2026-10-02. Both concrete
// context types expose isRequired(pullRequestNumber:). 100 is GitHub's page
// maximum, not a suite-size cap; traverse the entire connection.
// PullRequest/MergeQueueEntry native fields checked 2026-10-24 against GitHub's
// Pull requests reference. Body-free summaries reuse Feedback's mounted windows.
export const githubChecksRepositoryFields = `
    isArchived @include(if: $includeSummary)
    hasIssuesEnabled @include(if: $includeSummary)
    mergeCommitAllowed @include(if: $includeSummary)
    squashMergeAllowed @include(if: $includeSummary)
    rebaseMergeAllowed @include(if: $includeSummary)
    pullRequest(number: $number) {
    headRefOid
    id @include(if: $includeSummary)
    viewerSubscription @include(if: $includeSummary)
    reviewDecision
    mergeStateStatus @include(if: $includeSummary)
    viewerCanMergeAsAdmin @include(if: $includeSummary)
    viewerCanUpdate @include(if: $includeSummary)
    viewerCanEnableAutoMerge @include(if: $includeSummary)
    viewerCanDisableAutoMerge @include(if: $includeSummary)
    mergeQueueEntry @include(if: $includeSummary) { id state position estimatedTimeToMerge }
    reviews(last: ${GITHUB_FEEDBACK_REVIEW_PAGE_SIZE_V1}) @include(if: $includeSummary) {
      nodes { id author { login } state submittedAt } pageInfo { hasPreviousPage }
    }
    reviewRequests(first: ${GITHUB_FEEDBACK_REQUEST_PAGE_SIZE_V1}) @include(if: $includeSummary) {
      nodes { requestedReviewer { __typename ... on User { login } ... on Team { name slug } } }
      pageInfo { hasNextPage }
    }
    reviewThreads(last: ${GITHUB_FEEDBACK_THREAD_PAGE_SIZE_V1}) @include(if: $includeSummary) {
      nodes { id isResolved } pageInfo { hasPreviousPage }
    }
    commits(last: 1) { nodes { commit { oid statusCheckRollup {
      contexts(first: 100, after: $cursor) { nodes {
        __typename
        ... on CheckRun { id databaseId name status conclusion detailsUrl startedAt completedAt annotations(first: 1) { totalCount }
          checkSuite { createdAt app { slug } commit { oid } repository { nameWithOwner } workflowRun { databaseId runAttempt } }
          isRequired(pullRequestNumber: $number) title @include(if: $includeOutput) summary @include(if: $includeOutput)
          text @include(if: $includeOutput) }
        ... on StatusContext { id context state targetUrl createdAt updatedAt isRequired(pullRequestNumber: $number)
          description @include(if: $includeOutput) }
      } pageInfo { hasNextPage endCursor } }
    } } } }
  }`;

export const GITHUB_CHECKS_QUERY = `query Checks($owner: String!, $name: String!, $number: Int!, $cursor: String, $includeSummary: Boolean!, $includeOutput: Boolean!) {
  repository(owner: $owner, name: $name) { ${githubChecksRepositoryFields} }
}`;

type GithubChecksQueryVariables = Readonly<{
  owner: string;
  name: string;
  number: number;
  cursor: string | null;
  includeSummary: boolean;
  includeOutput: boolean;
}>;

export function encodeGithubChecksQueryBody(variables: GithubChecksQueryVariables): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ query: GITHUB_CHECKS_QUERY, variables }));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The Team watcher may page the Checks rollup with both disclosure flags off. */
export function readGithubWatcherChecksQuery(body: Uint8Array | undefined) {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 2 || parsed.query !== GITHUB_CHECKS_QUERY
    || !isRecord(parsed.variables) || Object.keys(parsed.variables).length !== 6) return null;
  const { owner, name, number, cursor, includeSummary, includeOutput } = parsed.variables;
  if (typeof owner !== 'string' || typeof name !== 'string'
    || buildGithubRepositoryKey({ owner, name }) !== `${owner}/${name}`.toLowerCase()
    // The upstream GraphQL Int only accepts signed 32-bit values.
    || typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 2_147_483_647
    || (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0))
    || includeSummary !== false || includeOutput !== false) return null;
  return { owner, name, pullRequestNumber: number,
    body: encodeGithubChecksQueryBody({ owner, name, number, cursor, includeSummary, includeOutput }) };
}
