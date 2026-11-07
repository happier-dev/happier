import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { admitGithubEntryInvocation } from './admission.js';
import { GithubIssueFactsInputV1Schema, GithubViewerSubscriptionV1Schema, type GithubIssueFactsResultV1 } from './detail/contracts.js';
import { GITHUB_ROUTE_BODY_MISMATCH_FAILURE } from './errors.js';
import { buildGithubCollisionScope } from './identity.js';
import type { GithubTriageInvocationContext } from './invocation.js';
import { sendGithubGraphqlRequest } from './mutations/graphql.js';

// GitHub GraphQL Issue fields, checked 2026-11-07:
// https://docs.github.com/en/graphql/reference/issues#issue
const QUERY = `query GithubIssueFacts($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { databaseId issue(number: $number) { isPinned viewerSubscription } }
}`;
function unavailable(failure: TriageSourceFailureV1): GithubIssueFactsResultV1 {
  return { kind: 'unavailable', failure };
}
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One admitted request proves the repository identity and reads both current facts. */
export async function readGithubIssueFacts(input: unknown, context: GithubTriageInvocationContext): Promise<GithubIssueFactsResultV1> {
  const parsed = GithubIssueFactsInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable({ class: 'unsupportedContract', code: 'github_detail_input_invalid' });
  const admitted = await admitGithubEntryInvocation({ ...parsed.data, admissibleKinds: ['issue'] }, context);
  if (!admitted.ok) return unavailable(admitted.failure);
  const response = await sendGithubGraphqlRequest({ query: QUERY, readOnlyGraphql: true,
    variables: { ...admitted.route, number: Number(admitted.entryNumber) },
  }, { client: admitted.client, now: Date.now });
  if (!response.ok) return unavailable(response.failure);
  const repository = response.data.repository;
  if (!record(repository) || typeof repository.databaseId !== 'number') {
    return unavailable({ class: 'unsupportedContract', code: 'github_graphql_response_invalid' });
  }
  if (buildGithubCollisionScope(repository.databaseId) !== admitted.localRef.collisionScope) {
    return unavailable(GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  }
  const issue = repository.issue;
  const subscription = GithubViewerSubscriptionV1Schema.safeParse(record(issue) ? issue.viewerSubscription : undefined);
  if (!record(issue) || typeof issue.isPinned !== 'boolean' || !subscription.success) {
    return unavailable({ class: 'unsupportedContract', code: 'github_graphql_response_invalid' });
  }
  return { kind: 'issueFacts', isPinned: issue.isPinned, viewerSubscription: subscription.data };
}
