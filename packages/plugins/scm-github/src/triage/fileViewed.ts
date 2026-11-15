import type { GithubTriageInvocationContext } from './invocation.js';
import type { ScmFileViewedReadResultV1, ScmFileViewedSetResultV1, ScmFileViewedStateV1 } from '@happier-dev/plugin-sdk/scm';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { admitGithubDetailInvocation } from './admission.js';
import { sendGithubGraphqlRequest } from './mutations/graphql.js';
import { GithubFileViewedReadInputV1Schema, GithubFileViewedSetInputV1Schema } from './fileViewedContracts.js';

const READ_QUERY = `query GithubFileViewed($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    headRefOid
    files(first: 100, after: $cursor) { nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } }
  } }
}`;
const ID_QUERY = `query GithubFileViewedTarget($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;
const MARK_MUTATION = `mutation GithubMarkFileViewed($pullRequestId: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { pullRequest { id } }
}`;
const UNMARK_MUTATION = `mutation GithubUnmarkFileViewed($pullRequestId: ID!, $path: String!) {
  unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { pullRequest { id } }
}`;
const INVALID_INPUT: TriageSourceFailureV1 = { class: 'unsupportedContract', code: 'github_detail_input_invalid' };
const INVALID_RESPONSE: TriageSourceFailureV1 = { class: 'unsupportedContract', code: 'github_graphql_response_invalid' };
function unavailable(failure: TriageSourceFailureV1): Extract<ScmFileViewedReadResultV1, { kind: 'unavailable' }> {
  // Triage's invocation requestId is outside the closed SCM failure contract.
  return { kind: 'unavailable', failure: { class: failure.class, code: failure.code,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    ...(failure.retryNotBeforeMs === undefined ? {} : { retryNotBeforeMs: failure.retryNotBeforeMs }),
  } };
}
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function pullRequest(data: Readonly<Record<string, unknown>>) {
  return record(data.repository) && record(data.repository.pullRequest) ? data.repository.pullRequest : null;
}
function viewedState(value: unknown): ScmFileViewedStateV1 | null {
  switch (value) { case 'VIEWED': return 'viewed'; case 'UNVIEWED': return 'unviewed'; case 'DISMISSED': return 'dismissed'; default: return null; }
}

/** One admitted cursor walk for the complete opened PR map. No partial map is published. */
export async function readGithubFileViewed(input: unknown, context: GithubTriageInvocationContext): Promise<ScmFileViewedReadResultV1> {
  const parsed = GithubFileViewedReadInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT);
  const admitted = await admitGithubDetailInvocation({ ...parsed.data, admissibleKinds: ['pull-request'] }, context);
  if (!admitted.ok) return unavailable(admitted.failure);
  const files: Array<{ path: string; state: ScmFileViewedStateV1 }> = [];
  let cursor: string | null = null;
  let headOid: string | undefined;
  do {
    const result = await sendGithubGraphqlRequest({ query: READ_QUERY, readOnlyGraphql: true,
      variables: { ...admitted.route, number: Number(admitted.entryNumber), cursor } }, { client: admitted.client, now: Date.now });
    if (!result.ok) return unavailable(result.failure);
    const pr = pullRequest(result.data);
    if (!pr || typeof pr.headRefOid !== 'string' || !pr.headRefOid || !record(pr.files)
      || !Array.isArray(pr.files.nodes) || !record(pr.files.pageInfo) || typeof pr.files.pageInfo.hasNextPage !== 'boolean') {
      return unavailable(INVALID_RESPONSE);
    }
    // The external pages must describe the same head; a changed map settles
    // unavailable and the next ordinary open/return/Refresh can read it again.
    if (headOid !== undefined && headOid !== pr.headRefOid) return unavailable(INVALID_RESPONSE);
    headOid = pr.headRefOid;
    for (const row of pr.files.nodes) {
      const state = record(row) ? viewedState(row.viewerViewedState) : null;
      if (!record(row) || typeof row.path !== 'string' || !row.path || state === null) return unavailable(INVALID_RESPONSE);
      files.push({ path: row.path, state });
    }
    const page = pr.files.pageInfo;
    if (!page.hasNextPage) return { kind: 'ready', headOid, files };
    if (typeof page.endCursor !== 'string' || !page.endCursor || page.endCursor === cursor) return unavailable(INVALID_RESPONSE);
    cursor = page.endCursor;
  } while (true);
}

/** Resolve the admitted PR's node id, mark/unmark once, and publish its acknowledgement. */
export async function setGithubFileViewed(input: unknown, context: GithubTriageInvocationContext): Promise<ScmFileViewedSetResultV1> {
  const parsed = GithubFileViewedSetInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(INVALID_INPUT);
  const request = parsed.data;
  const admitted = await admitGithubDetailInvocation({ ...request, admissibleKinds: ['pull-request'] }, context);
  if (!admitted.ok) return unavailable(admitted.failure);
  const dependencies = { client: admitted.client, now: Date.now };
  const target = await sendGithubGraphqlRequest({ query: ID_QUERY, readOnlyGraphql: true,
    variables: { ...admitted.route, number: Number(admitted.entryNumber) } }, dependencies);
  if (!target.ok) return unavailable(target.failure);
  const pr = pullRequest(target.data);
  if (!pr || typeof pr.id !== 'string' || !pr.id) return unavailable(INVALID_RESPONSE);
  const result = await sendGithubGraphqlRequest({ query: request.viewed ? MARK_MUTATION : UNMARK_MUTATION,
    variables: { pullRequestId: pr.id, path: request.path } }, dependencies);
  if (!result.ok) return unavailable(result.failure);
  const acknowledgement = result.data[request.viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'];
  if (!record(acknowledgement) || !record(acknowledgement.pullRequest) || acknowledgement.pullRequest.id !== pr.id) return unavailable(INVALID_RESPONSE);
  return { kind: 'ready', path: request.path, state: request.viewed ? 'viewed' : 'unviewed' };
}
