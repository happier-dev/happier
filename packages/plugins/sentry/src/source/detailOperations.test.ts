import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
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
