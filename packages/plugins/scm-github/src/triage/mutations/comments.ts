import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import type { GithubGetDependenciesV1 } from '../get.js';
import type { GithubRepositoryRouteV1 } from '../locator.js';
import type { GithubTriageEntryLocalRefV1 } from '../types.js';

import type {
  GithubCommentCreateResultV1,
  GithubCommentEditResultV1,
  GithubCommentEditTargetKindV1,
} from './contracts.js';
import { sendGithubGraphqlRequest } from './graphql.js';
import { decodeGithubNodeEntry, githubNodeEntryMatches } from './nodeEntry.js';

/**
 * A person's own conversation writes: posting a new comment and editing an
 * existing comment body. Each is one identity read, then GitHub's own mutation.
 *
 * Editing one existing comment body: one identity read, then GitHub's own update.
 *
 * The read proves the global node id is the named kind and hangs on the admitted
 * entry; it decides nothing about permission, which stays GitHub's. The update's
 * payload is the comment as GitHub now holds it, so no confirming read follows.
 * A response lost after dispatch is `uncertain` and never re-sent: the edit may
 * already be on GitHub.
 */

const COMMENT_ABSENT_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_comment_absent',
});

const COMMENT_NOT_ON_ENTRY_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_comment_not_on_entry',
});

const KINDS: Readonly<
  Record<
    GithubCommentEditTargetKindV1,
    Readonly<{
      typename: string;
      /** The node field that names the entry: GitHub hangs a conversation comment on its issue. */
      entryField: 'issue' | 'pullRequest';
      mutation: string;
      payloadField: string;
    }>
  >
> = Object.freeze({
  'issue-comment': {
    typename: 'IssueComment',
    entryField: 'issue',
    mutation: `mutation GithubEditIssueComment($id: ID!, $body: String!) {
  updateIssueComment(input: { id: $id, body: $body }) { issueComment { id body } }
}`,
    payloadField: 'updateIssueComment',
  },
  'review-comment': {
    typename: 'PullRequestReviewComment',
    entryField: 'pullRequest',
    mutation: `mutation GithubEditReviewComment($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) {
    pullRequestReviewComment { id body }
  }
}`,
    payloadField: 'updatePullRequestReviewComment',
  },
  review: {
    typename: 'PullRequestReview',
    entryField: 'pullRequest',
    mutation: `mutation GithubEditReview($id: ID!, $body: String!) {
  updatePullRequestReview(input: { pullRequestReviewId: $id, body: $body }) {
    pullRequestReview { id body }
  }
}`,
    payloadField: 'updatePullRequestReview',
  },
});

const COMMENT_ENTRY_QUERY = `query GithubEditableComment($id: ID!) {
  node(id: $id) {
    __typename
    ... on IssueComment { id issue { number } repository { databaseId name owner { login } } }
    ... on PullRequestReviewComment { id pullRequest { number } repository { databaseId name owner { login } } }
    ... on PullRequestReview { id pullRequest { number } repository { databaseId name owner { login } } }
  }
}`;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failed(failure: TriageSourceFailureV1): Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }> {
  return Object.freeze({ kind: 'failed' as const, failure });
}

export async function editGithubComment(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    target: Readonly<{ kind: GithubCommentEditTargetKindV1; id: string }>;
    body: string;
  }>,
  dependencies: GithubGetDependenciesV1,
): Promise<GithubCommentEditResultV1> {
  const kind = KINDS[input.target.kind];
  const read = await sendGithubGraphqlRequest(
    { query: COMMENT_ENTRY_QUERY, variables: { id: input.target.id } },
    dependencies,
  );
  if (!read.ok) return failed(read.failure);
  const node = read.data.node;
  if (!isRecord(node) || node.__typename !== kind.typename)
    return failed(COMMENT_ABSENT_FAILURE);
  const entry = decodeGithubNodeEntry(node[kind.entryField], node.repository);
  if (
    entry === null ||
    !githubNodeEntryMatches(entry, input.localRef, input.route)
  ) {
    return failed(COMMENT_NOT_ON_ENTRY_FAILURE);
  }

  const written = await sendGithubGraphqlRequest(
    {
      query: kind.mutation,
      variables: { id: input.target.id, body: input.body },
    },
    dependencies,
  );
  if (!written.ok) {
    return written.mayHaveChanged
      ? Object.freeze({ kind: 'uncertain' as const, failure: written.failure })
      : failed(written.failure);
  }
  const payload = written.data[kind.payloadField];
  const comment = isRecord(payload)
    ? Object.values(payload).find(isRecord)
    : undefined;
  if (
    comment === undefined ||
    typeof comment.id !== 'string' ||
    typeof comment.body !== 'string'
  ) {
    return Object.freeze({ kind: 'uncertain' as const });
  }
  return Object.freeze({
    kind: 'applied' as const,
    effect: 'changed' as const,
    comment: Object.freeze({ id: comment.id, body: comment.body }),
  });
}

const SUBJECT_ABSENT_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_comment_subject_not_on_entry',
});

const COMMENT_SUBJECT_QUERY = `query GithubCommentSubject($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    databaseId name owner { login }
    issueOrPullRequest(number: $number) {
      __typename ... on Issue { id number } ... on PullRequest { id number }
    }
  }
}`;

const ADD_COMMENT_MUTATION = `mutation GithubAddComment($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) {
    commentEdge { node { id body createdAt url author { login } } }
  }
}`;

/**
 * Posts one conversation comment on the admitted entry.
 *
 * The read pins the path's repository to the admitted numeric id and the number
 * to the admitted kind, because a renamed or reused repository path would
 * otherwise post into someone else's conversation. No marker is written and no
 * reconciliation read follows: a lost response is `uncertain` and the person
 * reopens the conversation rather than posting twice.
 */
export async function createGithubComment(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    body: string;
  }>,
  dependencies: GithubGetDependenciesV1,
): Promise<GithubCommentCreateResultV1> {
  const read = await sendGithubGraphqlRequest({
    query: COMMENT_SUBJECT_QUERY,
    variables: { owner: input.route.owner, name: input.route.name, number: Number(input.localRef.entryId) },
  }, dependencies);
  if (!read.ok) return failed(read.failure);
  const repository = read.data.repository;
  const subject = isRecord(repository) ? repository.issueOrPullRequest : null;
  const expectedType = input.localRef.kindId === 'issue' ? 'Issue' : 'PullRequest';
  const entry = decodeGithubNodeEntry(subject, repository);
  if (
    !isRecord(subject) || subject.__typename !== expectedType || typeof subject.id !== 'string'
    || entry === null || !githubNodeEntryMatches(entry, input.localRef, input.route)
  ) {
    return failed(SUBJECT_ABSENT_FAILURE);
  }

  const written = await sendGithubGraphqlRequest(
    { query: ADD_COMMENT_MUTATION, variables: { subjectId: subject.id, body: input.body } },
    dependencies,
  );
  if (!written.ok) {
    return written.mayHaveChanged
      ? Object.freeze({ kind: 'uncertain' as const, failure: written.failure })
      : failed(written.failure);
  }
  const added = written.data.addComment;
  const edge = isRecord(added) ? added.commentEdge : null;
  const node = isRecord(edge) ? edge.node : null;
  if (!isRecord(node) || typeof node.id !== 'string' || typeof node.body !== 'string') {
    return Object.freeze({ kind: 'uncertain' as const });
  }
  const createdAtMs = typeof node.createdAt === 'string' ? Date.parse(node.createdAt) : Number.NaN;
  const author = isRecord(node.author) && typeof node.author.login === 'string' && node.author.login !== ''
    ? node.author.login
    : null;
  return Object.freeze({
    kind: 'applied' as const,
    effect: 'changed' as const,
    comment: Object.freeze({
      id: node.id,
      body: node.body,
      ...(author === null ? {} : { author }),
      ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
      ...(typeof node.url === 'string' && node.url !== '' ? { url: node.url } : {}),
    }),
  });
}
