/**
 * The GitLab merge-request mutation Actions.
 *
 * Every test drives the real vertical: the published input schema, the shared
 * admission, the real client with its origin pin and failure classifier, and the
 * real result projection. Only the host HTTP service and the generic Connected
 * Accounts service — the two genuine system boundaries — are stubbed, and no
 * request ever leaves the process.
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
import {
  closeGitlabMergeRequest,
  markGitlabMergeRequestReady,
  mergeGitlabMergeRequest,
  reopenGitlabMergeRequest,
} from './operations.js';

const ITEM_URL = 'https://gitlab.com/api/v4/projects/3/merge_requests/7';
const MERGE_URL = `${ITEM_URL}/merge`;
const GRAPHQL_URL = 'https://gitlab.com/api/graphql';

const OBSERVED_HEAD = 'a'.repeat(40);
const ADVANCED_HEAD = 'b'.repeat(40);
const OBSERVED_REVISION = '2026-08-12T09:00:00.000Z';

const LOCAL_REF = Object.freeze({
  kindId: 'merge-request',
  entryId: '7',
  collisionScope: GITLAB_TEST_COLLISION_SCOPE,
});

/** One GitLab merge-request response body, with only the facts under test moved. */
function mergeRequestBody(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: 4242,
    iid: 7,
    project_id: 3,
    state: 'opened',
    draft: false,
    updated_at: OBSERVED_REVISION,
    web_url: 'https://gitlab.com/group/project/-/merge_requests/7',
    detailed_merge_status: 'mergeable',
    references: { full: 'group/project!7' },
    sha: OBSERVED_HEAD,
    diff_refs: { head_sha: OBSERVED_HEAD, base_sha: 'c'.repeat(40), start_sha: 'd'.repeat(40) },
    ...overrides,
  };
}

/**
 * A responder built from an ordered script of answers per route, so a test can
 * say "the first read sees X and the confirming read sees Y" without a mutable
 * closure in every test body.
 */
/**
 * The answer GitLab never sent back.
 *
 * A dropped connection is not a status code, so it cannot be scripted as one:
 * the responder throws where the socket would have, and the source sees exactly
 * what the host HTTP boundary surfaces to it — a request that left this process
 * and no answer at all.
 */
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
      // `GITLAB_STUB_NEVER_ANSWERS` is returned rather than thrown: the stub holds the request
      // open until the invocation's own signal aborts it, which is what a provider that stopped
      // answering does to a real `HttpService`.
      return answer;
    },
  });
}

function mergeInput(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    v: 1,
    instance: gitlabTestConfiguredInstance(),
    localRef: LOCAL_REF,
    observedHeadSha: OBSERVED_HEAD,
    ...overrides,
  };
}

/**
 * Close carries no pin (`sources/SCM.md` §2.6). The whole legal input is the
 * instance, the entry ref and the version, and this helper is the exact shape a
 * mounted control can build.
 */
function closeInput(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    v: 1,
    instance: gitlabTestConfiguredInstance(),
    localRef: LOCAL_REF,
    ...overrides,
  };
}

function bodyOf(request: RecordedGitlabRequest | undefined): Record<string, unknown> {
  return JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
}

describe('gitlab/merge-request/merge', () => {
  it('refuses a same-IID response from a different project before writing', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ project_id: 99 }) }],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { class: 'unsupportedContract', code: 'identity-mismatch' },
    });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('sends the caller-observed head as GitLab’s own sha precondition', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody() },
        { status: 200, body: mergeRequestBody({ state: 'merged', merged_at: '2026-08-12T09:05:00.000Z' }) },
      ],
      [`PUT ${MERGE_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'merged' }) }],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    const write = transport.requests.find((request) => request.method === 'PUT');
    expect(bodyOf(write).sha).toBe(OBSERVED_HEAD);
    expect(result).toMatchObject({ kind: 'merged', item: { state: 'merged' } });
    // Reauthorized for this exact invocation rather than reusing standing material.
    expect(transport.materializeCount()).toBeGreaterThan(0);
    // Read before effect: the currentness read is always the first request.
    expect(transport.requests[0]?.method).toBe('GET');
  });

  it('refuses without a write when the head moved under the user', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{
        status: 200,
        body: mergeRequestBody({ sha: ADVANCED_HEAD, diff_refs: { head_sha: ADVANCED_HEAD } }),
      }],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    expect(result).toMatchObject({
      kind: 'reconfirmationRequired',
      observed: { headSha: ADVANCED_HEAD },
    });
    // Not one PUT. Filling the pin from this fresh read is the exact race the
    // pin exists to close.
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('merges an entry edited since the read, because an edit is not a new commit', async () => {
    // §2.6 pins the merge to a COMMIT, and only to a commit. A retitled or
    // relabelled merge request moved its `updated_at` and moved no code, so
    // refusing here would deny a merge nothing invalidated — the failure mode
    // §2.6 rejects as protecting no invariant.
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody({ updated_at: '2026-08-12T10:00:00.000Z' }) },
        {
          status: 200,
          body: mergeRequestBody({
            state: 'merged',
            merged_at: '2026-08-12T10:05:00.000Z',
            updated_at: '2026-08-12T10:05:00.000Z',
          }),
        },
      ],
      [`PUT ${MERGE_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'merged' }) }],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'merged' });
    // The pin GitLab was given is still the commit the user saw.
    expect(bodyOf(transport.requests.find((request) => request.method === 'PUT')).sha)
      .toBe(OBSERVED_HEAD);
  });

  it('refuses without a write when GitLab reports no head for the pinned merge request', async () => {
    // An absent head does not compare equal to a pin. A merge dispatched here
    // would be sent with a `sha` this invocation could not corroborate.
    const body = mergeRequestBody();
    delete (body as Record<string, unknown>).sha;
    delete (body as Record<string, unknown>).diff_refs;
    const transport = scriptedTransport({ [`GET ${ITEM_URL}`]: [{ status: 200, body }] });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'reconfirmationRequired' });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('reports a scheduled merge as scheduled even when the write answered 200', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody() },
        {
          status: 200,
          body: mergeRequestBody({ state: 'opened', merge_when_pipeline_succeeds: true }),
        },
      ],
      // GitLab's own merge response claims the merged state; only the confirming
      // read decides, because a merge-train project schedules instead of merging.
      [`PUT ${MERGE_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'merged' }) }],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'scheduled', item: { autoMergeScheduled: true } });
  });

  it('never claims a merge the confirming read did not prove', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody() },
        { status: 200, body: mergeRequestBody({ state: 'opened' }) },
      ],
      [`PUT ${MERGE_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'merged' }) }],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'unconfirmed', observed: { state: 'opened' } });
  });

  it.each([
    [400, 'shaRequired'],
    [405, 'notMergeable'],
    [409, 'headAdvanced'],
    [422, 'mergeAttemptFailed'],
  ])('maps GitLab %i to its own documented outcome', async (status, reason) => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody() },
        { status: 200, body: mergeRequestBody() },
      ],
      [`PUT ${MERGE_URL}`]: [{ status, body: { message: 'Method Not Allowed' } }],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'refused', reason, dispatched: true });
  });

  it('does not treat an unsettled mergeability projection as cannot-merge', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody({ detailed_merge_status: 'checking' }) },
        { status: 200, body: mergeRequestBody({ state: 'merged' }) },
      ],
      [`PUT ${MERGE_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'merged' }) }],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'merged' });
  });

  it('converges on an already-merged merge request without writing again', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{
        status: 200,
        body: mergeRequestBody({ state: 'merged', merged_at: '2026-08-12T08:00:00.000Z' }),
      }],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'merged' });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('refuses a closed merge request before any effect', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'closed' }) }],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'refused', reason: 'notOpen', dispatched: false });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('reports a denied write as a permission failure rather than a refusal', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody() }],
      [`PUT ${MERGE_URL}`]: [{ status: 403, body: { message: '403 Forbidden' } }],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'unavailable', failure: { class: 'permission' } });
  });

  it('proves a merge whose answer was lost, and never dispatches a second write', async () => {
    // The dual of "a 200 is not a merge": a lost answer is not a non-merge. The
    // PUT left this process, so GitLab may have merged; only the confirming read
    // can say, and reporting `unavailable` here would tell a user nothing was
    // attempted about a merge that landed in production.
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody() },
        {
          status: 200,
          body: mergeRequestBody({ state: 'merged', merged_at: '2026-08-12T09:05:00.000Z' }),
        },
      ],
      [`PUT ${MERGE_URL}`]: [ANSWER_LOST],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'merged', item: { state: 'merged' } });
    // One confirming read, never a blind retry of an effect that may have run.
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('reports a lost answer the confirming read cannot settle as unconfirmed', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody() },
        { status: 200, body: mergeRequestBody({ state: 'opened' }) },
      ],
      [`PUT ${MERGE_URL}`]: [ANSWER_LOST],
    });

    const result = await mergeGitlabMergeRequest(mergeInput(), transport.context);

    // Not `unavailable`: that arm means nothing was attempted, and something was.
    expect(result).toMatchObject({ kind: 'unconfirmed', observed: { state: 'opened' } });
  });

  it('rejects an input that carries no head pin', async () => {
    const transport = scriptedTransport({});
    const result = await mergeGitlabMergeRequest(
      mergeInput({ observedHeadSha: undefined }),
      transport.context,
    );
    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'gitlab-mutation-input-invalid' },
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses a reference keyed against another deployment before any request', async () => {
    const transport = scriptedTransport({});
    const result = await mergeGitlabMergeRequest(
      mergeInput({ localRef: { ...LOCAL_REF, collisionScope: 'gitlab:other:3' } }),
      transport.context,
    );
    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'scope-outside-binding' },
    });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('gitlab/merge-request/mark-ready', () => {
  it('uses the GraphQL draft transition and never a REST draft update', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody({ draft: true }) },
        { status: 200, body: mergeRequestBody({ draft: false }) },
      ],
      [`POST ${GRAPHQL_URL}`]: [{
        status: 200,
        body: { data: { mergeRequestSetDraft: { errors: [], mergeRequest: { draft: false } } } },
      }],
    });

    const result = await markGitlabMergeRequestReady(mergeInput(), transport.context);

    const write = transport.requests.find((request) => request.method === 'POST');
    expect(write?.url).toBe(GRAPHQL_URL);
    const document = bodyOf(write);
    expect(String(document.query)).toContain('mergeRequestSetDraft');
    expect(document.variables).toMatchObject({
      projectPath: 'group/project',
      iid: '7',
      draft: false,
    });
    // `PUT {draft:false}` is not GitLab's draft transition contract.
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
    expect(result).toMatchObject({ kind: 'ready', item: { draft: false } });
  });

  it('treats GraphQL payload errors on a 200 as a failed mutation', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ draft: true }) }],
      [`POST ${GRAPHQL_URL}`]: [{
        status: 200,
        body: {
          data: { mergeRequestSetDraft: { errors: ['You cannot perform this action'] } },
        },
      }],
    });

    const result = await markGitlabMergeRequestReady(mergeInput(), transport.context);

    expect(result).toMatchObject({
      kind: 'refused',
      reason: 'mutationRejected',
      dispatched: true,
      messages: ['You cannot perform this action'],
    });
  });

  it('treats a top-level GraphQL errors array as a failed mutation', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ draft: true }) }],
      [`POST ${GRAPHQL_URL}`]: [{
        status: 200,
        body: { errors: [{ message: 'Field not found' }] },
      }],
    });

    const result = await markGitlabMergeRequestReady(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'refused', reason: 'mutationRejected' });
  });

  it('never claims ready when the confirming read still reports a draft', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody({ draft: true }) },
        { status: 200, body: mergeRequestBody({ draft: true }) },
      ],
      [`POST ${GRAPHQL_URL}`]: [{
        status: 200,
        body: { data: { mergeRequestSetDraft: { errors: [] } } },
      }],
    });

    const result = await markGitlabMergeRequestReady(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'unconfirmed', observed: { draft: true } });
  });

  it('proves a draft transition whose answer was lost with the confirming read', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody({ draft: true }) },
        { status: 200, body: mergeRequestBody({ draft: false }) },
      ],
      [`POST ${GRAPHQL_URL}`]: [ANSWER_LOST],
    });

    const result = await markGitlabMergeRequestReady(mergeInput(), transport.context);

    // The reviewer notification fan-out may already have happened. Claiming the
    // transition failed would invite a second Action that summons them twice.
    expect(result).toMatchObject({ kind: 'ready', item: { draft: false } });
    expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('converges on an already-ready merge request without writing', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ draft: false }) }],
    });

    const result = await markGitlabMergeRequestReady(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'ready' });
    expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('refuses without a write when the head moved under the user', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{
        status: 200,
        body: mergeRequestBody({ draft: true, sha: ADVANCED_HEAD, diff_refs: { head_sha: ADVANCED_HEAD } }),
      }],
    });

    const result = await markGitlabMergeRequestReady(mergeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'reconfirmationRequired' });
    expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });
});

describe('gitlab/merge-request/close', () => {
  it('sends the provider-native state transition and proves it with a fresh read', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody() },
        { status: 200, body: mergeRequestBody({ state: 'closed' }) },
      ],
      [`PUT ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'closed' }) }],
    });

    const result = await closeGitlabMergeRequest(closeInput(), transport.context);

    const write = transport.requests.find((request) => request.method === 'PUT');
    expect(bodyOf(write)).toEqual({ state_event: 'close' });
    expect(result).toMatchObject({ kind: 'closed', item: { state: 'closed' } });
  });

  it('closes an entry whose head advanced, because closing is head-independent', async () => {
    // §2.6 puts close in the not-carried row. A collaborator's push must not
    // refuse a close, and neither must an unrelated edit: the gate close is owed
    // is whether GitLab still reports it OPEN, and that gate is proved below.
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        {
          status: 200,
          body: mergeRequestBody({
            sha: ADVANCED_HEAD,
            diff_refs: { head_sha: ADVANCED_HEAD },
            updated_at: '2026-08-12T11:00:00.000Z',
          }),
        },
        { status: 200, body: mergeRequestBody({ state: 'closed', sha: ADVANCED_HEAD }) },
      ],
      [`PUT ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'closed' }) }],
    });

    const result = await closeGitlabMergeRequest(closeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'closed' });
    expect(bodyOf(transport.requests.find((request) => request.method === 'PUT')))
      .toEqual({ state_event: 'close' });
  });

  it('refuses a merged merge request before any effect', async () => {
    // The state gate that replaces the pin. A merged merge request has no close
    // transition, so asking GitLab for one would be a request the user cannot act
    // on — and the refusal must happen before anything is written.
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{
        status: 200,
        body: mergeRequestBody({ state: 'merged', merged_at: '2026-08-12T10:00:00.000Z' }),
      }],
    });

    const result = await closeGitlabMergeRequest(closeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'refused', reason: 'notOpen', dispatched: false });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('refuses an input that carries anything beyond the entry it addresses', async () => {
    // The closed schema is the gate. A `should_remove_source_branch` smuggled in
    // beside the ref would delete a collaborator's branch; it is refused before a
    // credential is materialized rather than ignored on the way past.
    const transport = scriptedTransport({ [`GET ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody() }] });

    const result = await closeGitlabMergeRequest(
      closeInput({ should_remove_source_branch: true }),
      transport.context,
    );

    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'gitlab-mutation-input-invalid' },
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('proves a close whose answer was lost with the confirming read', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody() },
        { status: 200, body: mergeRequestBody({ state: 'closed' }) },
      ],
      [`PUT ${ITEM_URL}`]: [ANSWER_LOST],
    });

    const result = await closeGitlabMergeRequest(closeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'closed', item: { state: 'closed' } });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('converges on an already-closed merge request without writing again', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'closed' }) }],
    });

    const result = await closeGitlabMergeRequest(closeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'closed' });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('never claims closed when the confirming read still reports it open', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody() },
        { status: 200, body: mergeRequestBody({ state: 'opened' }) },
      ],
      [`PUT ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'closed' }) }],
    });

    const result = await closeGitlabMergeRequest(closeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'unconfirmed', observed: { state: 'opened' } });
  });

  it('refuses an issue reference: this Action addresses merge requests only', async () => {
    const transport = scriptedTransport({});
    const result = await closeGitlabMergeRequest(
      closeInput({ localRef: { ...LOCAL_REF, kindId: 'issue' } }),
      transport.context,
    );
    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'gitlab-kind-unsupported' },
    });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('gitlab/merge-request/reopen', () => {
  it('sends the provider-native reopen transition and proves it with a fresh read', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody({ state: 'closed' }) },
        { status: 200, body: mergeRequestBody({ state: 'opened' }) },
      ],
      [`PUT ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'opened' }) }],
    });

    const result = await reopenGitlabMergeRequest(closeInput(), transport.context);

    const write = transport.requests.find((request) => request.method === 'PUT');
    // Only the transition. GitLab's update also accepts `title`, `description`,
    // `target_branch` and `should_remove_source_branch`, and sending any of them
    // would overwrite an edit this control never asked to touch.
    expect(bodyOf(write)).toEqual({ state_event: 'reopen' });
    expect(result).toMatchObject({ kind: 'reopened', item: { state: 'opened' } });
    expect(transport.requests[0]?.method).toBe('GET');
  });

  it('refuses a merged merge request before any effect', async () => {
    // GitLab has no reopen transition for a merged merge request, and this is a
    // DIFFERENT fact from "it is not open": the user is owed the reason, and the
    // refusal must happen before anything is written.
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{
        status: 200,
        body: mergeRequestBody({ state: 'merged', merged_at: '2026-08-12T10:00:00.000Z' }),
      }],
    });

    const result = await reopenGitlabMergeRequest(closeInput(), transport.context);

    expect(result).toMatchObject({
      kind: 'refused',
      reason: 'notReopenable',
      dispatched: false,
      observed: { state: 'merged' },
    });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('reopens an entry whose head advanced, because reopening is head-independent', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        {
          status: 200,
          body: mergeRequestBody({
            state: 'closed',
            sha: ADVANCED_HEAD,
            diff_refs: { head_sha: ADVANCED_HEAD },
            updated_at: '2026-08-12T11:00:00.000Z',
          }),
        },
        { status: 200, body: mergeRequestBody({ state: 'opened', sha: ADVANCED_HEAD }) },
      ],
      [`PUT ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'opened' }) }],
    });

    const result = await reopenGitlabMergeRequest(closeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'reopened' });
  });

  it('converges on an already-open merge request without writing', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'opened' }) }],
    });

    const result = await reopenGitlabMergeRequest(closeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'reopened' });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('proves a reopen whose answer was lost with the confirming read', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody({ state: 'closed' }) },
        { status: 200, body: mergeRequestBody({ state: 'opened' }) },
      ],
      [`PUT ${ITEM_URL}`]: [ANSWER_LOST],
    });

    const result = await reopenGitlabMergeRequest(closeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'reopened', item: { state: 'opened' } });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('never claims reopened when the confirming read still reports it closed', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody({ state: 'closed' }) },
        { status: 200, body: mergeRequestBody({ state: 'closed' }) },
      ],
      [`PUT ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'opened' }) }],
    });

    const result = await reopenGitlabMergeRequest(closeInput(), transport.context);

    expect(result).toMatchObject({ kind: 'unconfirmed', observed: { state: 'closed' } });
  });

  it('refuses an input that carries anything beyond the entry it addresses', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [{ status: 200, body: mergeRequestBody({ state: 'closed' }) }],
    });

    const result = await reopenGitlabMergeRequest(
      closeInput({ should_remove_source_branch: false }),
      transport.context,
    );

    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'gitlab-mutation-input-invalid' },
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses an issue reference: this Action addresses merge requests only', async () => {
    const transport = scriptedTransport({});

    const result = await reopenGitlabMergeRequest(
      closeInput({ localRef: { ...LOCAL_REF, kindId: 'issue' } }),
      transport.context,
    );

    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'gitlab-kind-unsupported' },
    });
    expect(transport.requests).toHaveLength(0);
  });
});


/**
 * The source-owned deadline on an exact GitLab mutation.
 *
 * `CONTRACT.md` §5.2 gives the SOURCE the deadline for each exact provider Action, its
 * confirmation and its poll, and says Triage supplies none. It is the same bound as a detail
 * read's in mechanism and a different one in duration, because it covers a currentness read, a
 * write and a confirming read that are one press of one button.
 */
describe('the GitLab mutation deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a merge-request write whose provider never answers, before any effect', async () => {
    vi.useFakeTimers();
    const transport = createStubGitlabTransport({ respond: () => GITLAB_STUB_NEVER_ANSWERS });

    const pending = mergeGitlabMergeRequest(mergeInput(), transport.context);
    await vi.advanceTimersByTimeAsync(GITLAB_MUTATION_DEADLINE_MS + 1);
    const result = await pending;

    // The currentness read is what hung, so nothing was written and the Action says so with the
    // reason that is true: the deadline elapsed, not that the caller cancelled.
    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { class: 'transient', code: 'deadline-exceeded' },
    });
    expect(transport.requests.every((request) => request.method === 'GET')).toBe(true);
  });
});

/**
 * A write that WAS DISPATCHED and then lost its answer to this source's own deadline.
 *
 * The deadline exists so a mounted control gives up on a provider that stopped answering; it does
 * not, and cannot, tell the caller that the provider did nothing. `sources/SCM.md` §4.7.2's rule is
 * that a status code is not evidence of an effect, and its dual is that a MISSING answer is not
 * evidence of no effect — so a deadline abort belongs with the dropped connection, not with the two
 * refusals this client makes before dispatch.
 *
 * Every case below scripts the item as GitLab would report it if the write HAD landed. A result of
 * `unavailable` is therefore the precise failure the arm's own contract names — "nothing was
 * attempted" — asserted about a transition that happened.
 */
describe('a mutation write whose answer this source’s deadline took', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function pastMutationDeadline<TResult>(start: () => Promise<TResult>): Promise<TResult> {
    vi.useFakeTimers();
    const pending = start();
    await vi.advanceTimersByTimeAsync(GITLAB_MUTATION_DEADLINE_MS + 1);
    return pending;
  }

  it('reports a merge GitLab performed as merged, never as nothing attempted', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody() },
        { status: 200, body: mergeRequestBody({ state: 'merged', merged_at: '2026-08-12T09:05:00.000Z' }) },
      ],
      [`PUT ${MERGE_URL}`]: [GITLAB_STUB_NEVER_ANSWERS],
    });

    const result = await pastMutationDeadline(
      () => mergeGitlabMergeRequest(mergeInput(), transport.context),
    );

    expect(result).toMatchObject({ kind: 'merged', item: { state: 'merged' } });
    // One PUT. A lost answer is settled by the confirming read, never by a second write.
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('reports a draft GitLab cleared as ready, never as nothing attempted', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody({ draft: true }) },
        { status: 200, body: mergeRequestBody({ draft: false }) },
      ],
      [`POST ${GRAPHQL_URL}`]: [GITLAB_STUB_NEVER_ANSWERS],
    });

    const result = await pastMutationDeadline(
      () => markGitlabMergeRequestReady(mergeInput(), transport.context),
    );

    expect(result).toMatchObject({ kind: 'ready', item: { draft: false } });
    expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('reports a close GitLab performed as closed, never as nothing attempted', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody({ state: 'opened' }) },
        { status: 200, body: mergeRequestBody({ state: 'closed' }) },
      ],
      [`PUT ${ITEM_URL}`]: [GITLAB_STUB_NEVER_ANSWERS],
    });

    const result = await pastMutationDeadline(
      () => closeGitlabMergeRequest(closeInput(), transport.context),
    );

    expect(result).toMatchObject({ kind: 'closed', item: { state: 'closed' } });
  });

  it('reports a reopen GitLab performed as reopened, never as nothing attempted', async () => {
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody({ state: 'closed' }) },
        { status: 200, body: mergeRequestBody({ state: 'opened' }) },
      ],
      [`PUT ${ITEM_URL}`]: [GITLAB_STUB_NEVER_ANSWERS],
    });

    const result = await pastMutationDeadline(
      () => reopenGitlabMergeRequest(closeInput(), transport.context),
    );

    expect(result).toMatchObject({ kind: 'reopened', item: { state: 'opened' } });
  });

  it('still reports a write the deadline took and the confirming read cannot settle as unconfirmed', async () => {
    // The other arm of the same rule: when the re-observation proves nothing, the honest answer is
    // that the outcome is unknown — which is still not `unavailable`.
    const transport = scriptedTransport({
      [`GET ${ITEM_URL}`]: [
        { status: 200, body: mergeRequestBody() },
        { status: 200, body: mergeRequestBody({ state: 'opened' }) },
      ],
      [`PUT ${MERGE_URL}`]: [GITLAB_STUB_NEVER_ANSWERS],
    });

    const result = await pastMutationDeadline(
      () => mergeGitlabMergeRequest(mergeInput(), transport.context),
    );

    expect(result).toMatchObject({ kind: 'unconfirmed', observed: { state: 'opened' } });
  });
});
