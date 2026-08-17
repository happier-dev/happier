import { describe, expect, it } from 'vitest';

import {
  SENTRY_DETAIL_BOUNDS_V1,
  SENTRY_MAX_ACTIVITY_ITEMS,
  SENTRY_MAX_TAG_VALUE_ROWS,
  SENTRY_MAX_EVENT_ROWS,
  projectSentryActivity,
  projectSentryEventRows,
  projectSentryIssueTags,
  projectSentryReleaseAssociation,
  projectSentryTagValueRows,
} from './detailProjection.js';

const ACTION_BYTE_GATE = 1_024 * 1_024;

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

describe('Sentry activity projection', () => {
  it('keeps the provider verb, the actor’s display name and nothing else', () => {
    const projected = projectSentryActivity([
      {
        id: '9001',
        type: 'set_resolved',
        dateCreated: '2026-01-02T03:04:05.000Z',
        user: { id: '77', name: 'Ada Lovelace', email: 'ada@example.com', username: 'ada' },
        data: { ignoreCount: 4, text: 'because it looked fine on staging' },
      },
    ], SENTRY_DETAIL_BOUNDS_V1);

    expect(projected.status).toBe('available');
    if (projected.status !== 'available') return;
    expect(projected.items).toEqual([{
      id: '9001',
      type: 'set_resolved',
      atMs: Date.parse('2026-01-02T03:04:05.000Z'),
      actor: 'Ada Lovelace',
    }]);
    // `data` carries the comment text and the change values themselves; the
    // account address and the member id are identity, not activity.
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('ada@example.com');
    expect(serialized).not.toContain('staging');
    expect(serialized).not.toContain('"77"');
  });

  it('names nobody rather than naming an account address', () => {
    const projected = projectSentryActivity([
      {
        id: '1',
        type: 'note',
        dateCreated: '2026-01-02T03:04:05.000Z',
        // A Sentry member whose profile carries no display name. An email is an
        // account identifier, not a display label, so this row names nobody —
        // the stricter reading of the §8.1 tier boundary.
        user: { id: '77', email: 'ada@example.com', username: 'ada' },
      },
    ], SENTRY_DETAIL_BOUNDS_V1);

    expect(projected.status).toBe('available');
    if (projected.status !== 'available') return;
    expect(projected.items[0]?.actor).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain('ada');
  });

  it('reports an item it could not read rather than shrinking the page silently', () => {
    const projected = projectSentryActivity([
      { id: '1', type: 'note', dateCreated: '2026-01-02T03:04:05.000Z' },
      { id: '', type: 'note' },
      'not an object',
    ], SENTRY_DETAIL_BOUNDS_V1);

    expect(projected.status).toBe('available');
    if (projected.status !== 'available') return;
    expect(projected.items).toHaveLength(1);
    expect(projected.malformedItemCount).toBe(2);
  });

  it('separates “this issue has no activity” from “activity could not be read”', () => {
    const empty = projectSentryActivity([], SENTRY_DETAIL_BOUNDS_V1);
    expect(empty).toEqual({
      status: 'available',
      items: [],
      malformedItemCount: 0,
      omittedItemCount: 0,
      projectionTruncated: false,
    });
    // An absent or non-array `activity` field is not an empty history.
    expect(projectSentryActivity(undefined, SENTRY_DETAIL_BOUNDS_V1).status).toBe('unavailable');
    expect(projectSentryActivity({ items: [] }, SENTRY_DETAIL_BOUNDS_V1).status)
      .toBe('unavailable');
  });

  it('count-bounds an oversized history and says so', () => {
    const raw = Array.from({ length: SENTRY_MAX_ACTIVITY_ITEMS + 5 }, (_unused, index) => ({
      id: String(index),
      type: 'note',
      dateCreated: '2026-01-02T03:04:05.000Z',
    }));
    const projected = projectSentryActivity(raw, SENTRY_DETAIL_BOUNDS_V1);
    expect(projected.status).toBe('available');
    if (projected.status !== 'available') return;
    expect(projected.items).toHaveLength(SENTRY_MAX_ACTIVITY_ITEMS);
    expect(projected.omittedItemCount).toBe(5);
    expect(projected.projectionTruncated).toBe(true);
  });
});

describe('Sentry event-row projection', () => {
  it('projects the rendered columns and drops the event’s own user object', () => {
    const rows = projectSentryEventRows([
      {
        eventID: 'abc123',
        id: 'abc123',
        title: 'TypeError: undefined is not a function',
        message: 'undefined is not a function',
        location: 'app/checkout/cart.ts',
        culprit: 'CartView.render',
        dateCreated: '2026-01-02T03:04:05.000Z',
        user: { id: '9', email: 'buyer@example.com', ip_address: '203.0.113.9' },
        tags: [{ key: 'url', value: 'https://shop.example.com/cart?token=secret' }],
        metadata: { value: 'undefined is not a function' },
      },
    ], SENTRY_DETAIL_BOUNDS_V1);

    expect(rows.rows).toEqual([{
      eventId: 'abc123',
      headline: 'TypeError: undefined is not a function',
      message: 'undefined is not a function',
      location: 'app/checkout/cart.ts',
      culprit: 'CartView.render',
      atMs: Date.parse('2026-01-02T03:04:05.000Z'),
    }]);
    const serialized = JSON.stringify(rows);
    // A list read never carries event user identity or per-event tags: those
    // are the highest-PII values on the response and have no list consumer.
    expect(serialized).not.toContain('buyer@example.com');
    expect(serialized).not.toContain('203.0.113.9');
    expect(serialized).not.toContain('token=secret');
  });

  it('falls back to the message when the row carried no title', () => {
    const rows = projectSentryEventRows([
      { eventID: 'abc', message: 'boom', dateCreated: '2026-01-02T03:04:05.000Z' },
    ], SENTRY_DETAIL_BOUNDS_V1);
    expect(rows.rows[0]?.headline).toBe('boom');
  });

  it('skips a row it cannot key and counts it', () => {
    const rows = projectSentryEventRows([
      { eventID: 'abc', title: 'ok' },
      { title: 'no id' },
      42,
    ], SENTRY_DETAIL_BOUNDS_V1);
    expect(rows.rows).toHaveLength(1);
    expect(rows.omittedRowCount).toBe(2);
  });
});

describe('Sentry tag projections', () => {
  it('keeps a bounded distribution and never the provider’s identity extras', () => {
    const tags = projectSentryIssueTags([
      {
        key: 'sentry:user',
        name: 'User',
        totalValues: 412,
        topValues: [
          {
            value: 'id:42',
            name: 'id:42',
            count: 400,
            lastSeen: '2026-01-02T03:04:05.000Z',
            email: 'buyer@example.com',
            username: 'buyer',
            ipAddress: '203.0.113.9',
            identifier: '42',
          },
        ],
      },
      { key: 'not a routable key', topValues: [] },
    ], SENTRY_DETAIL_BOUNDS_V1);

    expect(tags.tags).toEqual([{
      key: 'sentry:user',
      name: 'User',
      totalValues: 412,
      topValues: [{
        value: 'id:42',
        name: 'id:42',
        count: 400,
        lastSeenAtMs: Date.parse('2026-01-02T03:04:05.000Z'),
      }],
    }]);
    // A key this source cannot address as one path segment is not offered as a
    // drill-down it could never perform.
    expect(tags.omittedTagCount).toBe(1);
    const serialized = JSON.stringify(tags);
    for (const withheld of ['buyer@example.com', '"buyer"', '203.0.113.9', '"identifier"']) {
      expect(serialized).not.toContain(withheld);
    }
  });

  it('reads a tag-values page through the same allow-list', () => {
    const page = projectSentryTagValueRows([
      {
        value: 'https://shop.example.com/cart',
        name: 'https://shop.example.com/cart',
        count: 12,
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-02T00:00:00.000Z',
        email: 'buyer@example.com',
      },
      { count: 3 },
    ], SENTRY_DETAIL_BOUNDS_V1);

    expect(page.rows).toEqual([{
      value: 'https://shop.example.com/cart',
      name: 'https://shop.example.com/cart',
      count: 12,
      firstSeenAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
      lastSeenAtMs: Date.parse('2026-01-02T00:00:00.000Z'),
    }]);
    expect(page.omittedRowCount).toBe(1);
    expect(JSON.stringify(page)).not.toContain('buyer@example.com');
  });
});

describe('Sentry release association projection', () => {
  it('reads only a version that actually parses out of the untyped field', () => {
    expect(projectSentryReleaseAssociation({
      version: '1.4.2',
      dateCreated: '2026-01-02T03:04:05.000Z',
      dateReleased: null,
    }, SENTRY_DETAIL_BOUNDS_V1)).toEqual({
      version: '1.4.2',
      dateCreatedAtMs: Date.parse('2026-01-02T03:04:05.000Z'),
    });
    for (const raw of [null, undefined, {}, { version: '' }, { version: 7 }, 'v1']) {
      expect(projectSentryReleaseAssociation(raw, SENTRY_DETAIL_BOUNDS_V1)).toBeNull();
    }
  });
});

describe('Sentry detail bounds', () => {
  it('collapses provider text through the contract’s own normalizer', () => {
    const rows = projectSentryEventRows([
      { eventID: 'abc', title: 'Cart\nfailed hard' },
    ], SENTRY_DETAIL_BOUNDS_V1);
    // Collapsing is the shared owner's rule, not a Sentry-local one, and it is
    // not truncation: nothing was lost.
    expect(rows.rows[0]?.headline).toBe('Cart failed hard');
    expect(rows.rows[0]?.truncated).toBeUndefined();
  });

  it('keeps every saturated detail page inside the Action byte gate', () => {
    const long = 'x'.repeat(8_192);

    const events = projectSentryEventRows(
      Array.from({ length: SENTRY_MAX_EVENT_ROWS }, (_unused, index) => ({
        eventID: `${String(index)}${long}`,
        title: long,
        message: long,
        location: long,
        culprit: long,
        dateCreated: '2026-01-02T03:04:05.000Z',
      })),
      SENTRY_DETAIL_BOUNDS_V1,
    );
    expect(encodedBytes(events)).toBeLessThan(ACTION_BYTE_GATE);

    const tagValues = projectSentryTagValueRows(
      Array.from({ length: SENTRY_MAX_TAG_VALUE_ROWS }, () => ({
        value: long,
        name: long,
        count: Number.MAX_SAFE_INTEGER,
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-02T00:00:00.000Z',
      })),
      SENTRY_DETAIL_BOUNDS_V1,
    );
    expect(encodedBytes(tagValues)).toBeLessThan(ACTION_BYTE_GATE);

    const tags = projectSentryIssueTags(
      Array.from({ length: SENTRY_DETAIL_BOUNDS_V1.maxTagKeys + 8 }, (_unused, index) => ({
        key: `k${String(index)}${'e'.repeat(400)}`.slice(0, 200),
        name: long,
        totalValues: Number.MAX_SAFE_INTEGER,
        topValues: Array.from({ length: SENTRY_DETAIL_BOUNDS_V1.maxTopValuesPerTag + 8 }, () => ({
          value: long,
          name: long,
          count: Number.MAX_SAFE_INTEGER,
          firstSeen: '2026-01-01T00:00:00.000Z',
          lastSeen: '2026-01-02T00:00:00.000Z',
        })),
      })),
      SENTRY_DETAIL_BOUNDS_V1,
    );
    expect(encodedBytes(tags)).toBeLessThan(ACTION_BYTE_GATE);

    const activity = projectSentryActivity(
      Array.from({ length: SENTRY_MAX_ACTIVITY_ITEMS + 8 }, (_unused, index) => ({
        id: `${String(index)}${long}`,
        type: long,
        dateCreated: '2026-01-02T03:04:05.000Z',
        user: { name: long },
      })),
      SENTRY_DETAIL_BOUNDS_V1,
    );
    expect(encodedBytes(activity)).toBeLessThan(ACTION_BYTE_GATE);
  });
});
