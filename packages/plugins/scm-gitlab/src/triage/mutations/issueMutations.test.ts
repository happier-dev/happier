/**
 * The GitLab issue state Actions.
 *
 * Every test drives the real vertical: the published input schema, the shared
 * admission, the real client with its origin pin and failure classifier, and the
 * real row decoding. Only the host HTTP service and the generic Connected
 * Accounts service — the two genuine system boundaries — are stubbed, and no
 * request ever leaves the process.
 *
 * Two properties are checked here that no merge-request case can check for these
 * Actions, and both are `sources/SCM.md` §4.7's own rows:
 *
 *  1. **The route is the issue route.** A GitLab issue and a GitLab merge request
 *     share a project and can share an IID, so an Action that reached
 *     `…/merge_requests/{iid}` for an issue reference would transition a
 *     DIFFERENT item that looks correct in every assertion about the response.
 *  2. **The pin is the issue's own `updated_at`.** An issue has no head commit,
 *     so §4.7 makes the observed revision the currentness gate: a changed
 *     revision refuses with zero writes rather than acting on a read the user
 *     never saw.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GITLAB_MUTATION_DEADLINE_MS } from '../admission.js';
import {
  createStubGitlabTransport,
  gitlabTestConfiguredInstance,
  GITLAB_STUB_NEVER_ANSWERS,
  GITLAB_TEST_COLLISION_SCOPE,
  type RecordedGitlabRequest,
  type StubGitlabResponse,
} from '../testkit/gitlabTriage.test-support.js';
import { closeGitlabIssue, reopenGitlabIssue } from './operations.js';

const ISSUE_URL = 'https://gitlab.com/api/v4/projects/3/issues/42';
/** The merge request that shares this project and this IID. It is never touched. */
const MERGE_REQUEST_URL = 'https://gitlab.com/api/v4/projects/3/merge_requests/42';

const OBSERVED_REVISION = '2026-08-12T09:00:00.000Z';
const LATER_REVISION = '2026-08-12T11:30:00.000Z';

const LOCAL_REF = Object.freeze({
  kindId: 'issue',
  entryId: '42',
  collisionScope: GITLAB_TEST_COLLISION_SCOPE,
});

function issueBody(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: 9911,
    iid: 42,
    project_id: 3,
    state: 'opened',
    updated_at: OBSERVED_REVISION,
    web_url: 'https://gitlab.com/group/project/-/issues/42',
    references: { full: 'group/project#42' },
    ...overrides,
  };
}

/** The answer GitLab never sent back: a request that left, and no reply at all. */
const ANSWER_LOST = Symbol('gitlab-answer-lost');

type ScriptedGitlabAnswer =
  | StubGitlabResponse
  | typeof ANSWER_LOST
  | typeof GITLAB_STUB_NEVER_ANSWERS;

function scriptedTransport(script: Readonly<Record<string, readonly ScriptedGitlabAnswer[]>>) {
  const cursors = new Map<string, number>();
  return createStubGitlabTransport({
    respond: (request: RecordedGitlabRequest) => {
      const key = `${request.method} ${request.url}`;
      const answers = script[key];
      if (answers === undefined) return undefined;
      const index = cursors.get(key) ?? 0;
      cursors.set(key, index + 1);
      const answer = answers[Math.min(index, answers.length - 1)];
      if (answer === ANSWER_LOST) throw new Error('socket hang up');
      return answer;
    },
  });
}

function issueInput(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    v: 1,
    instance: gitlabTestConfiguredInstance(),
    localRef: LOCAL_REF,
    observedRevision: OBSERVED_REVISION,
    ...overrides,
  };
}

function bodyOf(request: RecordedGitlabRequest | undefined): Record<string, unknown> {
  return JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
}

describe('gitlab/issue/close', () => {
  it('sends the provider-native state transition and proves it with a fresh read', async () => {
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody() },
        { status: 200, body: issueBody({ state: 'closed', updated_at: LATER_REVISION }) },
      ],
      [`PUT ${ISSUE_URL}`]: [{ status: 200, body: issueBody({ state: 'closed' }) }],
    });

    const result = await closeGitlabIssue(issueInput(), transport.context);

    const write = transport.requests.find((request) => request.method === 'PUT');
    // Only the transition. GitLab's issue update also accepts `labels`,
    // `assignee_ids`, `title` and `description`, and every one of them would
    // REPLACE a concurrent edit this control never asked to touch.
    expect(bodyOf(write)).toEqual({ state_event: 'close' });
    expect(result).toMatchObject({ kind: 'closed', item: { state: 'closed' } });
    // Reauthorized for this exact invocation rather than reusing standing material.
    expect(transport.materializeCount()).toBeGreaterThan(0);
    // Read before effect: the currentness read is always the first request.
    expect(transport.requests[0]?.method).toBe('GET');
  });

  it('never addresses the merge request that shares this project and IID', async () => {
    // The deciding safety vector. A merge request `!42` and an issue `#42` are
    // different items, and an Action that routed through `merge_requests` would
    // close the wrong one while every response assertion still looked right.
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody() },
        { status: 200, body: issueBody({ state: 'closed' }) },
      ],
      [`PUT ${ISSUE_URL}`]: [{ status: 200, body: issueBody({ state: 'closed' }) }],
      // Deliberately scripted so a wrong route would SUCCEED rather than fail
      // loudly on an unstubbed URL: the assertion below is what catches it.
      [`GET ${MERGE_REQUEST_URL}`]: [{ status: 200, body: issueBody() }],
      [`PUT ${MERGE_REQUEST_URL}`]: [{ status: 200, body: issueBody({ state: 'closed' }) }],
    });

    await closeGitlabIssue(issueInput(), transport.context);

    expect(transport.requests.map((request) => request.url))
      .not.toContain(MERGE_REQUEST_URL);
    expect(transport.requests.every((request) => request.url === ISSUE_URL)).toBe(true);
  });

  it('refuses without a write when the issue changed after the read the user acted on', async () => {
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [{ status: 200, body: issueBody({ updated_at: LATER_REVISION }) }],
    });

    const result = await closeGitlabIssue(issueInput(), transport.context);

    expect(result).toMatchObject({
      kind: 'reconfirmationRequired',
      observed: { revision: LATER_REVISION },
    });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('converges on an already-closed issue without writing again', async () => {
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [{ status: 200, body: issueBody({ state: 'closed' }) }],
    });

    const result = await closeGitlabIssue(issueInput(), transport.context);

    expect(result).toMatchObject({ kind: 'closed' });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('proves a close whose answer was lost with the confirming read', async () => {
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody() },
        { status: 200, body: issueBody({ state: 'closed' }) },
      ],
      [`PUT ${ISSUE_URL}`]: [ANSWER_LOST],
    });

    const result = await closeGitlabIssue(issueInput(), transport.context);

    expect(result).toMatchObject({ kind: 'closed', item: { state: 'closed' } });
    // One write, never a blind retry.
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('never claims closed when the confirming read still reports it open', async () => {
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody() },
        { status: 200, body: issueBody({ state: 'opened' }) },
      ],
      [`PUT ${ISSUE_URL}`]: [{ status: 200, body: issueBody({ state: 'closed' }) }],
    });

    const result = await closeGitlabIssue(issueInput(), transport.context);

    expect(result).toMatchObject({ kind: 'unconfirmed', observed: { state: 'opened' } });
  });

  it('refuses an input that carries anything beyond the entry and its revision', async () => {
    // The closed schema is the gate. `labels` smuggled in beside the ref would
    // REPLACE every label on the issue; it is refused before a credential is
    // materialized rather than ignored on the way past.
    const transport = scriptedTransport({ [`GET ${ISSUE_URL}`]: [{ status: 200, body: issueBody() }] });

    const result = await closeGitlabIssue(issueInput({ labels: 'bug' }), transport.context);

    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'gitlab-mutation-input-invalid' },
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses an input with no observed revision at all', async () => {
    const transport = scriptedTransport({ [`GET ${ISSUE_URL}`]: [{ status: 200, body: issueBody() }] });

    const result = await closeGitlabIssue(
      { v: 1, instance: gitlabTestConfiguredInstance(), localRef: LOCAL_REF },
      transport.context,
    );

    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'gitlab-mutation-input-invalid' },
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses a merge-request reference: this Action addresses issues only', async () => {
    const transport = scriptedTransport({});

    const result = await closeGitlabIssue(
      issueInput({ localRef: { ...LOCAL_REF, kindId: 'merge-request' } }),
      transport.context,
    );

    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'gitlab-kind-unsupported' },
    });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('gitlab/issue/reopen', () => {
  it('sends the reopen transition and proves it with a fresh read', async () => {
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody({ state: 'closed' }) },
        { status: 200, body: issueBody({ state: 'opened', updated_at: LATER_REVISION }) },
      ],
      [`PUT ${ISSUE_URL}`]: [{ status: 200, body: issueBody({ state: 'opened' }) }],
    });

    const result = await reopenGitlabIssue(issueInput(), transport.context);

    expect(bodyOf(transport.requests.find((request) => request.method === 'PUT')))
      .toEqual({ state_event: 'reopen' });
    expect(result).toMatchObject({ kind: 'reopened', item: { state: 'opened' } });
  });

  it('converges on an already-open issue without writing', async () => {
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [{ status: 200, body: issueBody({ state: 'opened' }) }],
    });

    const result = await reopenGitlabIssue(issueInput(), transport.context);

    expect(result).toMatchObject({ kind: 'reopened' });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('refuses without a write when the issue changed after the read the user acted on', async () => {
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [{
        status: 200,
        body: issueBody({ state: 'closed', updated_at: LATER_REVISION }),
      }],
    });

    const result = await reopenGitlabIssue(issueInput(), transport.context);

    expect(result).toMatchObject({ kind: 'reconfirmationRequired' });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('never claims reopened when the confirming read still reports it closed', async () => {
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody({ state: 'closed' }) },
        { status: 200, body: issueBody({ state: 'closed' }) },
      ],
      [`PUT ${ISSUE_URL}`]: [{ status: 200, body: issueBody({ state: 'opened' }) }],
    });

    const result = await reopenGitlabIssue(issueInput(), transport.context);

    expect(result).toMatchObject({ kind: 'unconfirmed', observed: { state: 'closed' } });
  });

  it('reports an unreadable issue as permission-shaped rather than as gone', async () => {
    // GitLab answers a hidden, confidential and removed issue identically, so a
    // mutation never reads a `404` as *deleted* and never drops the row.
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [{ status: 404, body: { message: '404 Not found' } }],
    });

    const result = await reopenGitlabIssue(issueInput(), transport.context);

    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { class: 'permission', code: 'item-unreadable' },
    });
  });
});

/**
 * The issue half of the same rule: a state write that was DISPATCHED and then lost its answer to
 * this source's own deadline may already have transitioned the issue, so it is settled by the one
 * confirming read every Action performs — never by reporting that nothing was attempted.
 */
describe('an issue write whose answer this source’s deadline took', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function pastMutationDeadline<TResult>(start: () => Promise<TResult>): Promise<TResult> {
    vi.useFakeTimers();
    const pending = start();
    await vi.advanceTimersByTimeAsync(GITLAB_MUTATION_DEADLINE_MS + 1);
    return pending;
  }

  it('reports a close GitLab performed as closed, never as nothing attempted', async () => {
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody({ state: 'opened' }) },
        { status: 200, body: issueBody({ state: 'closed' }) },
      ],
      [`PUT ${ISSUE_URL}`]: [GITLAB_STUB_NEVER_ANSWERS],
    });

    const result = await pastMutationDeadline(
      () => closeGitlabIssue(issueInput(), transport.context),
    );

    expect(result).toMatchObject({ kind: 'closed', item: { state: 'closed' } });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('reports a reopen GitLab performed as reopened, never as nothing attempted', async () => {
    const transport = scriptedTransport({
      [`GET ${ISSUE_URL}`]: [
        { status: 200, body: issueBody({ state: 'closed' }) },
        { status: 200, body: issueBody({ state: 'opened' }) },
      ],
      [`PUT ${ISSUE_URL}`]: [GITLAB_STUB_NEVER_ANSWERS],
    });

    const result = await pastMutationDeadline(
      () => reopenGitlabIssue(issueInput(), transport.context),
    );

    expect(result).toMatchObject({ kind: 'reopened', item: { state: 'opened' } });
  });
});
