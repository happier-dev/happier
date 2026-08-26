import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_SENTRY_DETAIL_CONTINUATION_UTF8_BYTES,
  SentryIssueEventsResultV1Schema,
  SentryReadIssueResultV1Schema,
  SentryTagValuesResultV1Schema,
} from '../detail/detailContracts.js';
import { deriveSentryCollisionScope } from '../instances/sentryCollisionScope.js';
import { encodeSentryInstanceConfiguration } from '../instances/sentryInstanceConfiguration.js';
import {
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_SCOPE_SEPARATOR,
} from '../sentryContracts.js';

import {
  SENTRY_MOUNTED_DETAIL_DEADLINE_MS,
  listSentryIssueEvents,
  listSentryTagValues,
  readSentryIssue,
} from './detailOperations.js';

const ORIGIN = 'https://de.sentry.io';
const ORGANIZATION_ID = '7701';
const ENTRY_ID = '1234';

const ACCOUNT = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.sentry', localId: 'sentry-account' }),
  accountId: 'account-1',
});

type RecordedResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}>;

function host(responses: readonly RecordedResponse[]) {
  let call = 0;
  const request = vi.fn(async (input: Readonly<{ url: string }>) => {
    const recorded = responses[call++];
    if (recorded === undefined) throw new Error(`unexpected request ${input.url}`);
    return {
      status: recorded.status,
      finalUrl: input.url,
      headers: recorded.headers,
      body: new TextEncoder().encode(JSON.stringify(recorded.body)),
    };
  });
  const materializeListedAccount = vi.fn(async () => ({
    kind: 'httpHeaders' as const,
    headers: { authorization: 'Bearer test-token-value' },
  }));
  return {
    context: {
      signal: new AbortController().signal,
      services: {
        connectedAccounts: {
          listAccounts: vi.fn(),
          materializeListedAccount,
        },
        http: { request },
      },
    } as unknown as PluginInvocationContext,
    request,
    materializeListedAccount,
  };
}

/**
 * A Sentry that accepts the request and then neither answers nor fails.
 *
 * This is the case the bound exists for: nothing is wrong enough to reject, so
 * without a deadline the panel waits until its mount is torn down. It settles
 * only when the signal it was handed aborts — including straight away for one
 * that already had, exactly as a real transport does — and rejects with that
 * signal's own reason, so the classifier can tell a deadline from a cancel.
 */
function neverAnswers(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    const fail = (): void => { reject(signal.reason as Error); };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

function silentHost() {
  const entered: (() => void)[] = [];
  const request = vi.fn(
    async (_input: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
      for (const resolve of entered.splice(0)) resolve();
      return await neverAnswers(options?.signal);
    },
  );
  const materializeListedAccount = vi.fn(async () => ({
    kind: 'httpHeaders' as const,
    headers: { authorization: 'Bearer test-token-value' },
  }));
  const caller = new AbortController();
  return {
    caller,
    request,
    materializeListedAccount,
    /** Resolves once the read is genuinely waiting on the provider. */
    async waitForRequest(): Promise<void> {
      if (request.mock.calls.length > 0) return;
      await new Promise<void>((resolve) => { entered.push(resolve); });
    },
    context: {
      signal: caller.signal,
      services: {
        connectedAccounts: { listAccounts: vi.fn(), materializeListedAccount },
        http: { request },
      },
    } as unknown as PluginInvocationContext,
  };
}

/** A host whose account materialization is what never answers. */
function silentMaterializationHost() {
  const request = vi.fn();
  const materializeListedAccount = vi.fn(
    async (_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) =>
      await neverAnswers(options?.signal),
  );
  const caller = new AbortController();
  return {
    caller,
    request,
    materializeListedAccount,
    context: {
      signal: caller.signal,
      services: {
        connectedAccounts: { listAccounts: vi.fn(), materializeListedAccount },
        http: { request },
      },
    } as unknown as PluginInvocationContext,
  };
}

function configuredInstance() {
  return {
    v: 1 as const,
    instance: {
      source: { pluginId: 'happier.sentry', localId: 'sentry-issues' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
    localInstanceKey: `${ORIGIN}${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`,
    configuration: {
      v: 1 as const,
      token: encodeSentryInstanceConfiguration({
        v: 1,
        organizationId: ORGANIZATION_ID,
        projectScope: { kind: 'allAccessible' },
        environmentScope: { kind: 'all' },
      }),
    },
  };
}

function localRef(entryId = ENTRY_ID) {
  return {
    kindId: 'error-issue' as const,
    collisionScope: deriveSentryCollisionScope({
      deploymentOrigin: ORIGIN,
      organizationId: ORGANIZATION_ID,
    }),
    entryId,
  };
}

const ISSUE_BODY = Object.freeze({
  id: ENTRY_ID,
  status: 'unresolved',
  substatus: 'escalating',
  count: '4021',
  userCount: 12,
  firstSeen: '2026-01-01T00:00:00.000Z',
  lastSeen: '2026-01-02T00:00:00.000Z',
  lastRelease: { version: '1.4.2' },
  tags: [{ key: 'browser.name', name: 'Browser', topValues: [{ value: 'Chrome', count: 9 }] }],
  activity: [{
    id: '5',
    type: 'set_regressed',
    dateCreated: '2026-01-02T00:00:00.000Z',
    user: { id: '9', name: 'Ada Lovelace', email: 'ada@example.com' },
  }],
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Sentry mounted detail deadline', () => {
  it('disposes the mounted detail deadline after a normal success', async () => {
    vi.useFakeTimers();
    const harness = host([{ status: 200, headers: {}, body: ISSUE_BODY }]);

    await expect(readSentryIssue({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      projection: 'overview',
    }, harness.context)).resolves.toMatchObject({ kind: 'overview' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops waiting on a deployment that never answers, and says so', async () => {
    vi.useFakeTimers();
    const harness = silentHost();
    const pending = readSentryIssue({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      projection: 'overview',
    }, harness.context);

    // Nothing has settled: this is the outcome the reader cannot retry, report,
    // or tell apart from a very slow provider.
    await vi.advanceTimersByTimeAsync(SENTRY_MOUNTED_DETAIL_DEADLINE_MS - 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;
    expect(result).toMatchObject({
      kind: 'unavailable',
      // Nobody cancelled this read, and a reader told "cancelled" has no reason
      // to try again.
      failure: { class: 'transient', code: 'sentry-deadline-elapsed' },
    });
    // The bound is this source's own: the caller's signal is untouched.
    expect(harness.caller.signal.aborted).toBe(false);
  });

  it('bounds the account materialization too, not only the fetch after it', async () => {
    vi.useFakeTimers();
    const harness = silentMaterializationHost();
    const pending = listSentryIssueEvents({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      limit: 100,
    }, harness.context);

    await vi.advanceTimersByTimeAsync(SENTRY_MOUNTED_DETAIL_DEADLINE_MS + 1);
    // A connection that hangs while the credential is being materialized
    // strands the panel exactly as a hanging read does.
    expect(await pending).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'sentry-deadline-elapsed' },
    });
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('still calls a caller cancellation what it is', async () => {
    const harness = silentHost();
    const pending = listSentryTagValues({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      tagKey: 'browser.name',
      limit: 100,
    }, harness.context);
    await harness.waitForRequest();
    harness.caller.abort();

    // The bound adds a second way to stop; it must not rename the first one.
    expect(await pending).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'sentry-cancelled' },
    });
  });
});

describe('Sentry detail operations', () => {
  it('reads each closed projection of the one public issue request', async () => {
    for (const projection of ['overview', 'tags', 'activity'] as const) {
      const harness = host([{ status: 200, headers: {}, body: ISSUE_BODY }]);
      const result = await readSentryIssue({
        v: 1,
        instance: configuredInstance(),
        localRef: localRef(),
        projection,
      }, harness.context);

      expect(() => SentryReadIssueResultV1Schema.parse(result)).not.toThrow();
      expect(result.kind).toBe(projection);
      expect(String(harness.request.mock.calls[0]?.[0]?.url))
        .toBe(`${ORIGIN}/api/0/organizations/7701/issues/1234/`);
    }
  });

  it('never lets a member’s account address leave the source', async () => {
    const harness = host([{ status: 200, headers: {}, body: ISSUE_BODY }]);
    const result = await readSentryIssue({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      projection: 'activity',
    }, harness.context);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('Ada Lovelace');
    expect(serialized).not.toContain('ada@example.com');
  });

  it('separates an empty history from a history it could not read', async () => {
    const empty = host([{ status: 200, headers: {}, body: { ...ISSUE_BODY, activity: [] } }]);
    const emptyResult = await readSentryIssue({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      projection: 'activity',
    }, empty.context);
    expect(emptyResult).toMatchObject({
      kind: 'activity',
      activity: { status: 'available', items: [] },
    });

    const broken = host([{
      status: 200,
      headers: {},
      body: { ...ISSUE_BODY, activity: { note: 'not a list' } },
    }]);
    const brokenResult = await readSentryIssue({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      projection: 'activity',
    }, broken.context);
    expect(brokenResult).toMatchObject({ kind: 'activity', activity: { status: 'unavailable' } });

    const refused = host([{ status: 403, headers: {}, body: { detail: 'no' } }]);
    const refusedResult = await readSentryIssue({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      projection: 'activity',
    }, refused.context);
    // A refusal names itself; it is neither an empty history nor a broken one.
    expect(refusedResult).toMatchObject({ kind: 'unavailable', failure: { class: 'permission' } });
  });

  it('walks the events collection through a continuation it minted itself', async () => {
    const first = host([{
      status: 200,
      headers: {
        Link: '<https://de.sentry.io/api/0/organizations/7701/issues/1234/events/?cursor=0:100:0>;'
          + ' rel="next"; results="true"; cursor="0:100:0"',
      },
      body: [{ eventID: 'e1', title: 'boom', dateCreated: '2026-01-02T00:00:00.000Z' }],
    }]);
    const page1 = await listSentryIssueEvents({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      limit: 100,
    }, first.context);

    expect(() => SentryIssueEventsResultV1Schema.parse(page1)).not.toThrow();
    expect(page1.kind).toBe('events');
    if (page1.kind !== 'events') return;
    expect(page1.continuation).toBeDefined();
    // The provider's own absolute URL never crosses the Action boundary.
    expect(String(page1.continuation)).not.toContain('https://');

    const second = host([{ status: 200, headers: {}, body: [] }]);
    const page2 = await listSentryIssueEvents({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      limit: 100,
      continuation: page1.continuation,
    }, second.context);
    expect(new URL(String(second.request.mock.calls[0]?.[0]?.url)).searchParams.get('cursor'))
      .toBe('0:100:0');
    expect(page2).toMatchObject({ kind: 'events', rows: [] });
  });

  it('stops a walk whose provider alternates between two pages', async () => {
    const eventsLink = (cursor: string): string =>
      `<https://de.sentry.io/api/0/organizations/7701/issues/1234/events/?cursor=${cursor}>;`
      + ` rel="next"; results="true"; cursor="${cursor}"`;
    const row = (id: string) => ({
      eventID: id,
      title: 'boom',
      dateCreated: '2026-01-02T00:00:00.000Z',
    });

    // Page one advertises A, page two advertises B, page three advertises A
    // again. Every advertised cursor differs from the one that request used, so
    // a walk that keeps only its current position never stops.
    const request = async (
      cursor: string | undefined,
      advertise: string,
      eventId: string,
    ): Promise<ReturnType<typeof host>> => host([{
      status: 200,
      headers: { Link: eventsLink(advertise) },
      body: [row(eventId)],
    }]);

    const first = await request(undefined, 'A', 'e1');
    const page1 = await listSentryIssueEvents({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      limit: 100,
    }, first.context);
    expect(page1.kind).toBe('events');
    if (page1.kind !== 'events') return;
    expect(page1.continuation).toBeDefined();

    const second = await request('A', 'B', 'e2');
    const page2 = await listSentryIssueEvents({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      limit: 100,
      continuation: page1.continuation,
    }, second.context);
    expect(page2.kind).toBe('events');
    if (page2.kind !== 'events') return;
    expect(page2.continuation).toBeDefined();

    const third = await request('B', 'A', 'e3');
    const page3 = await listSentryIssueEvents({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      limit: 100,
      continuation: page2.continuation,
    }, third.context);

    expect(() => SentryIssueEventsResultV1Schema.parse(page3)).not.toThrow();
    expect(page3).toMatchObject({
      kind: 'events',
      // The rows this page did read survive; a cycling provider is a stop, not
      // a reason to discard what it answered.
      rows: [{ eventId: 'e3' }],
      incomplete: 'paginationCursorNotAdvancing',
    });
    if (page3.kind !== 'events') return;
    // No continuation means the panel stops offering another page, and the
    // stopped-short reason is what keeps it from reading as a finished list.
    expect(page3.continuation).toBeUndefined();
  });

  it('keeps offering another page however many the reader has already loaded', async () => {
    // The panel's non-progress evidence rides inside a BOUNDED token, so
    // evidence that grows per page is an undeclared "Load more" ceiling. With
    // Sentry's own keyset cursors the predecessor position history stopped
    // fitting at the 23rd page — roughly 2,200 occurrences — and the panel
    // settled `continuationUnavailable`, which no reader can get past.
    let continuation: string | undefined;
    for (let page = 0; page < 80; page += 1) {
      const cursor = `${1_754_000_000_000 - page * 1_000}:0:0`;
      const harness = host([{
        status: 200,
        headers: {
          Link: `<https://de.sentry.io/api/0/organizations/7701/issues/1234/events/?cursor=${cursor}>;`
            + ` rel="next"; results="true"; cursor="${cursor}"`,
        },
        body: [{ eventID: `e${page}`, title: 'boom', dateCreated: '2026-01-02T00:00:00.000Z' }],
      }]);

      const result = await listSentryIssueEvents({
        v: 1,
        instance: configuredInstance(),
        localRef: localRef(),
        limit: 100,
        ...(continuation === undefined ? {} : { continuation }),
      }, harness.context);

      expect(() => SentryIssueEventsResultV1Schema.parse(result)).not.toThrow();
      expect(result).toMatchObject({ kind: 'events' });
      if (result.kind !== 'events') return;
      // Never a stopped-short claim, and never a walk the reader cannot resume.
      expect(result.incomplete).toBeUndefined();
      expect(result.continuation).toBeDefined();
      if (result.continuation === undefined) return;
      expect(new TextEncoder().encode(result.continuation).byteLength)
        .toBeLessThan(MAX_SENTRY_DETAIL_CONTINUATION_UTF8_BYTES / 2);
      continuation = result.continuation;
    }
  });

  it('blames its own bound, not the provider, when the frontier will not fit', async () => {
    // The provider's cursor is intact and the walk is open; it simply does not
    // fit the bounded token this side owns. Reporting that as a malformed
    // cursor would accuse Sentry of something it did not do.
    const cursor = 'c'.repeat(MAX_SENTRY_DETAIL_CONTINUATION_UTF8_BYTES);
    const harness = host([{
      status: 200,
      headers: {
        Link: `<https://de.sentry.io/api/0/organizations/7701/issues/1234/events/?cursor=${cursor}>;`
          + ` rel="next"; results="true"; cursor="${cursor}"`,
      },
      body: [{ eventID: 'e1', title: 'boom', dateCreated: '2026-01-02T00:00:00.000Z' }],
    }]);

    const page = await listSentryIssueEvents({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      limit: 100,
    }, harness.context);

    expect(() => SentryIssueEventsResultV1Schema.parse(page)).not.toThrow();
    expect(page).toMatchObject({
      kind: 'events',
      rows: [{ eventId: 'e1' }],
      incomplete: 'continuationUnavailable',
    });
    if (page.kind !== 'events') return;
    // Never an over-bound token that would discard the page it belongs to.
    expect(page.continuation).toBeUndefined();
  });

  it('refuses a continuation it did not mint rather than requesting it', async () => {
    const harness = host([]);
    const result = await listSentryIssueEvents({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      limit: 100,
      continuation: 'https://evil.example.com/api/0/organizations/7701/issues/1/events/',
    }, harness.context);
    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'sentry-pagination-cursor-malformed' },
    });
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('reads one tag key’s distribution without its identity extras', async () => {
    const harness = host([{
      status: 200,
      headers: {},
      body: [{
        value: 'id:42',
        count: 400,
        lastSeen: '2026-01-02T00:00:00.000Z',
        email: 'buyer@example.com',
        ipAddress: '203.0.113.9',
      }],
    }]);
    const result = await listSentryTagValues({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      tagKey: 'sentry:user',
      limit: 100,
    }, harness.context);

    expect(() => SentryTagValuesResultV1Schema.parse(result)).not.toThrow();
    expect(result).toMatchObject({ kind: 'tagValues', tagKey: 'sentry:user' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('buyer@example.com');
    expect(serialized).not.toContain('203.0.113.9');
  });

  it('refuses a ref that does not belong to the invoked instance', async () => {
    const harness = host([]);
    const result = await readSentryIssue({
      v: 1,
      instance: configuredInstance(),
      localRef: { ...localRef(), collisionScope: 'someone-elses-scope' },
      projection: 'overview',
    }, harness.context);
    expect(result).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'sentry-invoked-organization-mismatch' },
    });
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('materializes only the exact bound account for a detail read', async () => {
    const harness = host([{ status: 200, headers: {}, body: ISSUE_BODY }]);
    await readSentryIssue({
      v: 1,
      instance: configuredInstance(),
      localRef: localRef(),
      projection: 'overview',
    }, harness.context);
    expect(harness.materializeListedAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
        account: ACCOUNT,
        materialization: expect.objectContaining({ origin: ORIGIN }),
      }),
      expect.anything(),
    );
  });
});
