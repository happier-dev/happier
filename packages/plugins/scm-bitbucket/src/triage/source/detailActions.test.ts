import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import {
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
  measureExternalActionResultResponseEnvelopeUtf8BytesV1,
} from '@happier-dev/plugin-sdk/actions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import currentUser from '../fixtures/currentUser.json' with { type: 'json' };
import pullRequestSelf from '../fixtures/pullRequestSelf.json' with { type: 'json' };

import { encodeBitbucketConfiguration } from '../instance.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from './descriptor.js';
import {
  BITBUCKET_MOUNTED_DETAIL_DEADLINE_MS,
  listBitbucketActivity,
  listBitbucketBuilds,
  listBitbucketComments,
  readBitbucketDiff,
  readBitbucketOverview,
} from './detailActions.js';
import {
  BitbucketActivityResultV1Schema,
  BitbucketBuildsResultV1Schema,
  BitbucketCommentsResultV1Schema,
  BitbucketDiffResultV1Schema,
  BitbucketOverviewResultV1Schema,
} from './detailContracts.js';
import {
  accountRef,
  createConnectedAccountsStub,
  createHttpStub,
  createInvocationContext,
  type StubReply,
} from './testSupport.js';

vi.mock('@happier-dev/plugin-sdk/actions', async () => (
  import('../../../../../protocol/src/actions/externalActionApi.js')
));

const WORKSPACE_UUID = '{4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44}';
const REPOSITORY_UUID = '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}';
const COLLISION_SCOPE = `bitbucket:${REPOSITORY_UUID}`;
const ENTRY_ID = '42';

function configurationToken(workspaceUuid: string): string {
  const encoded = encodeBitbucketConfiguration({ v: 1, workspaceUuid });
  if (!encoded.ok) throw new Error('fixture configuration must encode');
  return encoded.token;
}

function configuredInstance(): TriageConfiguredSourceInstanceV1 {
  return {
    v: 1,
    instance: {
      source: { pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-forge' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: {
      purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
      account: accountRef('account-1'),
    },
    localInstanceKey: WORKSPACE_UUID,
    configuration: { v: 1, token: configurationToken(WORKSPACE_UUID) },
  } as TriageConfiguredSourceInstanceV1;
}

function planeInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: { kindId: 'pull-request', collisionScope: COLLISION_SCOPE, entryId: ENTRY_ID },
    routingToken: 'example/repository',
    ...overrides,
  };
}

function harness(route: (url: string) => StubReply | undefined) {
  const { http, requests } = createHttpStub(route);
  const { connectedAccounts } = createConnectedAccountsStub({
    accounts: [{ accountId: 'account-1' }],
  });
  return { context: createInvocationContext(connectedAccounts, http), requests };
}

/** A Bitbucket collection envelope, with or without a following page. */
function envelope(values: readonly unknown[], next?: string): StubReply {
  return { body: { pagelen: 25, page: 1, values, ...(next === undefined ? {} : { next }) } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the mounted Bitbucket detail deadline', () => {
  it('bounds account materialization as part of the whole operation', async () => {
    vi.useFakeTimers();
    const { connectedAccounts: baseAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const connectedAccounts = {
      ...baseAccounts,
      async materializeListedAccount(
        _request: unknown,
        options?: Readonly<{ signal?: AbortSignal }>,
      ) {
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(options.signal?.reason);
          }, { once: true });
        });
      },
    } as typeof baseAccounts;
    const { http } = createHttpStub(() => undefined);
    const settling = readBitbucketOverview(
      planeInput(),
      createInvocationContext(connectedAccounts, http),
    );

    await vi.advanceTimersByTimeAsync(BITBUCKET_MOUNTED_DETAIL_DEADLINE_MS);

    const settled = BitbucketOverviewResultV1Schema.parse(await settling);
    expect(settled.kind).toBe('unavailable');
    if (settled.kind !== 'unavailable') return;
    expect(settled.failure).toMatchObject({
      class: 'transient',
      code: 'invocation-deadline-exceeded',
    });
  });
});

/* -------------------------------------------------------------------- builds */

describe('Bitbucket builds plane', () => {
  const STATUS = Object.freeze({
    uuid: '{7c0d1e2f-3a4b-4c5d-8e9f-0a1b2c3d4e5f}',
    key: 'PIPELINE',
    name: 'Pipeline #12',
    state: 'FAILED',
    description: 'One step failed',
    url: 'https://bitbucket.org/example/repository/pipelines/results/12',
    created_on: '2026-08-01T00:00:00Z',
    updated_on: '2026-08-01T00:05:00Z',
  });

  it('publishes a rollup only when the page it read is the whole status collection', async () => {
    const complete = harness((url) => (
      url.includes('/pullrequests/42/statuses') ? envelope([STATUS]) : undefined
    ));
    const settled = BitbucketBuildsResultV1Schema.parse(
      await listBitbucketBuilds(planeInput(), complete.context),
    );
    if (settled.kind !== 'builds') throw new Error('the builds page must settle');
    expect(settled.failingCount).toBe(1);
    expect(settled.runningCount).toBe(0);
    expect(settled.passingCount).toBe(0);
  });

  it('omits every build count rather than zeroing one over a partial collection', async () => {
    const partial = harness((url) => (
      url.includes('/pullrequests/42/statuses')
        ? envelope(
          [{ ...STATUS, state: 'SUCCESSFUL' }],
          'https://api.bitbucket.org/2.0/repositories/x/y/pullrequests/42/statuses?page=2',
        )
        : undefined
    ));
    const settled = BitbucketBuildsResultV1Schema.parse(
      await listBitbucketBuilds(planeInput(), partial.context),
    );
    if (settled.kind !== 'builds') throw new Error('the builds page must settle');
    // The row is real and stays; the counts are not, because the unread page may
    // hold the failure. `0 failing` here is a number a reviewer would act on.
    expect(settled.rows).toHaveLength(1);
    expect(settled).not.toHaveProperty('failingCount');
    expect(settled).not.toHaveProperty('runningCount');
    expect(settled).not.toHaveProperty('passingCount');
    expect(settled.continuation).toBeTypeOf('string');
  });

  it('counts a stopped build in none of the three states', async () => {
    const stopped = harness((url) => (
      url.includes('/pullrequests/42/statuses')
        ? envelope([{ ...STATUS, state: 'STOPPED' }])
        : undefined
    ));
    const settled = BitbucketBuildsResultV1Schema.parse(
      await listBitbucketBuilds(planeInput(), stopped.context),
    );
    if (settled.kind !== 'builds') throw new Error('the builds page must settle');
    expect(settled.failingCount).toBe(0);
    expect(settled.runningCount).toBe(0);
    expect(settled.passingCount).toBe(0);
  });
});

/* ------------------------------------------------------------------ comments */

describe('Bitbucket comments plane', () => {
  it('reports an omitted resolution field as unknown, never as unresolved', async () => {
    const seam = harness((url) => (
      url.includes('/pullrequests/42/comments')
        ? envelope([
          // A deployment that does not carry comment resolution omits the key.
          { id: 1, content: { raw: 'silent' }, created_on: '2026-08-01T00:00:00Z' },
          // One that does, and the thread is open.
          { id: 2, content: { raw: 'open' }, resolution: null },
          // One that does, and the thread is resolved.
          { id: 3, content: { raw: 'closed' }, resolution: { user: { display_name: 'A' } } },
        ])
        : undefined
    ));
    const settled = BitbucketCommentsResultV1Schema.parse(
      await listBitbucketComments(planeInput(), seam.context),
    );
    if (settled.kind !== 'comments') throw new Error('the comments page must settle');
    expect(settled.rows.map((row) => row.resolution)).toEqual([
      'unknown',
      'unresolved',
      'resolved',
    ]);
  });

  it('keeps a reply attached to the comment it answers', async () => {
    const seam = harness((url) => (
      url.includes('/pullrequests/42/comments')
        ? envelope([
          { id: 1, content: { raw: 'root' } },
          { id: 2, content: { raw: 'reply' }, parent: { id: 1 } },
        ])
        : undefined
    ));
    const settled = BitbucketCommentsResultV1Schema.parse(
      await listBitbucketComments(planeInput(), seam.context),
    );
    if (settled.kind !== 'comments') throw new Error('the comments page must settle');
    expect(settled.rows[0]).not.toHaveProperty('parentId');
    expect(settled.rows[1]?.parentId).toBe('1');
  });

  it('requests the declared 30-record window and follows only the opaque next link', async () => {
    const nextUrl = 'https://api.bitbucket.org/2.0/repositories/x/y/pullrequests/42/comments?page=2';
    const seam = harness((url) => (
      url.includes('/pullrequests/42/comments')
        ? (url === nextUrl
          ? envelope([{ id: 9, content: { raw: 'second page' } }])
          : envelope([{ id: 1, content: { raw: 'first page' } }], nextUrl))
        : undefined
    ));

    const first = BitbucketCommentsResultV1Schema.parse(
      await listBitbucketComments(planeInput(), seam.context),
    );
    if (first.kind !== 'comments') throw new Error('the comments page must settle');
    expect(seam.requests[0]?.url).toContain('pagelen=30');
    expect(first.continuation).toBeTypeOf('string');

    const second = BitbucketCommentsResultV1Schema.parse(
      await listBitbucketComments(planeInput({ continuation: first.continuation }), seam.context),
    );
    if (second.kind !== 'comments') throw new Error('the second comments page must settle');
    expect(second.rows.map((row) => row.body)).toEqual(['second page']);
    // The opaque link is followed byte-for-byte, never rebuilt.
    expect(seam.requests.map((request) => request.url)).toContain(nextUrl);
    expect(second.continuation).toBeUndefined();
  });

  it('drops a next link outside the Cloud API base instead of following it', async () => {
    const seam = harness((url) => (
      url.includes('/pullrequests/42/comments')
        ? envelope(
          [{ id: 1, content: { raw: 'only page' } }],
          'https://api.bitbucket.org.evil.invalid/2.0/repositories/x/y/pullrequests/42/comments?page=2',
        )
        : undefined
    ));
    const settled = BitbucketCommentsResultV1Schema.parse(
      await listBitbucketComments(planeInput(), seam.context),
    );
    // The walker rejects the untrusted link before the page can be published, so
    // the panel is told the read failed rather than shown a finished collection.
    expect(settled.kind).toBe('unavailable');
    if (settled.kind !== 'unavailable') throw new Error('unreachable');
    expect(settled.failure.code).toBe('untrusted-next-link');
    expect(seam.requests.every((request) => request.url.startsWith('https://api.bitbucket.org/')))
      .toBe(true);
  });
});

describe('Bitbucket detail continuation custody', () => {
  it('refuses a supplied continuation naming a host outside the Cloud API base', async () => {
    const seam = harness(() => undefined);
    // A continuation is caller-supplied input on the way IN: without this gate a
    // hostile or corrupted token aims the materialized credential at that host.
    const forged = JSON.stringify({
      v: 1,
      nextUrl: 'https://api.bitbucket.org.evil.invalid/2.0/repositories/x/y/pullrequests/42/comments',
    });
    const settled = BitbucketCommentsResultV1Schema.parse(
      await listBitbucketComments(planeInput({ continuation: forged }), seam.context),
    );
    expect(settled.kind).toBe('unavailable');
    if (settled.kind !== 'unavailable') throw new Error('unreachable');
    expect(settled.failure.code).toBe('detail-continuation-unreadable');
    expect(seam.requests).toHaveLength(0);
  });

  it('refuses a continuation this source did not mint', async () => {
    const seam = harness(() => undefined);
    const settled = BitbucketActivityResultV1Schema.parse(
      await listBitbucketActivity(planeInput({ continuation: 'not-a-token' }), seam.context),
    );
    expect(settled.kind).toBe('unavailable');
    expect(seam.requests).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ activity */

describe('Bitbucket activity plane', () => {
  it('reads approvals, updates and comments from the one endpoint that carries them', async () => {
    const seam = harness((url) => (
      url.includes('/pullrequests/42/activity')
        ? envelope([
          { approval: { date: '2026-08-01T00:00:00Z', user: { display_name: 'Ada' } } },
          { update: { date: '2026-08-01T00:01:00Z', author: { display_name: 'Grace' } } },
          {
            comment: {
              id: 7,
              created_on: '2026-08-01T00:02:00Z',
              user: { display_name: 'Ada' },
              content: { raw: 'Looks good' },
            },
          },
        ])
        : undefined
    ));
    const settled = BitbucketActivityResultV1Schema.parse(
      await listBitbucketActivity(planeInput(), seam.context),
    );
    if (settled.kind !== 'activity') throw new Error('the activity page must settle');
    expect(settled.rows.map((row) => row.kind)).toEqual(['approval', 'update', 'comment']);
    expect(settled.rows[0]?.actor).toBe('Ada');
    expect(settled.rows[2]?.summary).toBe('Looks good');
    // Exactly one request: Bitbucket has no separate approval or update route,
    // and inventing one would be a call the provider does not answer.
    expect(seam.requests).toHaveLength(1);
  });

  it('keeps an activity arm it does not model instead of dropping the row', async () => {
    const seam = harness((url) => (
      url.includes('/pullrequests/42/activity')
        ? envelope([{ some_future_event: { date: '2026-08-01T00:00:00Z' } }])
        : undefined
    ));
    const settled = BitbucketActivityResultV1Schema.parse(
      await listBitbucketActivity(planeInput(), seam.context),
    );
    if (settled.kind !== 'activity') throw new Error('the activity page must settle');
    const row = settled.rows[0];
    expect(row?.kind).toBe('unsupported');
    // Bitbucket's own word survives, so the stream is not quietly incomplete.
    expect(row?.rawKind).toBe('some_future_event');
    expect(settled.omittedRowCount).toBe(0);
  });

  it('preserves provider labels and comment text beyond the retired local field caps', async () => {
    const actor = 'A'.repeat(1_024);
    const summary = 'provider comment '.repeat(768);
    const seam = harness((url) => (
      url.includes('/pullrequests/42/activity')
        ? envelope([{ comment: {
          id: 7,
          created_on: '2026-08-01T00:02:00Z',
          user: { display_name: actor },
          content: { raw: summary },
        } }])
        : undefined
    ));

    const settled = BitbucketActivityResultV1Schema.parse(
      await listBitbucketActivity(planeInput(), seam.context),
    );
    if (settled.kind !== 'activity') throw new Error('the activity page must settle');
    expect(settled.rows[0]).toMatchObject({ actor, summary: summary.trim() });
    expect(settled.rows[0]).not.toHaveProperty('truncated');
    expect(seam.requests[0]?.url).toContain('pagelen=100');
  });

  it('fits a large activity page through the canonical Action envelope with exact omissions', async () => {
    const rowBodyLength = Math.floor(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2);
    const values = Array.from({ length: 2 }, (_unused, index) => ({
      comment: {
        id: index + 1,
        created_on: '2026-08-01T00:02:00Z',
        user: { display_name: `Actor ${index}` },
        content: {
          raw: `${index}: ${'x'.repeat(rowBodyLength)}`,
        },
      },
    }));
    const seam = harness((url) => (
      url.includes('/pullrequests/42/activity') ? envelope(values) : undefined
    ));

    const settled = BitbucketActivityResultV1Schema.parse(
      await listBitbucketActivity(planeInput(), seam.context),
    );
    if (settled.kind !== 'activity') throw new Error('the activity page must settle');
    expect(settled.rows.length).toBeGreaterThan(0);
    expect(settled.rows.length).toBeLessThan(values.length);
    expect(settled.rows.length + settled.omittedRowCount).toBe(values.length);
    expect(settled.projectionTruncated).toBe(true);
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(settled)).toBe(true);
  });

  it('keeps rows and reports an opaque next page too large for the Action envelope', async () => {
    const nextUrl = 'https://api.bitbucket.org/2.0/repositories/x/y/pullrequests/42/activity'
      + `?cursor=${'c'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES)}`;
    const seam = harness((url) => (
      url.includes('/pullrequests/42/activity')
        ? envelope([{ approval: { date: '2026-08-01T00:00:00Z' } }], nextUrl)
        : undefined
    ));

    const settled = BitbucketActivityResultV1Schema.parse(
      await listBitbucketActivity(planeInput(), seam.context),
    );
    if (settled.kind !== 'activity') throw new Error('the activity page must settle');
    expect(settled.rows).toHaveLength(1);
    expect(settled.continuation).toBeUndefined();
    expect(settled.incomplete).toBe('continuationUnavailable');
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(settled)).toBe(true);
  });

  it('keeps an ordinary opaque next page without reporting the walk incomplete', async () => {
    const nextUrl = 'https://api.bitbucket.org/2.0/repositories/x/y/pullrequests/42/activity?page=2';
    const seam = harness((url) => (
      url.includes('/pullrequests/42/activity')
        ? envelope([{ approval: { date: '2026-08-01T00:00:00Z' } }], nextUrl)
        : undefined
    ));

    const settled = BitbucketActivityResultV1Schema.parse(
      await listBitbucketActivity(planeInput(), seam.context),
    );
    if (settled.kind !== 'activity') throw new Error('the activity page must settle');
    expect(settled.rows).toHaveLength(1);
    expect(settled.continuation).toBeTypeOf('string');
    expect(settled.incomplete).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ admission */

describe('Bitbucket detail admission', () => {
  it('refuses an entry keyed against another repository scope before any provider call', async () => {
    const seam = harness(() => undefined);
    const settled = BitbucketCommentsResultV1Schema.parse(await listBitbucketComments(planeInput({
      localRef: { kindId: 'pull-request', collisionScope: 'bitbucket:not-a-uuid', entryId: '42' },
    }), seam.context));
    expect(settled.kind).toBe('unavailable');
    if (settled.kind !== 'unavailable') throw new Error('unreachable');
    expect(settled.failure.code).toBe('collision-scope-invalid');
    expect(seam.requests).toHaveLength(0);
  });

  it('refuses a kind this source never declared before any provider call', async () => {
    const seam = harness(() => undefined);
    const settled = BitbucketActivityResultV1Schema.parse(await listBitbucketActivity(planeInput({
      localRef: { kindId: 'issue', collisionScope: COLLISION_SCOPE, entryId: '42' },
    }), seam.context));
    expect(settled.kind).toBe('unavailable');
    if (settled.kind !== 'unavailable') throw new Error('unreachable');
    expect(settled.failure.code).toBe('kind-not-declared');
    expect(seam.requests).toHaveLength(0);
  });
});

describe('Bitbucket authoritative Overview and Diff planes', () => {
  it('re-reads Overview from Bitbucket instead of replaying only the launch observation', async () => {
    const fresh = { ...pullRequestSelf, title: 'Fresh provider title' };
    const seam = harness((url) => {
      if (url.endsWith('/2.0/user')) return { body: currentUser };
      if (url.includes('/pullrequests/42')) return { body: fresh };
      return undefined;
    });
    const settled = BitbucketOverviewResultV1Schema.parse(
      await readBitbucketOverview(planeInput(), seam.context),
    );
    expect(settled.kind).toBe('overview');
    if (settled.kind !== 'overview' || settled.observation.kind !== 'present') {
      throw new Error('the fresh overview must be present');
    }
    expect(settled.observation.snapshot.title).toBe('Fresh provider title');
    expect(settled.observation.snapshot.summary).toBe(pullRequestSelf.summary.raw);
    expect(seam.requests.map((request) => request.url)).toEqual([
      'https://api.bitbucket.org/2.0/user',
      `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(WORKSPACE_UUID)}`
        + `/${encodeURIComponent(REPOSITORY_UUID)}/pullrequests/42`,
    ]);
  });

  it('reports a failed authoritative Overview read as unavailable, never as refreshed', async () => {
    const seam = harness((url) => (
      url.endsWith('/2.0/user') ? { status: 401, body: { type: 'error' } } : undefined
    ));
    const settled = BitbucketOverviewResultV1Schema.parse(
      await readBitbucketOverview(planeInput(), seam.context),
    );
    expect(settled.kind).toBe('unavailable');
    expect(seam.requests).toHaveLength(1);
  });

  it('follows the provider raw-diff redirect, keeps diffstat, and truncates the result by Action bytes', async () => {
    const redirected = 'https://api.bitbucket.org/2.0/repositories/x/y/diff/main..feature';
    const oversized = `diff --git a/a.ts b/a.ts\n${'"\\\n'.repeat(4_000_000)}🚀`;
    const seam = harness((url) => {
      if (url.endsWith('/pullrequests/42/diff')) {
        return { status: 302, headers: { location: redirected } };
      }
      if (url === redirected) return { bodyBytes: oversized };
      if (url.includes('/pullrequests/42/diffstat')) {
        return envelope([{
          status: 'modified',
          lines_added: 2,
          lines_removed: 1,
          old: { path: 'src/a.ts' },
          new: { path: 'src/a.ts' },
        }]);
      }
      return undefined;
    });

    const settled = BitbucketDiffResultV1Schema.parse(
      await readBitbucketDiff(planeInput(), seam.context),
    );
    expect(settled.kind).toBe('diff');
    if (settled.kind !== 'diff') throw new Error('the diff must settle');
    expect(settled.files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(settled.raw).toMatchObject({ kind: 'available', truncated: true });
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(settled)).toBe(true);
    if (settled.raw?.kind !== 'available') throw new Error('the raw prefix must be available');
    const nextCodePoint = Array.from(oversized.slice(settled.raw.text.length))[0];
    expect(nextCodePoint).toBeDefined();
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1({
      ...settled,
      raw: { ...settled.raw, text: `${settled.raw.text}${nextCodePoint}` },
    })).toBe(false);
    expect(seam.requests.find((request) => request.url.endsWith('/pullrequests/42/diff'))?.redirect)
      .toBe('manual');
    expect(seam.requests.some((request) => request.url === redirected)).toBe(true);
  });

  it('fits file rows together with Bitbucket 555 raw-result framing', async () => {
    const resultWithoutRaw = (statusLength: number) => ({
      kind: 'diff' as const,
      files: [{
        path: 'src/a.ts',
        status: 'x'.repeat(statusLength),
        linesAdded: 0,
        linesRemoved: 0,
      }],
      omittedRowCount: 0,
      projectionTruncated: false,
    });
    const emptyStatusBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1(
      resultWithoutRaw(0),
    );
    const statusLength = EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - emptyStatusBytes;
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(resultWithoutRaw(statusLength)))
      .toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(resultWithoutRaw(statusLength + 1)))
      .toBe(false);

    const seam = harness((url) => {
      if (url.endsWith('/pullrequests/42/diff')) return { status: 555, body: { type: 'error' } };
      if (url.includes('/pullrequests/42/diffstat')) {
        return envelope([{
          status: 'x'.repeat(statusLength),
          lines_added: 0,
          lines_removed: 0,
          old: { path: 'src/a.ts' },
          new: { path: 'src/a.ts' },
        }]);
      }
      return undefined;
    });
    const settled = BitbucketDiffResultV1Schema.parse(
      await readBitbucketDiff(planeInput(), seam.context),
    );
    expect(settled).toMatchObject({ kind: 'diff', raw: { kind: 'tooLarge' } });
    if (settled.kind !== 'diff') throw new Error('the diff must settle');
    expect(settled.files.length + settled.omittedRowCount).toBe(1);
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(settled)).toBe(true);
  });

  it('refuses a raw-diff redirect outside the Bitbucket API origin before sending credentials', async () => {
    const seam = harness((url) => {
      if (url.endsWith('/pullrequests/42/diff')) {
        return { status: 302, headers: { location: 'https://example.invalid/stolen.diff' } };
      }
      if (url.includes('/pullrequests/42/diffstat')) return envelope([]);
      return undefined;
    });
    const settled = BitbucketDiffResultV1Schema.parse(
      await readBitbucketDiff(planeInput(), seam.context),
    );
    expect(settled.kind).toBe('unavailable');
    if (settled.kind !== 'unavailable') throw new Error('unreachable');
    expect(settled.failure.code).toBe('untrusted-diff-redirect');
    expect(seam.requests.every((request) => request.url.startsWith('https://api.bitbucket.org/')))
      .toBe(true);
  });
});
