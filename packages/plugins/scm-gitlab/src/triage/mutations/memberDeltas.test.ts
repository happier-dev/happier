import { describe, expect, it } from 'vitest';

import {
  createStubGitlabTransport,
  gitlabTestConfiguredInstance,
  GITLAB_TEST_COLLISION_SCOPE,
  type RecordedGitlabRequest,
  type StubGitlabResponse,
} from '../testkit/gitlabTriage.test-support.js';
import {
  assignGitlabIssue,
  changeGitlabIssueLabels,
  changeGitlabMergeRequestReviewers,
  resolveGitlabMergeRequestDiscussion,
} from './operations.js';

const GRAPHQL_URL = 'https://gitlab.com/api/graphql';
const MR_URL = 'https://gitlab.com/api/v4/projects/3/merge_requests/7';
const ISSUE_URL = 'https://gitlab.com/api/v4/projects/3/issues/42';
const DISCUSSION_URL = `${MR_URL}/discussions/thread-1`;
const HEAD = 'a'.repeat(40);
const ISSUE_REVISION = '2026-08-12T09:00:00.000Z';

const MR_REF = Object.freeze({
  kindId: 'merge-request', entryId: '7', collisionScope: GITLAB_TEST_COLLISION_SCOPE,
});
const ISSUE_REF = Object.freeze({
  kindId: 'issue', entryId: '42', collisionScope: GITLAB_TEST_COLLISION_SCOPE,
});

function mrBody(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    iid: 7,
    state: 'opened',
    draft: false,
    updated_at: ISSUE_REVISION,
    references: { full: 'group/project!7' },
    sha: HEAD,
    reviewers: [{ username: 'alice' }, { username: 'carol' }],
    ...overrides,
  };
}

function issueBody(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    iid: 42,
    state: 'opened',
    updated_at: ISSUE_REVISION,
    references: { full: 'group/project#42' },
    assignees: [{ username: 'alice' }, { username: 'carol' }],
    labels: ['bug', 'backend'],
    ...overrides,
  };
}

function transport(script: Readonly<Record<string, readonly StubGitlabResponse[]>>) {
  const cursor = new Map<string, number>();
  return createStubGitlabTransport({
    respond: (request: RecordedGitlabRequest) => {
      const key = `${request.method} ${request.url}`;
      const answers = script[key];
      if (answers === undefined) return undefined;
      const index = cursor.get(key) ?? 0;
      cursor.set(key, index + 1);
      return answers[Math.min(index, answers.length - 1)];
    },
  });
}

function requestBody(request: RecordedGitlabRequest | undefined): Record<string, unknown> {
  return JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
}

describe('GitLab provider-native member deltas', () => {
  it('adds reviewers through GraphQL APPEND and preserves an unrelated reviewer', async () => {
    const stub = transport({
      [`GET ${MR_URL}`]: [
        { status: 200, body: mrBody() },
        { status: 200, body: mrBody({ reviewers: [
          { username: 'alice' }, { username: 'bob' }, { username: 'carol' },
        ] }) },
      ],
      [`POST ${GRAPHQL_URL}`]: [{ status: 200, body: { data: { mergeRequestSetReviewers: { errors: [] } } } }],
    });

    const result = await changeGitlabMergeRequestReviewers({
      v: 1,
      instance: gitlabTestConfiguredInstance(),
      localRef: MR_REF,
      observedHeadSha: HEAD,
      operation: 'add',
      reviewerUsernames: ['bob'],
    }, stub.context);

    const body = requestBody(stub.requests.find((request) => request.method === 'POST'));
    expect(body).toMatchObject({ variables: {
      projectPath: 'group/project', iid: '7', operationMode: 'APPEND', reviewerUsernames: ['bob'],
    } });
    expect(JSON.stringify(body)).not.toContain('REPLACE');
    expect(result).toMatchObject({ kind: 'reviewersChanged', item: { reviewerUsernames: ['alice', 'bob', 'carol'] } });
  });

  it('removes reviewers through GraphQL REMOVE', async () => {
    const stub = transport({
      [`GET ${MR_URL}`]: [
        { status: 200, body: mrBody() },
        { status: 200, body: mrBody({ reviewers: [{ username: 'carol' }] }) },
      ],
      [`POST ${GRAPHQL_URL}`]: [{ status: 200, body: { data: { mergeRequestSetReviewers: { errors: [] } } } }],
    });

    await changeGitlabMergeRequestReviewers({
      v: 1, instance: gitlabTestConfiguredInstance(), localRef: MR_REF,
      observedHeadSha: HEAD, operation: 'remove', reviewerUsernames: ['alice'],
    }, stub.context);

    expect(requestBody(stub.requests.find((request) => request.method === 'POST')))
      .toMatchObject({ variables: { operationMode: 'REMOVE', reviewerUsernames: ['alice'] } });
  });

  it('removes issue assignees through GraphQL REMOVE without REST assignee_ids', async () => {
    const stub = transport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody() },
        { status: 200, body: issueBody({ assignees: [{ username: 'carol' }] }) },
      ],
      [`POST ${GRAPHQL_URL}`]: [{ status: 200, body: { data: { issueSetAssignees: { errors: [] } } } }],
    });

    const result = await assignGitlabIssue({
      v: 1,
      instance: gitlabTestConfiguredInstance(),
      localRef: ISSUE_REF,
      observedRevision: ISSUE_REVISION,
      operation: 'remove',
      assigneeUsernames: ['alice'],
    }, stub.context);

    const body = requestBody(stub.requests.find((request) => request.method === 'POST'));
    expect(body).toMatchObject({ variables: {
      projectPath: 'group/project', iid: '42', operationMode: 'REMOVE', assigneeUsernames: ['alice'],
    } });
    expect(JSON.stringify(body)).not.toContain('assignee_ids');
    expect(result).toMatchObject({ kind: 'assigneesChanged', item: { assigneeUsernames: ['carol'] } });
  });

  it('adds issue assignees through GraphQL APPEND', async () => {
    const stub = transport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody() },
        { status: 200, body: issueBody({ assignees: [
          { username: 'alice' }, { username: 'bob' }, { username: 'carol' },
        ] }) },
      ],
      [`POST ${GRAPHQL_URL}`]: [{ status: 200, body: { data: { issueSetAssignees: { errors: [] } } } }],
    });

    await assignGitlabIssue({
      v: 1, instance: gitlabTestConfiguredInstance(), localRef: ISSUE_REF,
      observedRevision: ISSUE_REVISION, operation: 'add', assigneeUsernames: ['bob'],
    }, stub.context);

    expect(requestBody(stub.requests.find((request) => request.method === 'POST')))
      .toMatchObject({ variables: { operationMode: 'APPEND', assigneeUsernames: ['bob'] } });
  });

  it('adds issue labels with add_labels only and proves unrelated labels survived', async () => {
    const stub = transport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody() },
        { status: 200, body: issueBody({ labels: ['bug', 'backend', 'release'] }) },
      ],
      [`PUT ${ISSUE_URL}`]: [{ status: 200, body: issueBody({ labels: ['bug', 'backend', 'release'] }) }],
    });

    const result = await changeGitlabIssueLabels({
      v: 1,
      instance: gitlabTestConfiguredInstance(),
      localRef: ISSUE_REF,
      observedRevision: ISSUE_REVISION,
      operation: 'add',
      labelNames: ['release'],
    }, stub.context);

    expect(requestBody(stub.requests.find((request) => request.method === 'PUT')))
      .toEqual({ add_labels: 'release' });
    expect(result).toMatchObject({ kind: 'labelsChanged', item: { labelNames: ['bug', 'backend', 'release'] } });
  });

  it('removes issue labels with remove_labels only', async () => {
    const stub = transport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody() },
        { status: 200, body: issueBody({ labels: ['backend'] }) },
      ],
      [`PUT ${ISSUE_URL}`]: [{ status: 200, body: issueBody({ labels: ['backend'] }) }],
    });

    await changeGitlabIssueLabels({
      v: 1, instance: gitlabTestConfiguredInstance(), localRef: ISSUE_REF,
      observedRevision: ISSUE_REVISION, operation: 'remove', labelNames: ['bug'],
    }, stub.context);

    expect(requestBody(stub.requests.find((request) => request.method === 'PUT')))
      .toEqual({ remove_labels: 'bug' });
  });

  it('does not claim success when GitLab drops an unrelated member', async () => {
    const stub = transport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody() },
        { status: 200, body: issueBody({ assignees: [{ username: 'bob' }] }) },
      ],
      [`POST ${GRAPHQL_URL}`]: [{ status: 200, body: { data: { issueSetAssignees: { errors: [] } } } }],
    });

    const result = await assignGitlabIssue({
      v: 1, instance: gitlabTestConfiguredInstance(), localRef: ISSUE_REF,
      observedRevision: ISSUE_REVISION, operation: 'add', assigneeUsernames: ['bob'],
    }, stub.context);

    expect(result).toMatchObject({ kind: 'unconfirmed' });
  });
});

describe('gitlab/merge-request/discussion-resolution', () => {
  it('uses the exact discussion PUT and proves the desired state with a fresh discussion read', async () => {
    const stub = transport({
      [`GET ${MR_URL}`]: [{ status: 200, body: mrBody() }],
      [`GET ${DISCUSSION_URL}`]: [
        { status: 200, body: { id: 'thread-1', resolvable: true, resolved: false } },
        { status: 200, body: { id: 'thread-1', resolvable: true, resolved: true } },
      ],
      [`PUT ${DISCUSSION_URL}`]: [{ status: 200, body: { id: 'thread-1', resolved: true } }],
    });

    const result = await resolveGitlabMergeRequestDiscussion({
      v: 1,
      instance: gitlabTestConfiguredInstance(),
      localRef: MR_REF,
      observedHeadSha: HEAD,
      discussionId: 'thread-1',
      resolved: true,
    }, stub.context);

    expect(requestBody(stub.requests.find((request) => request.method === 'PUT')))
      .toEqual({ resolved: true });
    expect(result).toMatchObject({
      kind: 'discussionStateChanged', discussion: { id: 'thread-1', resolved: true },
    });
  });
});
