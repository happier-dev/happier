/**
 * The Sentry detail boundary projector (`SENTRY.md` §8.1, §8.3).
 *
 * Everything a Sentry detail read may hand to a controller, a panel, or a
 * published Action result is built here and nowhere else. It runs immediately
 * after the raw body is decoded and before any state exists, which is what makes
 * it a boundary rather than a filter: a value that is not copied here cannot be
 * reached later by a panel that decides it wants it.
 *
 * It is an **allow-list**, not a redaction pass, and the difference is the whole
 * point on this source. Events, tags and activity are the highest-PII surfaces
 * in the product:
 *
 * - an event row's `user` object is `{id, email, username, ip_address, name,
 *   geo, data}` and its `tags` routinely carry `url` values with query strings —
 *   §8.1 Tier C. A list read renders `dateCreated`, `location` and `message`, so
 *   those are the fields copied and the rest is never read;
 * - a tag-value row additionally carries `email`, `username`, `ipAddress` and
 *   `identifier` for `sentry:user`. Those are account identity rather than the
 *   distribution the section renders, so they are dropped here;
 * - an activity item's `data` bag carries the change values and note text
 *   themselves. A reader is told *what happened*, never what it changed to.
 *
 * Where a tier boundary was genuinely ambiguous this module takes the stricter
 * reading. The activity actor's member `id` is the one such case: `SENTRY.md`
 * §4.3 sketches it on the DTO, no surface renders it, and it is a Sentry account
 * identifier — so only the display name is projected.
 *
 * Every text value goes through the published single-line normalizer, so the
 * collapse-then-bound rule has exactly one owner across the whole product.
 */

import {
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
  type TriageBoundedTextV1,
} from '@happier-dev/triage-protocol/v1';

import { SENTRY_MAX_DETAIL_PAGE_SIZE, isSentryRoutableTagKey } from '../api/sentryRoutes.js';
import { SENTRY_MAX_IDENTIFIER_UTF8_BYTES } from '../sentryContracts.js';

/** The published bounds one detail projection is measured against. */
export type SentryDetailBoundsV1 = Readonly<{
  identifierUtf8Bytes: number;
  textUtf8Bytes: number;
  labelUtf8Bytes: number;
  maxTagKeys: number;
  maxTopValuesPerTag: number;
}>;

/**
 * The bounds a published Sentry detail projection uses.
 *
 * They are derived from the one hard constraint that exists — the Action
 * aggregate's byte gate against a fully saturated page — rather than from a
 * guess about how long a real title, tag value or member name is.
 * `detailProjection.test.ts` saturates every one of them at once, at each
 * collection's ceiling below, and measures the encoded result against that gate.
 */
export const SENTRY_DETAIL_BOUNDS_V1: SentryDetailBoundsV1 = Object.freeze({
  identifierUtf8Bytes: SENTRY_MAX_IDENTIFIER_UTF8_BYTES,
  textUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  labelUtf8Bytes: 128,
  maxTagKeys: 32,
  maxTopValuesPerTag: 8,
});

/** One provider page of retained events; `[SCHEMA]` the endpoint caps it at 100. */
export const SENTRY_MAX_EVENT_ROWS = SENTRY_MAX_DETAIL_PAGE_SIZE;
/** One provider page of tag values; `[SCHEMA]` the endpoint caps it at 100. */
export const SENTRY_MAX_TAG_VALUE_ROWS = SENTRY_MAX_DETAIL_PAGE_SIZE;
/**
 * The activity history one issue response may contribute.
 *
 * The public issue response embeds `activity` inline and states no page size, so
 * this ceiling is the source's own: the largest history whose fully saturated
 * projection still clears the Action byte gate.
 */
export const SENTRY_MAX_ACTIVITY_ITEMS = 100;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readTimestampMs(value: unknown): number | null {
  const raw = readString(value);
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Provider text becomes one bounded, single-line display value.
 *
 * The normalize-then-bound rule belongs to `@happier-dev/triage-protocol`; a
 * Sentry title, tag value or member name is exactly as capable of carrying a
 * newline as any other provider string, and restating the rule here would be a
 * second decision-maker for it.
 */
function bounded(value: string, maxUtf8Bytes: number): TriageBoundedTextV1 {
  return projectTriageDisplayTextV1(value, maxUtf8Bytes);
}

/* ------------------------------------------------------------------ activity */

/**
 * One activity item, reduced to what a reader needs: what happened, who did it,
 * and when.
 */
export type SentryProjectedActivityItemV1 = Readonly<{
  id: string;
  /** The provider's own activity type, for example `set_resolved`. */
  type: string;
  atMs?: number;
  /** The acting member's display name; absent when the item named nobody. */
  actor?: string;
  truncated?: true;
}>;

export type SentryActivityProjectionV1 =
  | Readonly<{
    status: 'available';
    items: readonly SentryProjectedActivityItemV1[];
    /** Items the response carried that could not be read at all. */
    malformedItemCount: number;
    /** Readable items dropped because the history exceeded this source's ceiling. */
    omittedItemCount: number;
    projectionTruncated: boolean;
  }>
  | Readonly<{ status: 'unavailable' }>;

const ACTIVITY_UNAVAILABLE: SentryActivityProjectionV1 = Object.freeze({
  status: 'unavailable' as const,
});

/**
 * Derives the acting member's display label.
 *
 * A name is what a triage reader recognizes. The account address is deliberately
 * **not** a fallback here — unlike a forge, a Sentry activity row is Tier B
 * content whose actor may be any organization member, and naming nobody is
 * better than naming an email address.
 */
function projectActivityActor(
  value: unknown,
  bounds: SentryDetailBoundsV1,
): TriageBoundedTextV1 | null {
  if (!isRecord(value)) return null;
  const name = readString(value['name']);
  return name === null ? null : bounded(name, bounds.labelUtf8Bytes);
}

export function projectSentryActivity(
  raw: unknown,
  bounds: SentryDetailBoundsV1,
): SentryActivityProjectionV1 {
  // An absent or non-array `activity` field is a response this source could not
  // read, never an issue with no history. The two render differently.
  if (!Array.isArray(raw)) return ACTIVITY_UNAVAILABLE;

  const items: SentryProjectedActivityItemV1[] = [];
  let malformedItemCount = 0;
  let omittedItemCount = 0;
  let projectionTruncated = false;

  for (const entry of raw) {
    if (!isRecord(entry)) {
      malformedItemCount += 1;
      continue;
    }
    const rawId = readString(entry['id']);
    const rawType = readString(entry['type']);
    if (rawId === null || rawType === null) {
      malformedItemCount += 1;
      continue;
    }
    if (items.length >= SENTRY_MAX_ACTIVITY_ITEMS) {
      omittedItemCount += 1;
      projectionTruncated = true;
      continue;
    }
    const id = bounded(rawId, bounds.identifierUtf8Bytes);
    const type = bounded(rawType, bounds.labelUtf8Bytes);
    const atMs = readTimestampMs(entry['dateCreated']);
    const actor = projectActivityActor(entry['user'], bounds);
    const truncated = id.truncated || type.truncated || (actor?.truncated ?? false);
    projectionTruncated = projectionTruncated || truncated;
    items.push(Object.freeze({
      id: id.value,
      type: type.value,
      ...(atMs === null ? {} : { atMs }),
      ...(actor === null || actor.value.length === 0 ? {} : { actor: actor.value }),
      ...(truncated ? { truncated: true as const } : {}),
    }));
  }

  return Object.freeze({
    status: 'available' as const,
    items: Object.freeze(items),
    malformedItemCount,
    omittedItemCount,
    projectionTruncated,
  });
}

/* -------------------------------------------------------------- event rows */

/** One retained-event row, reduced to the three columns §7.4 renders. */
export type SentryProjectedEventRowV1 = Readonly<{
  eventId: string;
  /** The row's own headline: its title, or its message when it carried none. */
  headline: string;
  message?: string;
  location?: string;
  culprit?: string;
  atMs?: number;
  truncated?: true;
}>;

export type SentryEventRowsProjectionV1 = Readonly<{
  rows: readonly SentryProjectedEventRowV1[];
  /** Rows the page returned that could not be read; they consumed page budget. */
  omittedRowCount: number;
  projectionTruncated: boolean;
}>;

export function projectSentryEventRows(
  raw: unknown,
  bounds: SentryDetailBoundsV1,
): SentryEventRowsProjectionV1 {
  if (!Array.isArray(raw)) {
    return Object.freeze({ rows: Object.freeze([]), omittedRowCount: 0, projectionTruncated: false });
  }

  const rows: SentryProjectedEventRowV1[] = [];
  let omittedRowCount = 0;
  let projectionTruncated = false;

  for (const entry of raw) {
    if (!isRecord(entry)) {
      omittedRowCount += 1;
      continue;
    }
    const rawEventId = readString(entry['eventID']) ?? readString(entry['id']);
    const rawTitle = readString(entry['title']);
    const rawMessage = readString(entry['message']);
    const rawHeadline = rawTitle ?? rawMessage;
    if (rawEventId === null || rawHeadline === null) {
      omittedRowCount += 1;
      continue;
    }
    if (rows.length >= SENTRY_MAX_EVENT_ROWS) {
      omittedRowCount += 1;
      projectionTruncated = true;
      continue;
    }

    const eventId = bounded(rawEventId, bounds.identifierUtf8Bytes);
    const headline = bounded(rawHeadline, bounds.textUtf8Bytes);
    // The message is kept only when it says something the headline does not.
    const message = rawMessage === null || rawMessage === rawHeadline
      ? null
      : bounded(rawMessage, bounds.textUtf8Bytes);
    const rawLocation = readString(entry['location']);
    const location = rawLocation === null ? null : bounded(rawLocation, bounds.textUtf8Bytes);
    const rawCulprit = readString(entry['culprit']);
    const culprit = rawCulprit === null ? null : bounded(rawCulprit, bounds.textUtf8Bytes);
    const atMs = readTimestampMs(entry['dateCreated']);
    const truncated = eventId.truncated
      || headline.truncated
      || (message?.truncated ?? false)
      || (location?.truncated ?? false)
      || (culprit?.truncated ?? false);
    projectionTruncated = projectionTruncated || truncated;

    rows.push(Object.freeze({
      eventId: eventId.value,
      headline: headline.value,
      ...(message === null ? {} : { message: message.value }),
      ...(location === null ? {} : { location: location.value }),
      ...(culprit === null ? {} : { culprit: culprit.value }),
      ...(atMs === null ? {} : { atMs }),
      ...(truncated ? { truncated: true as const } : {}),
    }));
  }

  return Object.freeze({
    rows: Object.freeze(rows),
    omittedRowCount,
    projectionTruncated,
  });
}

/* -------------------------------------------------------------------- tags */

/** One value inside a tag distribution, or one row of a values page. */
export type SentryProjectedTagValueV1 = Readonly<{
  value: string;
  name?: string;
  count?: number;
  firstSeenAtMs?: number;
  lastSeenAtMs?: number;
  truncated?: true;
}>;

export type SentryProjectedTagV1 = Readonly<{
  key: string;
  name?: string;
  /** The provider's own stated cardinality for this key. */
  totalValues?: number;
  topValues: readonly SentryProjectedTagValueV1[];
  truncated?: true;
}>;

export type SentryTagsProjectionV1 = Readonly<{
  tags: readonly SentryProjectedTagV1[];
  /** Keys the response carried that this source dropped. */
  omittedTagCount: number;
  projectionTruncated: boolean;
}>;

export type SentryTagValueRowsProjectionV1 = Readonly<{
  rows: readonly SentryProjectedTagValueV1[];
  omittedRowCount: number;
  projectionTruncated: boolean;
}>;

/**
 * One tag value, holding only the distribution facts.
 *
 * `email`, `username`, `ipAddress` and `identifier` ride along on a
 * `sentry:user` value row. They are account identity, not the share this
 * section renders, and no surface here asks for them.
 */
function projectTagValue(
  value: unknown,
  bounds: SentryDetailBoundsV1,
): SentryProjectedTagValueV1 | null {
  if (!isRecord(value)) return null;
  const rawValue = readString(value['value']);
  if (rawValue === null) return null;
  const projected = bounded(rawValue, bounds.textUtf8Bytes);
  const rawName = readString(value['name']);
  const name = rawName === null ? null : bounded(rawName, bounds.textUtf8Bytes);
  const count = readCount(value['count']);
  const firstSeenAtMs = readTimestampMs(value['firstSeen']);
  const lastSeenAtMs = readTimestampMs(value['lastSeen']);
  const truncated = projected.truncated || (name?.truncated ?? false);
  return Object.freeze({
    value: projected.value,
    ...(name === null ? {} : { name: name.value }),
    ...(count === null ? {} : { count }),
    ...(firstSeenAtMs === null ? {} : { firstSeenAtMs }),
    ...(lastSeenAtMs === null ? {} : { lastSeenAtMs }),
    ...(truncated ? { truncated: true as const } : {}),
  });
}

export function projectSentryTagValueRows(
  raw: unknown,
  bounds: SentryDetailBoundsV1,
): SentryTagValueRowsProjectionV1 {
  if (!Array.isArray(raw)) {
    return Object.freeze({
      rows: Object.freeze([]),
      omittedRowCount: 0,
      projectionTruncated: false,
    });
  }
  const rows: SentryProjectedTagValueV1[] = [];
  let omittedRowCount = 0;
  let projectionTruncated = false;
  for (const entry of raw) {
    const projected = projectTagValue(entry, bounds);
    if (projected === null) {
      omittedRowCount += 1;
      continue;
    }
    if (rows.length >= SENTRY_MAX_TAG_VALUE_ROWS) {
      omittedRowCount += 1;
      projectionTruncated = true;
      continue;
    }
    projectionTruncated = projectionTruncated || projected.truncated === true;
    rows.push(projected);
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    omittedRowCount,
    projectionTruncated,
  });
}

export function projectSentryIssueTags(
  raw: unknown,
  bounds: SentryDetailBoundsV1,
): SentryTagsProjectionV1 {
  if (!Array.isArray(raw)) {
    return Object.freeze({
      tags: Object.freeze([]),
      omittedTagCount: 0,
      projectionTruncated: false,
    });
  }

  const tags: SentryProjectedTagV1[] = [];
  let omittedTagCount = 0;
  let projectionTruncated = false;

  for (const entry of raw) {
    if (!isRecord(entry)) {
      omittedTagCount += 1;
      continue;
    }
    const rawKey = readString(entry['key']);
    // A key this source could not address as one path segment is dropped rather
    // than offered as a drill-down that would fail the moment it was opened.
    if (rawKey === null || !isSentryRoutableTagKey(rawKey)) {
      omittedTagCount += 1;
      continue;
    }
    if (tags.length >= bounds.maxTagKeys) {
      omittedTagCount += 1;
      projectionTruncated = true;
      continue;
    }

    const key = bounded(rawKey, bounds.identifierUtf8Bytes);
    const rawName = readString(entry['name']);
    const name = rawName === null ? null : bounded(rawName, bounds.labelUtf8Bytes);
    const totalValues = readCount(entry['totalValues']);
    const rawTopValues = entry['topValues'];
    const topValues: SentryProjectedTagValueV1[] = [];
    let tagTruncated = key.truncated || (name?.truncated ?? false);
    if (Array.isArray(rawTopValues)) {
      tagTruncated = tagTruncated || rawTopValues.length > bounds.maxTopValuesPerTag;
      for (const candidate of rawTopValues.slice(0, bounds.maxTopValuesPerTag)) {
        const projected = projectTagValue(candidate, bounds);
        if (projected === null) continue;
        tagTruncated = tagTruncated || projected.truncated === true;
        topValues.push(projected);
      }
    }
    projectionTruncated = projectionTruncated || tagTruncated;

    tags.push(Object.freeze({
      key: key.value,
      ...(name === null ? {} : { name: name.value }),
      ...(totalValues === null ? {} : { totalValues }),
      topValues: Object.freeze(topValues),
      ...(tagTruncated ? { truncated: true as const } : {}),
    }));
  }

  return Object.freeze({
    tags: Object.freeze(tags),
    omittedTagCount,
    projectionTruncated,
  });
}

/* --------------------------------------------------------- release association */

/**
 * `[SCHEMA]` `firstRelease` and `lastRelease` are
 * `{"type":"object","additionalProperties":{},"nullable":true}` — entirely
 * untyped. Every field is read defensively and a field that does not parse is
 * omitted rather than guessed.
 */
export type SentryProjectedReleaseV1 = Readonly<{
  version: string;
  dateCreatedAtMs?: number;
  dateReleasedAtMs?: number;
}>;

export function projectSentryReleaseAssociation(
  raw: unknown,
  bounds: SentryDetailBoundsV1,
): SentryProjectedReleaseV1 | null {
  if (!isRecord(raw)) return null;
  const rawVersion = readString(raw['version']);
  if (rawVersion === null) return null;
  const version = bounded(rawVersion, bounds.textUtf8Bytes);
  const dateCreatedAtMs = readTimestampMs(raw['dateCreated']);
  const dateReleasedAtMs = readTimestampMs(raw['dateReleased']);
  return Object.freeze({
    version: version.value,
    ...(dateCreatedAtMs === null ? {} : { dateCreatedAtMs }),
    ...(dateReleasedAtMs === null ? {} : { dateReleasedAtMs }),
  });
}
