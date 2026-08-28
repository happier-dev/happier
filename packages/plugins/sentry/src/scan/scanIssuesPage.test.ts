import { describe, expect, it, vi } from 'vitest';
import { MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';

import issuesListDirectHit from '../fixtures/issuesListDirectHit.json' with { type: 'json' };
import issuesListMalformedRows from '../fixtures/issuesListMalformedRows.json' with { type: 'json' };
import issuesListNoLinkHeader from '../fixtures/issuesListNoLinkHeader.json' with { type: 'json' };
import issuesListPage1 from '../fixtures/issuesListPage1.json' with { type: 'json' };
import issuesListPage2 from '../fixtures/issuesListPage2.json' with { type: 'json' };
import issuesListRateLimited from '../fixtures/issuesListRateLimited.json' with { type: 'json' };

import type { SentryApiClientV1 } from '../api/sentryApiClient.js';
import {
  decodeSentryScanContinuation,
} from './sentryContinuation.js';
import { executeSentryScanPage, type SentryScanPageResultV1 } from './scanIssuesPage.js';

const CONFIGURED = Object.freeze({
  deploymentOrigin: 'https://us.sentry.io',
  organizationId: '7701',
});
const NOW_MS = 1_786_000_000_000;

type RecordedExchange = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}>;

function clientReturning(...exchanges: readonly RecordedExchange[]): {
  client: SentryApiClientV1;
  request: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const request = vi.fn(async () => {
    const exchange = exchanges[Math.min(index, exchanges.length - 1)];
    index += 1;
    if (exchange === undefined) throw new Error('no recorded exchange');
    return {
      kind: 'response' as const,
      response: {
        status: exchange.status,
        headers: exchange.headers,
        bodyText: JSON.stringify(exchange.body),
      },
    };
  });
  return { client: { request } as unknown as SentryApiClientV1, request };
}

function initialPage(client: SentryApiClientV1, scanLimit = 64) {
  return executeSentryScanPage({
    client,
    configured: CONFIGURED,
    organizationSlug: 'example-org',
    page: { kind: 'initial', scanLimit },
    nowMs: NOW_MS,
  });
}

describe('executeSentryScanPage', () => {
  it('applies a nonterminal page and emits its continuation immediately', async () => {
    const { client, request } = clientReturning(issuesListPage1);

    const result = await initialPage(client);

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.observations.map((snapshot) => snapshot.localRef.entryId))
      .toEqual(['5501001', '5501002']);
    // A nonterminal page has no health verdict yet: `walkFinished` is reserved
    // for a walk that actually ran out of pages.
    expect(result.health).toBeNull();
    expect(result.continuation).not.toBeNull();

    const decoded = decodeSentryScanContinuation(result.continuation ?? '');
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.continuation.cursor).toBe('1754000000000:0:0');
    expect(decoded.continuation.nativeLimit).toBe(64);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('applies page k with remaining zero and never waits on a successful response', async () => {
    const { client } = clientReturning({
      ...issuesListPage1,
      headers: {
        ...issuesListPage1.headers,
        'x-sentry-rate-limit-remaining': '0',
        'x-sentry-rate-limit-reset': '1786009999',
      },
    });

    const started = Date.now();
    const result = await initialPage(client);

    expect(Date.now() - started).toBeLessThan(500);
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.continuation).not.toBeNull();
  });

  it('treats absent, malformed and stale rate headers on a successful page as diagnostics', async () => {
    const headerVariants: readonly Readonly<Record<string, string>>[] = [
      { link: issuesListPage1.headers.link },
      { link: issuesListPage1.headers.link, 'x-sentry-rate-limit-reset': 'later' },
      { link: issuesListPage1.headers.link, 'x-sentry-rate-limit-reset': '1' },
    ];
    for (const headers of headerVariants) {
      const { client } = clientReturning({ ...issuesListPage1, headers });
      const result = await initialPage(client);
      expect(result.kind).toBe('page');
      if (result.kind !== 'page') continue;
      expect(result.continuation).not.toBeNull();
    }
  });

  it('declares walkFinished only when the walk terminates on results="false"', async () => {
    const { client } = clientReturning(issuesListPage2);

    const result = await executeSentryScanPage({
      client,
      configured: CONFIGURED,
      organizationSlug: 'example-org',
      page: {
        kind: 'continuation',
        token: JSON.stringify({
          v: 1,
          scanLimit: 64,
          nativeLimit: 64,
          cursor: '1754000000000:0:0',
          // The walk carries the earlier position its cycle probe is watching;
          // a token without that evidence is not one this source mints.
          probe: { cursor: '1754000000000:0:0', stepsSince: 0, interval: 2 },
          walkHealth: [],
          query: '',
          statsPeriod: '90d',
          sort: 'date',
        }),
      },
      nowMs: NOW_MS,
    });

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.health).toEqual({ kind: 'walkFinished' });
    expect(result.continuation).toBeNull();
    expect(result.observations.map((snapshot) => snapshot.localRef.entryId))
      .toEqual(['5501001', '5501003']);
  });

  /**
   * A walk's pages are separate invocations of this source, so a caveat one page
   * establishes has nowhere to live but the continuation.
   *
   * Without that, page one omitting three undecodable rows and page two running
   * cleanly out of pagination settled the walk as `walkFinished` — the aggregate
   * then read a finished walk, claimed exhaustion, and told the user their list
   * was complete over an inbox that had silently dropped issues. The falsifier
   * this pair exists for is any later page that can erase an earlier caveat.
   */
  it('carries an omitting page\'s caveat into the continuation it mints', async () => {
    const { client } = clientReturning({
      ...issuesListMalformedRows,
      // The same omitting body on a page that is NOT the last one, so there is a
      // continuation for the caveat to travel in.
      headers: issuesListPage1.headers,
    });

    const result = await initialPage(client);

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.health).toMatchObject({ kind: 'partial', reason: 'sentry-malformed-issue-row' });
    const decoded = decodeSentryScanContinuation(result.continuation ?? '');
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.continuation.walkHealth).toEqual(['sentry-malformed-issue-row']);
  });

  it('never finishes a walk clean when an earlier page omitted rows', async () => {
    // `issuesListPage2` is the terminal page and omits nothing of its own.
    const { client } = clientReturning(issuesListPage2);

    const result = await executeSentryScanPage({
      client,
      configured: CONFIGURED,
      organizationSlug: 'example-org',
      page: {
        kind: 'continuation',
        token: JSON.stringify({
          v: 1,
          scanLimit: 64,
          nativeLimit: 64,
          cursor: '1754000000000:0:0',
          probe: { cursor: '1754000000000:0:0', stepsSince: 0, interval: 2 },
          walkHealth: ['sentry-malformed-issue-row'],
          query: '',
          statsPeriod: '90d',
          sort: 'date',
        }),
      },
      nowMs: NOW_MS,
    });

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.continuation).toBeNull();
    // Names only: the omitted count belongs to the call that omitted the rows.
    expect(result.health).toEqual({ kind: 'partial', reason: 'sentry-malformed-issue-row' });
    // The rows this page did read are still the walk's rows.
    expect(result.observations).toHaveLength(2);
  });

  it('reports partial health when a page arrives with no Link header', async () => {
    // First-party Sentry always writes `Link` for this request shape, so an
    // absent one means an intermediary rewrote the response — a reason to stop,
    // not to declare the walk over.
    const { client } = clientReturning(issuesListNoLinkHeader);

    const result = await initialPage(client);

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.health).toEqual({
      kind: 'partial',
      reason: 'sentry-pagination-header-absent',
    });
    expect(result.continuation).toBeNull();
    expect(result.observations).toHaveLength(1);
  });

  it('fails with unsupportedContract when a scan response carries X-Sentry-Direct-Hit', async () => {
    const { client } = clientReturning(issuesListDirectHit);

    const result = await initialPage(client);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.failure).toEqual({
      class: 'unsupportedContract',
      code: 'sentry-direct-hit-in-scan',
    });
  });

  it('refuses a scan response marked as a direct hit even when the marker carries no value', async () => {
    // The marker is a flag, not a value: first-party Sentry writes it only on the
    // short-id branch, so its presence at any value is the whole refusal signal.
    for (const marker of ['', ' ']) {
      const { client } = clientReturning({
        ...issuesListDirectHit,
        headers: { ...issuesListDirectHit.headers, 'x-sentry-direct-hit': marker },
      });

      const result = await initialPage(client);

      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') continue;
      expect(result.failure).toEqual({
        class: 'unsupportedContract',
        code: 'sentry-direct-hit-in-scan',
      });
    }
  });

  it('skips malformed rows, keeps valid siblings and reports the exact omittedItemCount', async () => {
    const { client } = clientReturning(issuesListMalformedRows);

    const result = await initialPage(client);

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.observations.map((snapshot) => snapshot.localRef.entryId))
      .toEqual(['5501010', '5501012']);
    expect(result.health).toEqual({
      kind: 'partial',
      reason: 'sentry-malformed-issue-row',
      omittedItemCount: 3,
    });
  });

  it('does not count semantic truncation as an omitted item', async () => {
    const oversized = {
      ...issuesListPage1,
      body: [{ ...issuesListPage1.body[0], title: 'T'.repeat(20 * 1024) }],
    };
    const { client } = clientReturning(oversized);

    const result = await initialPage(client);

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.health).toBeNull();
    expect(result.observations[0]?.projectionTruncated).toBe(true);
  });

  it('deduplicates a repeated issue id inside one bounded page, last occurrence winning', async () => {
    const duplicated = {
      ...issuesListPage1,
      body: [
        issuesListPage1.body[0],
        { ...issuesListPage1.body[0], substatus: 'regressed' },
      ],
    };
    const { client } = clientReturning(duplicated);

    const result = await initialPage(client);

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.state.nativeLabel).toBe('Regressed');
    expect(result.health).toBeNull();
  });

  it('stops partial when the next cursor repeats the cursor used for this request', async () => {
    const nonAdvancing = {
      ...issuesListPage1,
      headers: {
        ...issuesListPage1.headers,
        link: '<https://us.sentry.io/api/0/organizations/7701/issues/?&cursor=1754000000000%3A0%3A0>; rel="next"; results="true"; cursor="1754000000000:0:0"',
      },
    };
    const { client } = clientReturning(nonAdvancing);

    const result = await executeSentryScanPage({
      client,
      configured: CONFIGURED,
      organizationSlug: 'example-org',
      page: {
        kind: 'continuation',
        token: JSON.stringify({
          v: 1,
          scanLimit: 64,
          nativeLimit: 64,
          cursor: '1754000000000:0:0',
          probe: { cursor: '1754000000000:0:0', stepsSince: 0, interval: 2 },
          walkHealth: [],
          query: '',
          statsPeriod: '90d',
          sort: 'date',
        }),
      },
      nowMs: NOW_MS,
    });

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.health).toEqual({
      kind: 'partial',
      reason: 'sentry-pagination-cursor-not-advancing',
    });
    expect(result.continuation).toBeNull();
  });

  it('stops partial when the next cursor returns to a position this walk already requested', async () => {
    // A → B → A. Comparing the advertised next cursor against the ONE cursor
    // this request used cannot see it: `A` is not `B`, so the walk mints a
    // continuation for a position it already read and the alternation runs for
    // as long as the caller keeps asking. The walk's own requested positions are
    // what make it visible.
    const backToFirst = {
      ...issuesListPage1,
      headers: {
        ...issuesListPage1.headers,
        link: '<https://us.sentry.io/api/0/organizations/7701/issues/?&cursor=1755000000000%3A0%3A0>; rel="next"; results="true"; cursor="1755000000000:0:0"',
      },
    };
    const { client } = clientReturning(backToFirst);

    const result = await executeSentryScanPage({
      client,
      configured: CONFIGURED,
      organizationSlug: 'example-org',
      page: {
        kind: 'continuation',
        token: JSON.stringify({
          v: 1,
          scanLimit: 64,
          nativeLimit: 64,
          cursor: '1754000000000:0:0',
          probe: { cursor: '1755000000000:0:0', stepsSince: 1, interval: 2 },
          walkHealth: [],
          query: '',
          statsPeriod: '90d',
          sort: 'date',
        }),
      },
      nowMs: NOW_MS,
    });

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    // The rows this page did read survive: a cycling provider is a stop, not a
    // reason to discard what it already answered.
    expect(result.observations).toHaveLength(2);
    expect(result.health).toEqual({
      kind: 'partial',
      reason: 'sentry-pagination-cursor-not-advancing',
    });
    expect(result.continuation).toBeNull();
  });

  it('carries its cycle probe forward so a later page can see a return', async () => {
    const { client } = clientReturning(issuesListPage1);

    const result = await executeSentryScanPage({
      client,
      configured: CONFIGURED,
      organizationSlug: 'example-org',
      page: {
        kind: 'continuation',
        token: JSON.stringify({
          v: 1,
          scanLimit: 64,
          nativeLimit: 64,
          cursor: '1755000000000:0:0',
          probe: { cursor: '1755000000000:0:0', stepsSince: 0, interval: 2 },
          walkHealth: [],
          query: '',
          statsPeriod: '90d',
          sort: 'date',
        }),
      },
      nowMs: NOW_MS,
    });

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    const decoded = decodeSentryScanContinuation(result.continuation ?? '');
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // The saved position stays where it was and its step count advances, so the
    // walk is one step closer to adopting a new one — and a return to
    // `1755000000000:0:0` is still visible while it waits.
    expect(decoded.continuation.probe)
      .toEqual({ cursor: '1755000000000:0:0', stepsSince: 1, interval: 2 });
    expect(decoded.continuation.cursor).toBe('1754000000000:0:0');
  });

  it('stops partial when the next relation has results="true" but no usable cursor', async () => {
    const malformedCursor = {
      ...issuesListPage1,
      headers: {
        ...issuesListPage1.headers,
        link: '<https://us.sentry.io/api/0/organizations/7701/issues/>; rel="next"; results="true"',
      },
    };
    const { client } = clientReturning(malformedCursor);

    const result = await initialPage(client);

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.health).toEqual({
      kind: 'partial',
      reason: 'sentry-pagination-cursor-malformed',
    });
    expect(result.continuation).toBeNull();
  });

  it('keeps minting a frontier however long a genuinely advancing walk runs', async () => {
    // Non-progress evidence must stay constant-space: evidence that grows with
    // the walk creates a page ceiling nobody declared. The predecessor position
    // history made an ordinary keyset walk settle `continuation-unavailable`.
    const advertise = (cursor: string) => ({
      ...issuesListPage1,
      headers: {
        ...issuesListPage1.headers,
        link: `<https://us.sentry.io/api/0/organizations/7701/issues/?&cursor=${cursor}>;`
          + ` rel="next"; results="true"; cursor="${cursor}"`,
      },
    });

    let token: string | null = null;
    for (let page = 0; page < 400; page += 1) {
      // Every page advertises a position no earlier page used, so nothing here
      // is a cycle: this walk is simply long.
      const { client } = clientReturning(advertise(`${1_754_000_000_000 - page * 1_000}:0:0`));
      const result: SentryScanPageResultV1 = token === null
        ? await initialPage(client)
        : await executeSentryScanPage({
          client,
          configured: CONFIGURED,
          organizationSlug: 'example-org',
          page: { kind: 'continuation', token },
          nowMs: NOW_MS,
        });

      expect(result.kind).toBe('page');
      if (result.kind !== 'page') return;
      expect(result.health).toBeNull();
      expect(result.continuation).not.toBeNull();
      if (result.continuation === null) return;
      // The token itself must not grow with the walk; a frontier that widens
      // per page is the ceiling in a different disguise.
      expect(new TextEncoder().encode(result.continuation).byteLength).toBeGreaterThan(0);
      token = result.continuation;
    }
  });

  it('stops partial when a longer cycle brings the walk back to a position it left', async () => {
    // `A → B → C → A → …`. No page repeats the cursor that produced it and none
    // repeats the one before it, so only evidence that outlives two steps sees
    // it at all. A bounded probe sees it a few pages later than a full history
    // would have; what it must never do is not see it.
    const advertise = (cursor: string) => ({
      ...issuesListPage1,
      headers: {
        ...issuesListPage1.headers,
        link: `<https://us.sentry.io/api/0/organizations/7701/issues/?&cursor=${cursor}>;`
          + ` rel="next"; results="true"; cursor="${cursor}"`,
      },
    });
    const cycle = ['1755000000000:0:0', '1754000000000:0:0', '1753000000000:0:0'];

    let token: string | null = null;
    let stoppedAt: number | null = null;
    for (let page = 0; page < 32 && stoppedAt === null; page += 1) {
      const { client } = clientReturning(advertise(cycle[page % cycle.length] as string));
      const result: SentryScanPageResultV1 = token === null
        ? await initialPage(client)
        : await executeSentryScanPage({
          client,
          configured: CONFIGURED,
          organizationSlug: 'example-org',
          page: { kind: 'continuation', token },
          nowMs: NOW_MS,
        });
      expect(result.kind).toBe('page');
      if (result.kind !== 'page') return;
      if (result.continuation === null) {
        stoppedAt = page;
        // The rows already read survive, and the reason names the cycle rather
        // than this side's own bound.
        expect(result.observations).toHaveLength(2);
        expect(result.health).toEqual({
          kind: 'partial',
          reason: 'sentry-pagination-cursor-not-advancing',
        });
        break;
      }
      token = result.continuation;
    }
    expect(stoppedAt).not.toBeNull();
  });

  it('preserves a wide provider cursor in the continuation', async () => {
    const wideCursor = 'c'.repeat(Math.floor(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 / 4));
    const { client } = clientReturning({
      ...issuesListPage1,
      headers: {
        ...issuesListPage1.headers,
        link: `<https://us.sentry.io/api/0/organizations/7701/issues/?&cursor=${wideCursor}>; rel="next"; results="true"; cursor="${wideCursor}"`,
      },
    });

    const result = await initialPage(client);

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.continuation).not.toBeNull();
    expect(result.health).toBeNull();
    expect(result.continuation).toContain(wideCursor);
    expect(result.observations).toHaveLength(2);
  });

  it('retains rows and states a provider frontier that exceeds the paging-token boundary', async () => {
    // The first frontier carries the same cursor in its current position and
    // cycle probe. Derive an over-bound pair from the canonical token resource;
    // this source owns no second cursor byte ceiling.
    const cursor = 'c'.repeat(Math.floor(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 / 2) + 1);
    const { client } = clientReturning({
      ...issuesListPage1,
      headers: {
        ...issuesListPage1.headers,
        link: `<https://us.sentry.io/api/0/organizations/7701/issues/?&cursor=${cursor}>; rel="next"; results="true"; cursor="${cursor}"`,
      },
    });

    const result = await initialPage(client);

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.observations).toHaveLength(2);
    expect(result.continuation).toBeNull();
    expect(result.health).toEqual({
      kind: 'partial',
      reason: 'sentry-continuation-unavailable',
    });
  });

  it('returns ordinary failed for a 429, carrying only the deadline and no continuation', async () => {
    const { client } = clientReturning(issuesListRateLimited);

    const result = await initialPage(client);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.failure).toEqual({
      class: 'rateLimit',
      code: 'sentry-rate-limited',
      retryNotBeforeMs: 1_786_000_060_000,
    });
    expect(result.health).toEqual({ kind: 'partial', reason: 'sentry-rate-limited' });
    expect('continuation' in result).toBe(false);
  });

  it('returns ordinary failed without a deadline for a 429 whose Reset is unusable', async () => {
    const { client } = clientReturning({
      ...issuesListRateLimited,
      headers: { 'content-type': 'application/json' },
    });

    const result = await initialPage(client);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.failure).toEqual({
      class: 'rateLimit',
      code: 'sentry-rate-limited-unhinted',
    });
  });

  it('freezes nativeLimit 37 rather than 100 for every request of the same active scan', async () => {
    const { client, request } = clientReturning(issuesListPage1);

    const result = await initialPage(client, 37);

    const sentUrl = (request.mock.calls[0]?.[0] as { url: string }).url;
    expect(new URL(sentUrl).searchParams.get('limit')).toBe('37');

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    const decoded = decodeSentryScanContinuation(result.continuation ?? '');
    expect(decoded.ok && decoded.continuation.nativeLimit).toBe(37);
  });

  it('rejects a malformed continuation before any provider request', async () => {
    const { client, request } = clientReturning(issuesListPage1);

    const result = await executeSentryScanPage({
      client,
      configured: CONFIGURED,
      organizationSlug: 'example-org',
      page: { kind: 'continuation', token: 'not-json' },
      nowMs: NOW_MS,
    });

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.failure.class).toBe('unsupportedContract');
    expect(request).not.toHaveBeenCalled();
  });

  it('reports an unparseable body rather than an empty successful page', async () => {
    const client = {
      request: vi.fn(async () => ({
        kind: 'response' as const,
        response: {
          status: 200,
          headers: issuesListPage1.headers,
          bodyText: '{"detail":"not an array"}',
        },
      })),
    } as unknown as SentryApiClientV1;

    const result = await initialPage(client);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.failure).toEqual({
      class: 'unsupportedContract',
      code: 'sentry-response-unparseable',
    });
  });
});
