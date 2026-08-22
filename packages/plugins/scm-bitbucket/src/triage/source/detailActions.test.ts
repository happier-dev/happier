import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { encodeBitbucketConfiguration } from '../instance.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from './descriptor.js';
import {
  listBitbucketActivity,
  listBitbucketBuilds,
  listBitbucketComments,
} from './detailActions.js';
import {
  BitbucketActivityResultV1Schema,
  BitbucketBuildsResultV1Schema,
  BitbucketCommentsResultV1Schema,
} from './detailContracts.js';
import {
  accountRef,
  createConnectedAccountsStub,
  createHttpStub,
  createInvocationContext,
  type StubReply,
} from './testSupport.js';

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
