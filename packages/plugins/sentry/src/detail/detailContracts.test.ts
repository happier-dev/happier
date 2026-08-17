import { describe, expect, it } from 'vitest';

import { projectSentryEventForDisplay } from '../privacy/sentryEventProjection.js';

import {
  MAX_SENTRY_DETAIL_CONTINUATION_UTF8_BYTES,
  SENTRY_DETAIL_PAGE_SIZE,
  SentryIssueEventsInputV1Schema,
  SentryIssueEventsResultV1Schema,
  SentryReadEventInputV1Schema,
  SentryReadEventResultV1Schema,
  SentryReadIssueInputV1Schema,
  SentryReadIssueResultV1Schema,
  SentryTagValuesInputV1Schema,
  decodeSentryDetailContinuation,
  encodeSentryDetailContinuation,
} from './detailContracts.js';

const INSTANCE = Object.freeze({
  v: 1,
  instance: {
    source: { pluginId: 'happier.sentry', localId: 'sentry-issues' },
    sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
  },
  binding: {
    purpose: 'sentry-account-use',
    account: {
      service: { pluginId: 'happier.sentry', localId: 'sentry-account' },
      accountId: 'acct-1',
    },
  },
  localInstanceKey: 'https://us.sentry.io42',
  configuration: { v: 1, token: 't' },
});

const LOCAL_REF = Object.freeze({
  kindId: 'error-issue',
  collisionScope: 'scope',
  entryId: '1234',
});

const INSTANCE_INPUT = Object.freeze({ v: 1, instance: INSTANCE, localRef: LOCAL_REF });

describe('Sentry detail continuation', () => {
  it('round-trips a position this source minted', () => {
    const token = encodeSentryDetailContinuation({ v: 1, cursor: '0:100:0', limit: 100 });
    expect(token).not.toBeNull();
    expect(decodeSentryDetailContinuation(token ?? '')).toEqual({
      v: 1,
      cursor: '0:100:0',
      limit: 100,
    });
  });

  it('refuses a token this source did not mint', () => {
    for (const token of [
      '{}',
      '{"v":2,"cursor":"c","limit":100}',
      '{"v":1,"cursor":"","limit":100}',
      '{"v":1,"cursor":"c","limit":0}',
      '{"v":1,"cursor":"c","limit":101}',
      'https://us.sentry.io/api/0/organizations/42/issues/1/events/?cursor=c',
      'not json',
    ]) {
      expect(decodeSentryDetailContinuation(token)).toBeNull();
    }
  });

  it('refuses to mint a position larger than the bounded token', () => {
    expect(encodeSentryDetailContinuation({
      v: 1,
      cursor: 'c'.repeat(MAX_SENTRY_DETAIL_CONTINUATION_UTF8_BYTES),
      limit: 100,
    })).toBeNull();
  });
});

describe('Sentry detail Action inputs', () => {
  it('admits exactly the three closed issue-read projections', () => {
    for (const projection of ['overview', 'tags', 'activity']) {
      expect(SentryReadIssueInputV1Schema.safeParse({
        v: 1,
        instance: INSTANCE,
        localRef: LOCAL_REF,
        projection,
      }).success).toBe(true);
    }
    for (const projection of ['events', 'raw', '']) {
      expect(SentryReadIssueInputV1Schema.safeParse({
        v: 1,
        instance: INSTANCE,
        localRef: LOCAL_REF,
        projection,
      }).success).toBe(false);
    }
  });

  it('carries the exact account path a purpose binding can address', () => {
    const schema = SentryReadIssueInputV1Schema.jsonSchema as Readonly<{
      type?: string;
      properties?: Readonly<Record<string, unknown>>;
    }>;
    // A binding walks an object input; a union-shaped input would not be
    // addressable at `instance.binding.account`.
    expect(schema.type).toBe('object');
    expect(schema.properties?.['instance']).toBeDefined();
  });

  it('refuses a page size the provider will not serve', () => {
    for (const limit of [0, SENTRY_DETAIL_PAGE_SIZE + 1, 1.5]) {
      expect(SentryIssueEventsInputV1Schema.safeParse({
        v: 1,
        instance: INSTANCE,
        localRef: LOCAL_REF,
        limit,
      }).success).toBe(false);
    }
  });

  it('requires a tag key on the values read and bounds it', () => {
    expect(SentryTagValuesInputV1Schema.safeParse({
      v: 1,
      instance: INSTANCE,
      localRef: LOCAL_REF,
      limit: 100,
    }).success).toBe(false);
    expect(SentryTagValuesInputV1Schema.safeParse({
      v: 1,
      instance: INSTANCE,
      localRef: LOCAL_REF,
      tagKey: 'sentry:user',
      limit: 100,
    }).success).toBe(true);
  });
});

describe('Sentry detail Action results', () => {
  it('accepts exactly what the boundary projector can produce', () => {
    expect(SentryIssueEventsResultV1Schema.safeParse({
      kind: 'events',
      rows: [{ eventId: 'abc', headline: 'boom', atMs: 1_760_000_000_000 }],
      omittedRowCount: 0,
      projectionTruncated: false,
    }).success).toBe(true);

    // A row carrying a field the projector never copies is a different shape,
    // not a richer one.
    expect(SentryIssueEventsResultV1Schema.safeParse({
      kind: 'events',
      rows: [{ eventId: 'abc', headline: 'boom', user: { email: 'a@b.c' } }],
      omittedRowCount: 0,
      projectionTruncated: false,
    }).success).toBe(false);
  });

  it('keeps “nothing here” and “we could not look” as different results', () => {
    expect(SentryReadIssueResultV1Schema.safeParse({
      kind: 'activity',
      activity: {
        status: 'available',
        items: [],
        malformedItemCount: 0,
        omittedItemCount: 0,
        projectionTruncated: false,
      },
    }).success).toBe(true);
    expect(SentryReadIssueResultV1Schema.safeParse({
      kind: 'unavailable',
      failure: { class: 'permission', code: 'sentry-insufficient-permission' },
    }).success).toBe(true);
  });
});

describe('Sentry selected-event contract', () => {
  it('admits both selector arms and nothing between them', () => {
    expect(SentryReadEventInputV1Schema.safeParse({
      ...INSTANCE_INPUT,
      selector: { kind: 'representative' },
    }).success).toBe(true);
    expect(SentryReadEventInputV1Schema.safeParse({
      ...INSTANCE_INPUT,
      selector: { kind: 'event', eventId: 'a'.repeat(32) },
    }).success).toBe(true);
    // A selector naming a provider alias would ask the route for a resource this
    // source never decided to address.
    expect(SentryReadEventInputV1Schema.safeParse({
      ...INSTANCE_INPUT,
      selector: { kind: 'representative', eventId: 'a'.repeat(32) },
    }).success).toBe(false);
    expect(SentryReadEventInputV1Schema.safeParse({
      ...INSTANCE_INPUT,
      selector: { kind: 'latest' },
    }).success).toBe(false);
  });

  it('parses exactly what the boundary projector produces', () => {
    // The point of the round trip: the projector is the only producer of this
    // result, so a projection it can build must always parse. A page it never
    // could is rejected here rather than becoming a second, looser statement of
    // what may leave this source.
    const projection = projectSentryEventForDisplay({
      eventID: 'a'.repeat(32),
      dateCreated: '2026-02-03T04:05:06.000Z',
      title: 'ChargeDeclined',
      message: 'card was declined',
      user: { email: 'ada@example.com', geo: { city: 'London' } },
      tags: [{ key: 'release', value: '1.4.2' }],
      entries: [
        {
          type: 'exception',
          data: {
            values: [{
              type: 'ChargeDeclined',
              value: 'card was declined',
              stacktrace: {
                frames: [{ filename: 'a.ts', function: 'f', lineNo: 1, inApp: true, vars: { a: 1 } }],
              },
            }],
          },
        },
        { type: 'breadcrumbs', data: { values: [{ category: 'fetch', message: 'POST /charge' }] } },
        { type: 'request', data: {} },
      ],
    });

    expect(SentryReadEventResultV1Schema.safeParse({ kind: 'event', projection }).success)
      .toBe(true);
  });

  it('refuses a projection that started carrying frame locals', () => {
    const projection = projectSentryEventForDisplay({ eventID: 'a'.repeat(32) });
    const leaked = {
      ...projection,
      sections: [{
        kind: 'stacktrace',
        frames: [{
          filename: null,
          function: null,
          lineNo: null,
          colNo: null,
          inApp: false,
          contextLine: null,
          vars: { card: '4111111111111111' },
        }],
      }],
    };

    expect(SentryReadEventResultV1Schema.safeParse({ kind: 'event', projection: leaked }).success)
      .toBe(false);
  });
});
