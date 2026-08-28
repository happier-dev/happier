import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
} from '@happier-dev/plugin-sdk/actions';

import {
  GitlabActivityEventsResultV1Schema,
  GitlabApprovalsResultV1Schema,
  GitlabChangesResultV1Schema,
  GitlabDiscussionsResultV1Schema,
  GitlabNotesResultV1Schema,
  GitlabPipelinesResultV1Schema,
  GitlabRawDiffResultV1Schema,
} from './detail/contracts.js';
import {
  listGitlabActivityEvents,
  listGitlabChanges,
  listGitlabDiscussions,
  listGitlabNotes,
  listGitlabPipelines,
  readGitlabRawDiff,
  readGitlabApprovals,
} from './detailOperations.js';
import {
  GITLAB_TEST_COLLISION_SCOPE,
  GITLAB_TEST_ORIGIN,
  createStubGitlabTransport,
  gitlabNextLinkHeader,
  gitlabTestConfiguredInstance,
  GITLAB_STUB_NEVER_ANSWERS,
  type RecordedGitlabRequest,
  type StubGitlabResponse,
} from './testkit/gitlabTriage.test-support.js';
import { GITLAB_MOUNTED_DETAIL_DEADLINE_MS } from './admission.js';

const MERGE_REQUEST_REF = Object.freeze({
  kindId: 'merge-request',
  collisionScope: GITLAB_TEST_COLLISION_SCOPE,
  entryId: '7',
});
const ISSUE_REF = Object.freeze({
  kindId: 'issue',
  collisionScope: GITLAB_TEST_COLLISION_SCOPE,
  entryId: '7',
});
const ROUTING_TOKEN = 'group/subgroup/project';

function planeInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: gitlabTestConfiguredInstance(),
    localRef: MERGE_REQUEST_REF,
    routingToken: ROUTING_TOKEN,
    limit: 20,
    ...overrides,
  };
}

/**
 * The approvals plane carries no paging position: its two reads settle inside
 * one invocation, so its published input has no `limit` and the closed schema
 * rejects one.
 */
function itemInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: gitlabTestConfiguredInstance(),
    localRef: MERGE_REQUEST_REF,
    routingToken: ROUTING_TOKEN,
    ...overrides,
  };
}

function ok(body: unknown, headers: Readonly<Record<string, string>> = {}): StubGitlabResponse {
  return { status: 200, headers: { 'content-type': 'application/json', ...headers }, body };
}

function pathOf(request: RecordedGitlabRequest): string {
  return new URL(request.url).pathname;
}

/* ----------------------------------------------------------------- pipelines */

describe('GitLab pipelines plane', () => {
  const PIPELINE = Object.freeze({
    id: 91,
    status: 'running',
    ref: 'feature/x',
    sha: 'a'.repeat(40),
    source: 'merge_request_event',
    web_url: 'https://gitlab.com/group/subgroup/project/-/pipelines/91',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:05:00Z',
  });

  it('reports a null pipeline rollup rather than zero when the breakdown is unavailable', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => {
        const path = pathOf(request);
        if (path.endsWith('/merge_requests/7/pipelines')) return ok([PIPELINE]);
        // GitLab answers the per-job breakdown with a permission refusal: this
        // account may read the merge request but not the pipeline's jobs.
        if (path.endsWith('/pipelines/91/jobs')) return { status: 403, body: { message: '403' } };
        return undefined;
      },
    });

    const result = GitlabPipelinesResultV1Schema.parse(
      await listGitlabPipelines(planeInput(), stub.context),
    );

    expect(result.kind).toBe('pipelines');
    if (result.kind !== 'pipelines') throw new Error('unreachable');
    // The pipeline row itself is real and stays.
    expect(result.rows.map((row) => row.id)).toEqual(['91']);
    // The three counts are ABSENT, not zero. A rendered `0 failing` over a job
    // list nobody could read is the fabricated fact this rule exists to prevent.
    expect(result).not.toHaveProperty('failingCount');
    expect(result).not.toHaveProperty('runningCount');
    expect(result).not.toHaveProperty('passingCount');
    expect(result).not.toHaveProperty('rollupPipelineId');
  });

  it('publishes the per-job rollup of the newest pipeline when the breakdown reads', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => {
        const path = pathOf(request);
        if (path.endsWith('/merge_requests/7/pipelines')) return ok([PIPELINE]);
        if (path.endsWith('/pipelines/91/jobs')) {
          return ok([
            { id: 1, status: 'failed' },
            { id: 2, status: 'success' },
            { id: 3, status: 'running' },
            // Neither failing, running nor passing — counted in none of the three.
            { id: 4, status: 'skipped' },
          ]);
        }
        return undefined;
      },
    });

    const result = GitlabPipelinesResultV1Schema.parse(
      await listGitlabPipelines(planeInput(), stub.context),
    );
    if (result.kind !== 'pipelines') throw new Error('the pipelines page must settle');
    expect(result.failingCount).toBe(1);
    expect(result.passingCount).toBe(1);
    expect(result.runningCount).toBe(1);
    expect(result.rollupPipelineId).toBe('91');
  });

  it('distinguishes an empty job list from an unreadable one', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => {
        const path = pathOf(request);
        if (path.endsWith('/merge_requests/7/pipelines')) return ok([PIPELINE]);
        if (path.endsWith('/pipelines/91/jobs')) return ok([]);
        return undefined;
      },
    });

    const result = GitlabPipelinesResultV1Schema.parse(
      await listGitlabPipelines(planeInput(), stub.context),
    );
    if (result.kind !== 'pipelines') throw new Error('the pipelines page must settle');
    // A pipeline that genuinely ran no jobs DOES report three zeroes: the
    // provider answered, and the answer was nothing.
    expect(result.failingCount).toBe(0);
    expect(result.runningCount).toBe(0);
    expect(result.passingCount).toBe(0);
  });

  it('does not publish a complete rollup from only the first jobs page', async () => {
    const jobsNext = `${GITLAB_TEST_ORIGIN}/api/v4/projects/3/pipelines/91/jobs?page=2&per_page=20`;
    const stub = createStubGitlabTransport({
      respond: (request) => {
        const path = pathOf(request);
        if (path.endsWith('/merge_requests/7/pipelines')) return ok([PIPELINE]);
        if (path.endsWith('/pipelines/91/jobs')) {
          return ok(
            [{ id: 1, status: 'success' }],
            gitlabNextLinkHeader(jobsNext),
          );
        }
        return undefined;
      },
    });

    const result = GitlabPipelinesResultV1Schema.parse(
      await listGitlabPipelines(planeInput(), stub.context),
    );
    if (result.kind !== 'pipelines') throw new Error('the pipelines page must settle');

    // The page did not contain the whole breakdown. Publishing `1 passing` here
    // would make a partial first page look like the complete newest pipeline.
    expect(result).not.toHaveProperty('failingCount');
    expect(result).not.toHaveProperty('runningCount');
    expect(result).not.toHaveProperty('passingCount');
    expect(result).not.toHaveProperty('rollupPipelineId');
  });

  it('aggregates every provider-linked jobs page before publishing the rollup', async () => {
    const jobsNext = `${GITLAB_TEST_ORIGIN}/api/v4/projects/3/pipelines/91/jobs?page=2&per_page=20`;
    const stub = createStubGitlabTransport({
      respond: (request) => {
        const requestUrl = new URL(request.url);
        if (requestUrl.pathname.endsWith('/merge_requests/7/pipelines')) return ok([PIPELINE]);
        if (!requestUrl.pathname.endsWith('/pipelines/91/jobs')) return undefined;
        return requestUrl.searchParams.get('page') === '2'
          ? ok([
            { id: 2, status: 'failed' },
            { id: 3, status: 'running' },
          ])
          : ok([{ id: 1, status: 'success' }], gitlabNextLinkHeader(jobsNext));
      },
    });

    const result = GitlabPipelinesResultV1Schema.parse(
      await listGitlabPipelines(planeInput(), stub.context),
    );
    if (result.kind !== 'pipelines') throw new Error('the pipelines page must settle');

    expect(result.failingCount).toBe(1);
    expect(result.runningCount).toBe(1);
    expect(result.passingCount).toBe(1);
    expect(result.rollupPipelineId).toBe('91');
  });

  it('does not publish a rollup when the jobs Link walk cycles', async () => {
    const jobsFirst = `${GITLAB_TEST_ORIGIN}/api/v4/projects/3/pipelines/91/jobs?per_page=20`;
    const jobsNext = `${GITLAB_TEST_ORIGIN}/api/v4/projects/3/pipelines/91/jobs?page=2&per_page=20`;
    const stub = createStubGitlabTransport({
      respond: (request) => {
        const requestUrl = new URL(request.url);
        if (requestUrl.pathname.endsWith('/merge_requests/7/pipelines')) return ok([PIPELINE]);
        if (!requestUrl.pathname.endsWith('/pipelines/91/jobs')) return undefined;
        return requestUrl.searchParams.get('page') === '2'
          ? ok([{ id: 2, status: 'failed' }], gitlabNextLinkHeader(jobsFirst))
          : ok([{ id: 1, status: 'success' }], gitlabNextLinkHeader(jobsNext));
      },
    });

    const result = GitlabPipelinesResultV1Schema.parse(
      await listGitlabPipelines(planeInput(), stub.context),
    );
    if (result.kind !== 'pipelines') throw new Error('the pipelines page must settle');

    expect(result).not.toHaveProperty('failingCount');
    expect(result).not.toHaveProperty('runningCount');
    expect(result).not.toHaveProperty('passingCount');
    expect(result).not.toHaveProperty('rollupPipelineId');
  });
});

/* ------------------------------------------------------------------- changes */

describe('GitLab changes plane', () => {
  it('does not treat absent pre-18.4 collapsed/too_large fields as false', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => (
        pathOf(request).endsWith('/merge_requests/7/diffs')
          ? ok([
            // A deployment that predates the 18.4 per-file truncation fields
            // simply omits them. It said nothing about truncation.
            { old_path: 'src/a.ts', new_path: 'src/a.ts', new_file: false, renamed_file: false, deleted_file: false },
          ])
          : undefined
      ),
    });

    const result = GitlabChangesResultV1Schema.parse(
      await listGitlabChanges(planeInput(), stub.context),
    );
    if (result.kind !== 'changes') throw new Error('the changes page must settle');
    const row = result.rows[0];
    expect(row).toBeDefined();
    // Absent stays absent. `collapsed: false` here would tell a reviewer this
    // file's diff is whole on a response that never claimed so.
    expect(row).not.toHaveProperty('collapsed');
    expect(row).not.toHaveProperty('tooLarge');
    expect(result.diffLimitStatus).toBe('unknown');
  });

  it('reports the diff limit status when every file carried GitLab 18.4 evidence', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => (
        pathOf(request).endsWith('/merge_requests/7/diffs')
          ? ok([
            { old_path: 'src/a.ts', new_path: 'src/a.ts', collapsed: false, too_large: false },
            { old_path: 'src/b.bin', new_path: 'src/b.bin', collapsed: false, too_large: true },
          ])
          : undefined
      ),
    });

    const result = GitlabChangesResultV1Schema.parse(
      await listGitlabChanges(planeInput(), stub.context),
    );
    if (result.kind !== 'changes') throw new Error('the changes page must settle');
    expect(result.diffLimitStatus).toBe('reported');
    expect(result.rows[1]?.tooLarge).toBe(true);
    expect(result.rows[0]?.collapsed).toBe(false);
  });

  it('degrades the whole page to unknown when one file omits its truncation evidence', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => (
        pathOf(request).endsWith('/merge_requests/7/diffs')
          ? ok([
            { old_path: 'src/a.ts', new_path: 'src/a.ts', collapsed: false, too_large: false },
            { old_path: 'src/b.ts', new_path: 'src/b.ts' },
          ])
          : undefined
      ),
    });

    const result = GitlabChangesResultV1Schema.parse(
      await listGitlabChanges(planeInput(), stub.context),
    );
    if (result.kind !== 'changes') throw new Error('the changes page must settle');
    // One silent file is enough: the tab may not claim a complete diff.
    expect(result.diffLimitStatus).toBe('unknown');
  });

  it('keeps the default changed-file read on current /diffs only', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => (
        pathOf(request).endsWith('/merge_requests/7/diffs') ? ok([]) : undefined
      ),
    });

    await listGitlabChanges(planeInput(), stub.context);
    const requested = stub.requests.map((request) => request.url);
    expect(requested.some((url) => url.includes('/changes'))).toBe(false);
    expect(requested.some((url) => url.includes('raw_diffs'))).toBe(false);
    expect(requested.some((url) => url.includes('access_raw_diffs'))).toBe(false);
  });

  it('reads raw_diffs as labelled raw text only after the dedicated user action', async () => {
    const rawText = 'diff --git a/src/a.ts b/src/a.ts\n+const ready = true;\n';
    const stub = createStubGitlabTransport({
      respond: (request) => (
        pathOf(request).endsWith('/merge_requests/7/raw_diffs')
          ? { status: 200, headers: { 'content-type': 'text/plain' }, bodyText: rawText }
          : undefined
      ),
    });

    const result = GitlabRawDiffResultV1Schema.parse(
      await readGitlabRawDiff(itemInput(), stub.context),
    );

    expect(result).toEqual({ kind: 'rawDiff', text: rawText, truncated: false });
    expect(stub.requests).toHaveLength(1);
    expect(pathOf(stub.requests[0]!)).toBe('/api/v4/projects/3/merge_requests/7/raw_diffs');
    expect(stub.requests[0]?.headers.Accept).toBe('text/plain');
    expect(stub.requests[0]?.redirect).toBe('error');
  });
});

/* ----------------------------------------------------------------- approvals */

describe('GitLab approvals plane', () => {
  const APPROVAL_STATE = Object.freeze({
    approvals_required: 2,
    approvals_left: 1,
    approved_by: [{ user: { username: 'reviewer-one' } }],
    user_has_approved: false,
    user_can_approve: true,
  });

  it('offers approve on a Free-tier instance while reporting approval rules as edition_unsupported', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => {
        const path = pathOf(request);
        if (path.endsWith('/merge_requests/7/approvals')) return ok(APPROVAL_STATE);
        // Free tier: the rules endpoint is Premium-only and answers 403.
        if (path.endsWith('/merge_requests/7/approval_rules')) {
          return { status: 403, body: { message: '403 Forbidden' } };
        }
        return undefined;
      },
    });

    const result = GitlabApprovalsResultV1Schema.parse(
      await readGitlabApprovals(itemInput(), stub.context),
    );

    expect(result.kind).toBe('approvals');
    if (result.kind !== 'approvals') throw new Error('unreachable');
    // The whole tab does not go down with the Premium-only half.
    expect(result.userCanApprove).toBe(true);
    expect(result.approvalsRequired).toBe(2);
    expect(result.approvalsLeft).toBe(1);
    expect(result.approvedBy).toEqual(['reviewer-one']);
    expect(result.rules.kind).toBe('editionUnsupported');
  });

  it('reads approval rules when the tier supplies them', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => {
        const path = pathOf(request);
        if (path.endsWith('/merge_requests/7/approvals')) return ok(APPROVAL_STATE);
        if (path.endsWith('/merge_requests/7/approval_rules')) {
          return ok([{ id: 4, name: 'Backend owners', approvals_required: 1, approved: false }]);
        }
        return undefined;
      },
    });

    const result = GitlabApprovalsResultV1Schema.parse(
      await readGitlabApprovals(itemInput(), stub.context),
    );
    if (result.kind !== 'approvals') throw new Error('the approvals read must settle');
    if (result.rules.kind !== 'available') throw new Error('the rules must be available');
    expect(result.rules.rules).toEqual([
      { id: '4', name: 'Backend owners', approvalsRequired: 1, approved: false },
    ]);
  });

  it('preserves provider approvers and rules beyond the retired local count ceilings', async () => {
    const approvedBy = Array.from(
      { length: 41 },
      (_, index) => ({ user: { username: `reviewer-${index}` } }),
    );
    const approvalRules = Array.from(
      { length: 41 },
      (_, index) => ({ id: index + 1, name: `Rule ${index}`, approvals_required: 1 }),
    );
    const stub = createStubGitlabTransport({
      respond: (request) => {
        const path = pathOf(request);
        if (path.endsWith('/merge_requests/7/approvals')) {
          return ok({ ...APPROVAL_STATE, approved_by: approvedBy });
        }
        if (path.endsWith('/merge_requests/7/approval_rules')) return ok(approvalRules);
        return undefined;
      },
    });

    const result = GitlabApprovalsResultV1Schema.parse(
      await readGitlabApprovals(itemInput(), stub.context),
    );
    if (result.kind !== 'approvals') throw new Error('the approvals read must settle');
    if (result.rules.kind !== 'available') throw new Error('the rules must be available');
    expect(result.approvedBy).toHaveLength(approvedBy.length);
    expect(result.omittedApproverCount).toBe(0);
    expect(result.rules.rules).toHaveLength(approvalRules.length);
    expect(result.rules.omittedRuleCount).toBe(0);
    expect(result.projectionTruncated).toBe(false);
  });

  it('reports malformed provider approvers as omitted rather than silently losing them', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => {
        const path = pathOf(request);
        if (path.endsWith('/merge_requests/7/approvals')) {
          return ok({
            ...APPROVAL_STATE,
            approved_by: [
              { user: { username: 'reviewer-one' } },
              { user: { name: 'missing provider username' } },
            ],
          });
        }
        if (path.endsWith('/merge_requests/7/approval_rules')) {
          return { status: 403, body: { message: '403 Forbidden' } };
        }
        return undefined;
      },
    });

    const result = GitlabApprovalsResultV1Schema.parse(
      await readGitlabApprovals(itemInput(), stub.context),
    );
    if (result.kind !== 'approvals') throw new Error('the approvals read must settle');
    expect(result.approvedBy).toEqual(['reviewer-one']);
    expect(result.omittedApproverCount).toBe(1);
    expect(result.projectionTruncated).toBe(true);
  });

  it('keeps a real rules failure distinct from a licence answer', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => {
        const path = pathOf(request);
        if (path.endsWith('/merge_requests/7/approvals')) return ok(APPROVAL_STATE);
        if (path.endsWith('/merge_requests/7/approval_rules')) {
          return { status: 503, body: { message: 'unavailable' } };
        }
        return undefined;
      },
    });

    const result = GitlabApprovalsResultV1Schema.parse(
      await readGitlabApprovals(itemInput(), stub.context),
    );
    if (result.kind !== 'approvals') throw new Error('the approvals read must settle');
    // A forge outage is not a licence tier, and must not be reported as one.
    expect(result.rules.kind).toBe('unavailable');
  });
});

/* -------------------------------------------------- independent Link custody */

describe('GitLab detail paging custody', () => {
  const NOTES_NEXT = `${GITLAB_TEST_ORIGIN}/api/v4/projects/3/merge_requests/7/notes?page=2&per_page=20`;
  const EVENTS_NEXT = `${GITLAB_TEST_ORIGIN}/api/v4/projects/3/merge_requests/7/resource_state_events?page=2&per_page=20`;

  it('advances one collection through its own provider Link without touching a sibling', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/notes')) {
          return url.searchParams.get('page') === '2'
            ? ok([{ id: 2, body: 'second page note', created_at: '2026-08-02T00:00:00Z' }])
            : ok(
              [{ id: 1, body: 'first page note', created_at: '2026-08-01T00:00:00Z' }],
              gitlabNextLinkHeader(NOTES_NEXT),
            );
        }
        if (url.pathname.endsWith('/resource_state_events')) {
          return ok(
            [{ id: 11, state: 'closed', created_at: '2026-08-01T00:00:00Z', user: { username: 'a' } }],
            gitlabNextLinkHeader(EVENTS_NEXT),
          );
        }
        return undefined;
      },
    });

    const first = GitlabNotesResultV1Schema.parse(
      await listGitlabNotes(planeInput(), stub.context),
    );
    if (first.kind !== 'notes') throw new Error('the notes page must settle');
    expect(first.continuation).toBeTypeOf('string');

    // The event source is read independently and hands back its OWN cursor.
    const events = GitlabActivityEventsResultV1Schema.parse(
      await listGitlabActivityEvents(planeInput({ eventSource: 'state' }), stub.context),
    );
    if (events.kind !== 'activityEvents') throw new Error('the events page must settle');
    expect(events.continuation).toBeTypeOf('string');
    expect(events.continuation).not.toBe(first.continuation);

    // Resuming the notes walk requests exactly the URL GitLab issued, and
    // nothing on the event collection moves.
    const second = GitlabNotesResultV1Schema.parse(
      await listGitlabNotes(planeInput({ continuation: first.continuation }), stub.context),
    );
    if (second.kind !== 'notes') throw new Error('the second notes page must settle');
    expect(second.rows.map((row) => row.body)).toEqual(['second page note']);
    expect(second.continuation).toBeUndefined();
    expect(stub.requests.map((request) => request.url)).toContain(NOTES_NEXT);
  });

  it('refuses a continuation minted under a different window', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => (
        pathOf(request).endsWith('/notes')
          ? ok([{ id: 1, body: 'note' }], gitlabNextLinkHeader(NOTES_NEXT))
          : undefined
      ),
    });

    const first = GitlabNotesResultV1Schema.parse(
      await listGitlabNotes(planeInput({ limit: 20 }), stub.context),
    );
    if (first.kind !== 'notes') throw new Error('the notes page must settle');

    const resumed = GitlabNotesResultV1Schema.parse(
      // Same token, different window: the position names different rows now.
      await listGitlabNotes(planeInput({ limit: 21, continuation: first.continuation }), stub.context),
    );
    expect(resumed.kind).toBe('unavailable');
  });

  it('drops a cross-origin next page instead of following it', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => (
        pathOf(request).endsWith('/notes')
          ? ok(
            [{ id: 1, body: 'note' }],
            gitlabNextLinkHeader('https://gitlab.example.invalid/api/v4/projects/3/merge_requests/7/notes?page=2'),
          )
          : undefined
      ),
    });

    const result = GitlabNotesResultV1Schema.parse(
      await listGitlabNotes(planeInput(), stub.context),
    );
    if (result.kind !== 'notes') throw new Error('the notes page must settle');
    // The rows GitLab did return are kept; the walk simply ends here.
    expect(result.rows).toHaveLength(1);
    expect(result.continuation).toBeUndefined();
    expect(stub.requests.every((request) => request.url.startsWith(GITLAB_TEST_ORIGIN))).toBe(true);
  });

  it('fits provider rows to the canonical Action response envelope with honest omission evidence', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => (
        pathOf(request).endsWith('/notes')
          ? ok([
            { id: 1, body: 'kept note', created_at: '2026-08-01T00:00:00Z' },
            {
              id: 2,
              body: 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES),
              created_at: '2026-08-01T00:01:00Z',
            },
          ])
          : undefined
      ),
    });

    const result = GitlabNotesResultV1Schema.parse(
      await listGitlabNotes(planeInput(), stub.context),
    );
    if (result.kind !== 'notes') throw new Error('the notes page must settle');
    expect(result.rows.map((row) => row.id)).toEqual(['1']);
    expect(result.omittedRowCount).toBe(1);
    expect(result.projectionTruncated).toBe(true);
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
  });

  it('keeps fitting rows and reports pagination when an opaque provider Link cannot fit', async () => {
    const oversizedNext = `${GITLAB_TEST_ORIGIN}/api/v4/projects/3/merge_requests/7/notes?cursor=${'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES)}`;
    const stub = createStubGitlabTransport({
      respond: (request) => (
        pathOf(request).endsWith('/notes')
          ? ok(
            [{ id: 1, body: 'kept note', created_at: '2026-08-01T00:00:00Z' }],
            gitlabNextLinkHeader(oversizedNext),
          )
          : undefined
      ),
    });

    const result = GitlabNotesResultV1Schema.parse(
      await listGitlabNotes(planeInput(), stub.context),
    );
    if (result.kind !== 'notes') throw new Error('the notes page must settle');
    expect(result.rows.map((row) => row.id)).toEqual(['1']);
    expect(result.continuation).toBeUndefined();
    expect(result.incomplete).toBe('pagination');
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
  });
});

/* ------------------------------------------------------------ kind admission */

describe('GitLab detail kind admission', () => {
  it('refuses a merge-request-only plane for an issue without issuing a request', async () => {
    const stub = createStubGitlabTransport({
      respond: () => undefined,
    });

    for (const operation of [listGitlabChanges, listGitlabPipelines, listGitlabDiscussions]) {
      const result = await operation(planeInput({ localRef: ISSUE_REF }), stub.context);
      expect(result.kind).toBe('unavailable');
    }
    // An issue has no changed files, pipelines or review discussions, and an
    // empty page would be a different claim from "this plane does not apply".
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses an entry keyed against another deployment before any provider call', async () => {
    const stub = createStubGitlabTransport({ respond: () => undefined });

    const result = GitlabNotesResultV1Schema.parse(await listGitlabNotes(planeInput({
      localRef: { ...MERGE_REQUEST_REF, collisionScope: 'gitlab:c2VsZi1tYW5hZ2Vk:3' },
    }), stub.context));

    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') throw new Error('unreachable');
    expect(result.failure.code).toBe('scope-outside-binding');
    expect(stub.requests).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- discussions */

describe('GitLab discussions plane', () => {
  it('publishes the whole returned thread so the reply window stays client-local', async () => {
    const stub = createStubGitlabTransport({
      respond: (request) => (
        pathOf(request).endsWith('/merge_requests/7/discussions')
          ? ok([{
            id: 'a1b2c3d4',
            individual_note: false,
            notes: [
              { id: 1, body: 'first', created_at: '2026-08-01T00:00:00Z', resolved: false },
              { id: 2, body: 'second', created_at: '2026-08-01T00:01:00Z', resolved: false },
              { id: 3, body: 'third', created_at: '2026-08-01T00:02:00Z', resolved: true },
            ],
          }])
          : undefined
      ),
    });

    const result = GitlabDiscussionsResultV1Schema.parse(
      await listGitlabDiscussions(planeInput(), stub.context),
    );
    if (result.kind !== 'discussions') throw new Error('the discussions page must settle');
    const thread = result.rows[0];
    expect(thread?.id).toBe('a1b2c3d4');
    // All three notes cross the boundary: `Show 4 earlier replies` is a window
    // over data the panel holds, never an invented nested HTTP cursor.
    expect(thread?.notes.map((note) => note.body)).toEqual(['first', 'second', 'third']);
    expect(thread?.omittedNoteCount).toBe(0);
    expect(stub.requests).toHaveLength(1);
  });
});


/**
 * The source-owned deadline on a mounted GitLab detail read.
 *
 * `CONTRACT.md` §5.2 gives the SOURCE the private deadline for every mounted detail read, and
 * gives it no public field and no host timer to borrow one from. Without it a panel whose provider
 * stops answering waits on the caller's signal alone — which, for a mounted surface, means until
 * the surface is torn down. The reader sees a spinner that never resolves beside retained sibling
 * content that quietly disappears, and the invocation holds its account materialization open the
 * whole time.
 */
describe('the GitLab detail deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('abandons a mounted detail read on its own deadline instead of waiting on the caller', async () => {
    vi.useFakeTimers();
    const transport = createStubGitlabTransport({ respond: () => GITLAB_STUB_NEVER_ANSWERS });

    const pending = listGitlabNotes(planeInput(), transport.context);
    // The caller never cancels: this proves the source's own bound, not the host's.
    await vi.advanceTimersByTimeAsync(GITLAB_MOUNTED_DETAIL_DEADLINE_MS + 1);
    const result = GitlabNotesResultV1Schema.parse(await pending);

    // A deadline is not a cancellation. The reader navigated nowhere; GitLab stopped answering,
    // and the panel is owed that answer rather than the one that means "you left".
    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { class: 'transient', code: 'deadline-exceeded' },
    });
    expect(transport.requests).toHaveLength(1);
  });
});
