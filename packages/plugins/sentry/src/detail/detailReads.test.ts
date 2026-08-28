import { describe, expect, it, vi } from 'vitest';

import type { SentryApiClientV1, SentryApiOutcomeV1 } from '../api/sentryApiClient.js';
import type { SentryInvokedInstanceV1 } from '../instances/sentryCollisionScope.js';

import {
  readSentryEventProjection,
  readSentryIssueEventsPage,
  readSentryIssueProjection,
  readSentryTagValuesPage,
} from './detailReads.js';

const INSTANCE: SentryInvokedInstanceV1 = Object.freeze({
  deploymentOrigin: 'https://us.sentry.io',
  organizationId: '42',
});

const EVENTS_PATH = '/api/0/organizations/42/issues/1234/events/';

/**
 * A walk one step past `0:0:0`: the probe still watches it while its wait runs
 * down, which is what makes the `A → B → A` return below visible at all.
 */
const PROBE_AT_FIRST = Object.freeze({ cursor: '0:0:0', stepsSince: 1, interval: 2 });

function respond(
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  status = 200,
): SentryApiOutcomeV1 {
  return {
    kind: 'response',
    response: { status, headers, bodyText: JSON.stringify(body) },
  };
}

function client(...outcomes: readonly SentryApiOutcomeV1[]): Readonly<{
  client: SentryApiClientV1;
  request: ReturnType<typeof vi.fn>;
}> {
  const queue = [...outcomes];
  const request = vi.fn(async () => queue.shift() ?? respond({}));
  return { client: { request } as unknown as SentryApiClientV1, request };
}

function nextLink(cursor: string, results = 'true', path = EVENTS_PATH): string {
  return `<https://us.sentry.io${path}?cursor=${cursor}>; rel="next"; results="${results}"; cursor="${cursor}"`;
}

describe('Sentry issue projections', () => {
  it('reads the three projections from the one public issue request', async () => {
    const body = {
      id: '1234',
      status: 'unresolved',
      substatus: 'escalating',
      count: '4021',
      userCount: 12,
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-02T00:00:00.000Z',
      firstRelease: { version: '1.0.0' },
      lastRelease: { version: '1.4.2', dateCreated: '2026-01-02T00:00:00.000Z' },
      tags: [{ key: 'browser.name', topValues: [{ value: 'Chrome', count: 9 }] }],
      activity: [{ id: '5', type: 'set_regressed', dateCreated: '2026-01-02T00:00:00.000Z' }],
    };

    for (const projection of ['overview', 'tags', 'activity'] as const) {
      const harness = client(respond(body));
      const result = await readSentryIssueProjection(harness.client, {
        instance: INSTANCE,
        entryId: '1234',
        projection,
        nowMs: 0,
      });
      expect(harness.request.mock.calls[0]?.[0]).toEqual({
        url: 'https://us.sentry.io/api/0/organizations/42/issues/1234/',
        operation: 'issue',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.kind).toBe(projection);
    }
  });

  it('keeps the overview arm free of every Tier-B collection', async () => {
    const harness = client(respond({
      id: '1234',
      status: 'unresolved',
      count: '9',
      tags: [{ key: 'sentry:user', topValues: [{ value: 'id:1', email: 'a@b.c' }] }],
      activity: [{ id: '5', type: 'note', user: { name: 'Ada' } }],
      participants: [{ email: 'watcher@example.com' }],
      seenBy: [{ email: 'seen@example.com' }],
    }));
    const result = await readSentryIssueProjection(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      projection: 'overview',
      nowMs: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.value);
    for (const withheld of ['a@b.c', 'Ada', 'watcher@example.com', 'seen@example.com']) {
      expect(serialized).not.toContain(withheld);
    }
  });

  it('reports an unreadable body rather than an empty projection', async () => {
    const harness = client({
      kind: 'response',
      response: { status: 200, headers: {}, bodyText: 'not json' },
    });
    const result = await readSentryIssueProjection(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      projection: 'activity',
      nowMs: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('sentry-response-unparseable');
  });

  it('classifies a permission refusal as its own visible outcome', async () => {
    const harness = client(respond({ detail: 'no' }, {}, 403));
    const result = await readSentryIssueProjection(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      projection: 'tags',
      nowMs: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.class).toBe('permission');
  });
});

describe('Sentry issue events page', () => {
  it('reads one bounded page and verifies the provider’s own next cursor', async () => {
    const harness = client(respond(
      [{ eventID: 'e1', title: 'boom', dateCreated: '2026-01-02T00:00:00.000Z' }],
      { Link: nextLink('0:100:0') },
    ));
    const result = await readSentryIssueEventsPage(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      limit: 100,
      position: null,
      nowMs: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toHaveLength(1);
    expect(result.value.nextPage).toMatchObject({ kind: 'next', walk: { cursor: '0:100:0' } });
  });

  it('reports an ABSENT Link header as a walk that stopped short, not as a finished one', async () => {
    // The failure this restores: an absent header, a malformed cursor and a
    // non-advancing cursor all used to collapse into "no next cursor", so a
    // truncated occurrence list rendered exactly like a complete one while the
    // scan plane kept the honest vocabulary for the same three situations.
    const harness = client(respond(
      [{ eventID: 'e1', title: 'boom', dateCreated: '2026-01-02T00:00:00.000Z' }],
      {},
    ));
    const result = await readSentryIssueEventsPage(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      limit: 100,
      position: null,
      nowMs: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextPage).toEqual({
      kind: 'stoppedShort',
      reason: 'paginationHeaderAbsent',
    });
    // The rows it did read survive: stopping short is not a failure.
    expect(result.value.rows).toHaveLength(1);
  });

  it('does not follow a next link that leaves this exact route', async () => {
    const harness = client(respond([], {
      Link: nextLink('0:100:0', 'true', '/api/0/organizations/42/issues/9999/events/'),
    }));
    const result = await readSentryIssueEventsPage(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      limit: 100,
      position: null,
      nowMs: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A next link pointing somewhere else is a page this build will not follow — which
    // is a walk that stopped SHORT, not a collection that ended.
    expect(result.value.nextPage).toEqual({
      kind: 'stoppedShort',
      reason: 'paginationCursorMalformed',
    });
  });

  it('ends the walk when the provider says the next page has no results', async () => {
    const harness = client(respond([], { Link: nextLink('0:100:0', 'false') }));
    const result = await readSentryIssueEventsPage(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      limit: 100,
      position: null,
      nowMs: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The provider itself stated the collection ended: this is `end`, and it must stay
    // distinguishable from a walk that stopped short.
    expect(result.value.nextPage).toEqual({ kind: 'end' });
    // A provider-stated empty page is a real page, not a failure.
    expect(result.value.rows).toEqual([]);
  });

  it('stops short when the next cursor names a position this walk already requested', async () => {
    // `A → B → A`. A comparison that can only see the cursor THIS request used
    // never sees it: `A` is not `B`, so the panel keeps being offered another
    // page and the walk never ends. The saved position the probe still watches
    // is what makes the alternation visible.
    const harness = client(respond(
      [{ eventID: 'e3', title: 'boom', dateCreated: '2026-01-02T00:00:00.000Z' }],
      { Link: nextLink('0:0:0') },
    ));
    const result = await readSentryIssueEventsPage(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      limit: 100,
      position: { cursor: '0:100:0', probe: PROBE_AT_FIRST },
      nowMs: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextPage).toEqual({
      kind: 'stoppedShort',
      reason: 'paginationCursorNotAdvancing',
    });
    // A cycling provider is a stop, not a reason to discard what it answered.
    expect(result.value.rows).toHaveLength(1);
  });

  it('still catches the one-step repeat against the position that produced the page', async () => {
    const harness = client(respond([], { Link: nextLink('0:100:0') }));
    const result = await readSentryIssueEventsPage(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      limit: 100,
      position: { cursor: '0:100:0', probe: { cursor: '0:100:0', stepsSince: 0, interval: 2 } },
      nowMs: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextPage).toEqual({
      kind: 'stoppedShort',
      reason: 'paginationCursorNotAdvancing',
    });
  });

  it('follows a cursor this walk has not requested before', async () => {
    // The guard must not stop a walk that is genuinely advancing: a new position
    // that is neither the one this page came from nor the one being watched is a
    // page to read, not a cycle.
    const harness = client(respond([], { Link: nextLink('0:200:0') }));
    const result = await readSentryIssueEventsPage(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      limit: 100,
      position: { cursor: '0:100:0', probe: PROBE_AT_FIRST },
      nowMs: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextPage).toMatchObject({ kind: 'next', walk: { cursor: '0:200:0' } });
  });

  it('sends the cursor it was given and never a provider URL', async () => {
    const harness = client(respond([], {}));
    await readSentryIssueEventsPage(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      limit: 50,
      position: { cursor: '100:1:0', probe: { cursor: '100:1:0', stepsSince: 0, interval: 2 } },
      nowMs: 0,
    });
    const url = new URL(String(harness.request.mock.calls[0]?.[0]?.url));
    expect(url.pathname).toBe(EVENTS_PATH);
    expect(url.searchParams.get('cursor')).toBe('100:1:0');
    expect(url.searchParams.get('per_page')).toBe('50');
  });

  it('rejects a request this source cannot address at all', async () => {
    const harness = client(respond([], {}));
    const result = await readSentryIssueEventsPage(harness.client, {
      instance: INSTANCE,
      entryId: 'not-numeric',
      limit: 100,
      position: null,
      nowMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(harness.request).not.toHaveBeenCalled();
  });
});

describe('Sentry tag values page', () => {
  it('reads one bounded page of a single tag key', async () => {
    const harness = client(respond(
      [{ value: 'Chrome', count: 12, lastSeen: '2026-01-02T00:00:00.000Z' }],
      {
        Link: nextLink(
          '0:100:0',
          'true',
          '/api/0/organizations/42/issues/1234/tags/browser.name/values/',
        ),
      },
    ));
    const result = await readSentryTagValuesPage(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      tagKey: 'browser.name',
      limit: 100,
      position: null,
      nowMs: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows[0]?.value).toBe('Chrome');
    expect(result.value.nextPage).toMatchObject({ kind: 'next', walk: { cursor: '0:100:0' } });
  });

  it('refuses a tag key it could not address as one path segment', async () => {
    const harness = client(respond([], {}));
    const result = await readSentryTagValuesPage(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      tagKey: '../../projects',
      limit: 100,
      position: null,
      nowMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(harness.request).not.toHaveBeenCalled();
  });
});

describe('Sentry selected-event read', () => {
  it('asks for the representative occurrence and never for an LLM rendering', async () => {
    const harness = client(respond({
      eventID: 'b'.repeat(32),
      title: 'ChargeDeclined',
      entries: [{
        type: 'exception',
        data: {
          values: [{
            type: 'ChargeDeclined',
            value: 'card was declined',
            stacktrace: { frames: [{ filename: 'app/checkout.ts', inApp: true, lineNo: 7 }] },
          }],
        },
      }],
    }));

    const result = await readSentryEventProjection(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      selector: { kind: 'representative' },
      nowMs: 0,
    });

    expect(harness.request.mock.calls[0]?.[0]).toEqual({
      url: 'https://us.sentry.io/api/0/organizations/42/issues/1234/events/recommended/',
      operation: 'event',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.eventId).toBe('b'.repeat(32));
    expect(result.value.sections[0]?.kind).toBe('exception');
  });

  it('addresses the exact selected occurrence', async () => {
    const harness = client(respond({ eventID: 'c'.repeat(32) }));
    await readSentryEventProjection(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      selector: { kind: 'event', eventId: 'c'.repeat(32) },
      nowMs: 0,
    });
    expect(harness.request.mock.calls[0]?.[0]).toEqual({
      url: `https://us.sentry.io/api/0/organizations/42/issues/1234/events/${'c'.repeat(32)}/`,
      operation: 'event',
    });
  });

  it('refuses a valid body whose id is not the exact selected occurrence', async () => {
    const selectedEventId = 'c'.repeat(32);
    const harness = client(respond({ eventID: 'd'.repeat(32), title: 'another event' }));
    const result = await readSentryEventProjection(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      selector: { kind: 'event', eventId: selectedEventId },
      nowMs: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.class).toBe('unsupportedContract');
  });

  it('never lets a raw event body leave this call frame', async () => {
    const harness = client(respond({
      eventID: 'd'.repeat(32),
      user: { email: 'ada@example.com', geo: { city: 'London' } },
      contexts: { device: { name: 'Ada’s laptop' } },
      entries: [{
        type: 'request',
        data: { headers: [['cookie', 'session=notatoken']] },
      }],
    }));

    const result = await readSentryEventProjection(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      selector: { kind: 'representative' },
      nowMs: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const encoded = JSON.stringify(result.value);
    expect(encoded).not.toContain('session=notatoken');
    expect(encoded).not.toContain('London');
    expect(encoded).not.toContain('Ada’s laptop');
  });

  it('refuses an event id it could not address, without sending a request', async () => {
    const harness = client(respond({}));
    const result = await readSentryEventProjection(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      selector: { kind: 'event', eventId: '../../organizations' },
      nowMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(harness.request).not.toHaveBeenCalled();
  });

  /**
   * The events LIST already refuses a body that is not the array it declares. The
   * single-event read did not: it handed any body to the projector, which answered an
   * empty projection for one it could not read at all, and `ok: true` published that as
   * a real occurrence with no id, no message and no frames. Nothing downstream can tell
   * that apart from an event Sentry genuinely recorded as empty, so the reader is shown
   * a blank Stack Trace instead of a stated failure — and §8.4a's exact-dispatch reread
   * has no id to reread.
   */
  it.each([
    ['a body that is not an object at all', 'not an event'],
    ['a body that is an array', [{ eventID: 'e'.repeat(32) }]],
    ['an object carrying no event id', { title: 'ChargeDeclined' }],
    ['an object whose event id is empty', { eventID: '', title: 'ChargeDeclined' }],
  ])('settles %s as an unreadable response, never as an empty occurrence', async (_label, body) => {
    const harness = client(respond(body));
    const result = await readSentryEventProjection(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      selector: { kind: 'representative' },
      nowMs: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.class).toBe('unsupportedContract');
  });

  it('reports a refused read as a failure rather than an event with no trace', async () => {
    const harness = client(respond({ detail: 'nope' }, {}, 403));
    const result = await readSentryEventProjection(harness.client, {
      instance: INSTANCE,
      entryId: '1234',
      selector: { kind: 'representative' },
      nowMs: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.class).toBe('permission');
  });
});
