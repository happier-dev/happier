/**
 * The four source-native detail Action contracts.
 *
 * The detail body runs in a UI artifact that holds no credential and speaks no
 * HTTP, while `sentryApiClient.ts` is this source's sole credential reader. The
 * bridge between them is these Actions, declared with the same public schema
 * builders the shared Triage contract uses. They carry no Triage role: an event
 * row, a tag distribution and an activity item are Sentry-native content the
 * detail body reads, not Triage entries the aggregate may hold.
 *
 * Every published bound is the exact value the boundary projector applies, so a
 * page the projector can produce always parses and a page it never could is
 * rejected here rather than becoming a second, looser statement of what may
 * leave this source. Each result object is `closed`, which is what makes an
 * accidentally widened projection a failure instead of a leak.
 *
 * The paging position is a token this source mints. Sentry's own `Link` header
 * is a provider-controlled absolute URL, so it never crosses this boundary: it
 * is verified and reduced to an opaque cursor by the read modules, and the
 * mounted panel can neither request a provider-chosen URL nor hold one in state.
 * Like the scan continuation, this token is invocation-local, is never
 * persisted, and is never a watermark.
 */

import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  defineProtocolUtf8String,
  type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';
import {
  TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
  TriageConfiguredSourceInstanceV1Schema,
  TriageSourceEntryLocalRefV1Schema,
  TriageSourceFailureV1Schema,
} from '@happier-dev/triage-protocol/v1';

const defineSentryDetailString = (
  options: Parameters<typeof defineProtocolUtf8String>[0],
) => defineProtocolUtf8String({
  ...options,
  pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

import {
  readCursorCycleProbeV1,
  type CursorCycleProbeV1,
} from '@happier-dev/triage-sources/runtime';
import { SENTRY_MAX_DETAIL_PAGE_SIZE } from '../api/sentryRoutes.js';
import { SENTRY_EVENT_BOUNDS_V1 } from '../privacy/sentryEventProjection.js';

import {
  SENTRY_DETAIL_BOUNDS_V1,
  SENTRY_MAX_EVENT_ROWS,
  SENTRY_MAX_TAG_VALUE_ROWS,
} from './detailProjection.js';

/** The page size one mounted detail panel asks for. */
export const SENTRY_DETAIL_PAGE_SIZE = SENTRY_MAX_DETAIL_PAGE_SIZE;

const CONTINUATION_VERSION = 1;

/** The invocation-local paging position of one mounted detail panel. */
export type SentryDetailFrontierV1 = Readonly<{
  v: 1;
  /** The `cursor` value taken verbatim from a validated `rel="next"` link. */
  cursor: string;
  limit: number;
  /**
   * The earlier position this walk is watching for, and the schedule that moves
   * it (the shared Triage source cursor-cycle owner).
   *
   * It is the walk's own non-progress evidence, and it lives here because a walk
   * whose pages are separate Action invocations has nowhere else to keep it.
   * Comparing an advertised next cursor against the single cursor that produced
   * it only sees `A → A`; a provider alternating `A → B → A` advertises a cursor
   * that differs from the one just requested on every page, so the panel keeps
   * offering "Load more" and the walk never ends. The walk seeing its own cycle
   * settles a truthful stopped-short list instead, and keeps the rows it read.
   *
   * It is a within-panel position, exactly like `cursor`: no route, no
   * credential, no clock, and nothing that outlives the mounted panel — and it
   * is one saved cursor rather than every requested one. Its own bookkeeping is
   * constant-space, so a reader may press "Load more" as long as there are pages.
   */
  probe: CursorCycleProbeV1;
}>;

export function encodeSentryDetailContinuation(
  frontier: SentryDetailFrontierV1,
): string | null {
  if (
    frontier.cursor === ''
    || !Number.isSafeInteger(frontier.limit)
    || frontier.limit < 1
    || frontier.limit > SENTRY_DETAIL_PAGE_SIZE
    || readCursorCycleProbeV1(frontier.probe) === null
  ) {
    return null;
  }
  return JSON.stringify({
    v: CONTINUATION_VERSION,
    cursor: frontier.cursor,
    limit: frontier.limit,
    probe: { ...frontier.probe },
  });
}

/**
 * Decodes a continuation this source minted. Anything else — another version, an
 * empty cursor, a page size this source will not request, or a provider URL —
 * is rejected, and the caller starts the walk again rather than guessing a
 * position.
 */
export function decodeSentryDetailContinuation(token: string): SentryDetailFrontierV1 | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(token);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
  const raw = decoded as Readonly<Record<string, unknown>>;
  const cursor = raw['cursor'];
  const limit = raw['limit'];
  const probe = readCursorCycleProbeV1(raw['probe']);
  if (
    raw['v'] !== CONTINUATION_VERSION
    || typeof cursor !== 'string'
    || cursor === ''
    || typeof limit !== 'number'
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > SENTRY_DETAIL_PAGE_SIZE
    || probe === null
  ) {
    return null;
  }
  return Object.freeze({
    v: 1 as const,
    cursor,
    limit,
    probe,
  });
}

/**
 * Why a paged detail walk stopped before the end of its collection.
 *
 * A page that ends the walk carries neither this nor a continuation; a page that
 * carries this ended the walk WITHOUT reaching the end of the collection, and the
 * panel must say so rather than presenting a truncated list as a complete one
 * (`REQ-04`). The names are the scan plane's own, because a cursor this source
 * will not follow means the same thing on both planes — including the last one,
 * which is emphatically not a cursor verdict: the provider's cursor can be
 * perfectly well formed while this source fails to serialize the continuation
 * beside the walk's own cycle evidence, and blaming the provider for a failure
 * this side owns is a different and false claim.
 */
const SentryIncompleteReasonSchema = defineProtocolUnion([
  defineProtocolLiteral('paginationHeaderAbsent'),
  defineProtocolLiteral('paginationCursorMalformed'),
  defineProtocolLiteral('paginationCursorNotAdvancing'),
  defineProtocolLiteral('continuationUnavailable'),
]);

const SentryBooleanSchema = defineProtocolUnion([
  defineProtocolLiteral(true),
  defineProtocolLiteral(false),
]);

const IdentifierSchema = defineSentryDetailString({
  maxUtf8Bytes: SENTRY_DETAIL_BOUNDS_V1.identifierUtf8Bytes,
  minLength: 1,
});
const TextSchema = defineSentryDetailString({
  maxUtf8Bytes: SENTRY_DETAIL_BOUNDS_V1.textUtf8Bytes,
  minLength: 1,
});
const LabelSchema = defineSentryDetailString({
  maxUtf8Bytes: SENTRY_DETAIL_BOUNDS_V1.textUtf8Bytes,
  minLength: 1,
});
const TimestampSchema = defineProtocolNumber({ integer: true });
const CountSchema = defineProtocolNumber({ integer: true, minimum: 0 });
const EmptyOrTextSchema = defineProtocolUnion([
  defineProtocolLiteral(''),
  TextSchema,
]);
const EmptyOrLabelSchema = defineProtocolUnion([
  defineProtocolLiteral(''),
  LabelSchema,
]);

const ContinuationSchema = defineProtocolString({ minLength: 1 });

const PageLimitSchema = defineProtocolNumber({
  integer: true,
  minimum: 1,
  maximum: SENTRY_DETAIL_PAGE_SIZE,
});

/* ------------------------------------------------------------ published rows */

export const SentryProjectedEventRowV1Schema = defineProtocolObject({
  eventId: IdentifierSchema,
  headline: TextSchema,
  message: TextSchema.optional(),
  location: TextSchema.optional(),
  culprit: TextSchema.optional(),
  atMs: TimestampSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const SentryProjectedTagValueV1Schema = defineProtocolObject({
  value: TextSchema,
  name: TextSchema.optional(),
  count: CountSchema.optional(),
  firstSeenAtMs: TimestampSchema.optional(),
  lastSeenAtMs: TimestampSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const SentryProjectedTagV1Schema = defineProtocolObject({
  key: IdentifierSchema,
  name: LabelSchema.optional(),
  totalValues: CountSchema.optional(),
  topValues: defineProtocolArray(SentryProjectedTagValueV1Schema),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const SentryProjectedActivityItemV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  type: LabelSchema,
  atMs: TimestampSchema.optional(),
  actor: LabelSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const SentryProjectedReleaseV1Schema = defineProtocolObject({
  version: TextSchema,
  dateCreatedAtMs: TimestampSchema.optional(),
  dateReleasedAtMs: TimestampSchema.optional(),
}, { policy: 'closed' });

/* -------------------------------------------------------------- read-issue */

/**
 * The one public issue read, with three closed consumer-qualified projections.
 *
 * The arms exist because their lifetimes and privacy tiers differ, not because
 * the request does: `overview` is the Tier-A live summary the detail root holds,
 * while `tags` and `activity` are Tier-B content that lives only inside the
 * panel that asked for it. Splitting them is what lets the detail root hold no
 * tag value and no activity record at all (`SENTRY.md` §7.3a).
 */
export const SentryReadIssueInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  projection: defineProtocolUnion([
    defineProtocolLiteral('overview'),
    defineProtocolLiteral('tags'),
    defineProtocolLiteral('activity'),
  ]),
}, { policy: 'closed' });
export type SentryReadIssueInputV1 = ReturnType<typeof SentryReadIssueInputV1Schema.parse>;

export const SentryIssueOverviewProjectionV1Schema = defineProtocolObject({
  kind: defineProtocolLiteral('overview'),
  /** Sentry's own current word for this issue's state, when it stated one. */
  nativeStateLabel: LabelSchema.optional(),
  statePresentation: defineProtocolUnion([
    defineProtocolLiteral('active'),
    defineProtocolLiteral('resolved'),
    defineProtocolLiteral('suppressed'),
    defineProtocolLiteral('closed'),
    defineProtocolLiteral('unknown'),
  ]),
  /** `[SCHEMA]` counts are strings because they can exceed a safe integer. */
  eventCount: TextSchema.optional(),
  userCount: CountSchema.optional(),
  firstSeenAtMs: TimestampSchema.optional(),
  lastSeenAtMs: TimestampSchema.optional(),
  firstRelease: SentryProjectedReleaseV1Schema.optional(),
  lastRelease: SentryProjectedReleaseV1Schema.optional(),
}, { policy: 'closed' });

export const SentryIssueTagsProjectionV1Schema = defineProtocolObject({
  kind: defineProtocolLiteral('tags'),
  tags: defineProtocolArray(SentryProjectedTagV1Schema),
  omittedTagCount: CountSchema,
  projectionTruncated: SentryBooleanSchema,
}, { policy: 'closed' });

const SentryActivityAvailableSchema = defineProtocolObject({
  status: defineProtocolLiteral('available'),
  items: defineProtocolArray(SentryProjectedActivityItemV1Schema),
  malformedItemCount: CountSchema,
  omittedItemCount: CountSchema,
  projectionTruncated: SentryBooleanSchema,
}, { policy: 'closed' });

export const SentryIssueActivityProjectionV1Schema = defineProtocolObject({
  kind: defineProtocolLiteral('activity'),
  /**
   * An `activity` field this source could not read is `unavailable`; an issue
   * whose history is genuinely empty is `available` with no items. A reader is
   * never shown one as the other.
   */
  activity: defineProtocolUnion([
    SentryActivityAvailableSchema,
    defineProtocolObject({
      status: defineProtocolLiteral('unavailable'),
    }, { policy: 'closed' }),
  ]),
}, { policy: 'closed' });

const SentryUnavailableSchema = defineProtocolObject({
  kind: defineProtocolLiteral('unavailable'),
  failure: TriageSourceFailureV1Schema,
}, { policy: 'closed' });

export const SentryReadIssueResultV1Schema = defineProtocolUnion([
  SentryIssueOverviewProjectionV1Schema,
  SentryIssueTagsProjectionV1Schema,
  SentryIssueActivityProjectionV1Schema,
  SentryUnavailableSchema,
]);
export type SentryReadIssueResultV1 = ReturnType<typeof SentryReadIssueResultV1Schema.parse>;

/* -------------------------------------------------------------- issue events */

export const SentryIssueEventsInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  limit: PageLimitSchema,
  /** Present only for a following page, and only as this source minted it. */
  continuation: ContinuationSchema.optional(),
}, { policy: 'closed' });
export type SentryIssueEventsInputV1 = ReturnType<typeof SentryIssueEventsInputV1Schema.parse>;

export const SentryIssueEventsResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('events'),
    rows: defineProtocolArray(SentryProjectedEventRowV1Schema, {
      maxItems: SENTRY_MAX_EVENT_ROWS,
    }),
    /**
     * Rows this page returned that could not be read. They consumed the same
     * page budget an accepted row would have, so a reader can state what the
     * page covered.
     */
    omittedRowCount: CountSchema,
    projectionTruncated: SentryBooleanSchema,
    /** Absent when this page ends the walk. */
    continuation: ContinuationSchema.optional(),
    /** Present only when the walk stopped SHORT of the collection. */
    incomplete: SentryIncompleteReasonSchema.optional(),
  }, { policy: 'closed' }),
  SentryUnavailableSchema,
]);
export type SentryIssueEventsResultV1 = ReturnType<typeof SentryIssueEventsResultV1Schema.parse>;

/* ---------------------------------------------------------------- tag values */

export const SentryTagValuesInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  /** One provider tag key, revalidated as a single path segment at the route. */
  tagKey: defineSentryDetailString({ maxUtf8Bytes: 200, minLength: 1 }),
  limit: PageLimitSchema,
  continuation: ContinuationSchema.optional(),
}, { policy: 'closed' });
export type SentryTagValuesInputV1 = ReturnType<typeof SentryTagValuesInputV1Schema.parse>;

export const SentryTagValuesResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('tagValues'),
    tagKey: IdentifierSchema,
    rows: defineProtocolArray(SentryProjectedTagValueV1Schema, {
      maxItems: SENTRY_MAX_TAG_VALUE_ROWS,
    }),
    omittedRowCount: CountSchema,
    projectionTruncated: SentryBooleanSchema,
    continuation: ContinuationSchema.optional(),
    /** Present only when the walk stopped SHORT of the collection. */
    incomplete: SentryIncompleteReasonSchema.optional(),
  }, { policy: 'closed' }),
  SentryUnavailableSchema,
]);
export type SentryTagValuesResultV1 = ReturnType<typeof SentryTagValuesResultV1Schema.parse>;

/* ------------------------------------------------------------ selected event */

/**
 * The one occurrence a detail body has selected.
 *
 * `representative` is the provider's own `recommended` selector under a name no
 * surface can mistake for "latest" (`SENTRY.md` §7.3). An exact arm carries only
 * the event id, which the route revalidates before it interpolates.
 */
export const SentryEventSelectorV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('representative'),
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('event'),
    eventId: IdentifierSchema,
  }, { policy: 'closed' }),
]);

export const SentryReadEventInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  selector: SentryEventSelectorV1Schema,
}, { policy: 'closed' });
export type SentryReadEventInputV1 = ReturnType<typeof SentryReadEventInputV1Schema.parse>;

const NullSchema = defineProtocolLiteral(null);

/**
 * `T | null` on the wire.
 *
 * The event projection states absence explicitly rather than by omission: a frame
 * with no resolved filename and a frame whose filename was withheld both need a
 * shape, and an optional property could not tell them apart at the boundary.
 */
function nullable<TValue>(
  schema: ProtocolComposableSchema<TValue, TValue>,
): ProtocolComposableSchema<TValue | null, TValue | null> {
  return defineProtocolUnion([schema, NullSchema]);
}

const LocationSchema = TextSchema;

/**
 * Always the empty object.
 *
 * Frame locals are Tier C and are withheld unconditionally, so the published shape
 * makes a leak unrepresentable rather than merely unlikely: a projection that
 * started copying them could not parse against its own result schema.
 */
const FrameVarsSchema = defineProtocolObject({}, { policy: 'closed' });

const SentryFrameV1Schema = defineProtocolObject({
  filename: nullable(LocationSchema),
  function: nullable(LabelSchema),
  lineNo: nullable(TimestampSchema),
  colNo: nullable(TimestampSchema),
  inApp: SentryBooleanSchema,
  contextLine: nullable(TextSchema),
  vars: FrameVarsSchema,
}, { policy: 'closed' });

const SentryBreadcrumbV1Schema = defineProtocolObject({
  timestampMs: nullable(TimestampSchema),
  category: nullable(LabelSchema),
  level: nullable(LabelSchema),
  message: nullable(TextSchema),
}, { policy: 'closed' });

const FramesSchema = defineProtocolArray(SentryFrameV1Schema);

const SentryEventSectionV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('exception'),
    type: EmptyOrLabelSchema,
    value: EmptyOrTextSchema,
    frames: FramesSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('stacktrace'),
    frames: FramesSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('breadcrumbs'),
    entries: defineProtocolArray(SentryBreadcrumbV1Schema),
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('message'),
    formatted: TextSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('unsupported'),
    entryType: LabelSchema,
  }, { policy: 'closed' }),
]);

const SentryRedactionV1Schema = defineProtocolObject({
  path: defineSentryDetailString({
    maxUtf8Bytes: SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes,
    minLength: 1,
  }),
  reason: defineProtocolUnion([
    defineProtocolLiteral('providerScrubbed'),
    defineProtocolLiteral('pluginWithheld'),
  ]),
}, { policy: 'closed' });

export const SentryEventProjectionV1Schema = defineProtocolObject({
  eventId: defineSentryDetailString({
    maxUtf8Bytes: SENTRY_EVENT_BOUNDS_V1.identifierUtf8Bytes,
  }),
  dateCreatedMs: nullable(TimestampSchema),
  title: EmptyOrTextSchema,
  message: EmptyOrTextSchema,
  location: nullable(TextSchema),
  culprit: nullable(TextSchema),
  platform: nullable(LabelSchema),
  sections: defineProtocolArray(SentryEventSectionV1Schema),
  tags: defineProtocolArray(defineProtocolObject({
    key: LabelSchema,
    value: TextSchema,
  }, { policy: 'closed' })),
  user: nullable(defineProtocolObject({
    id: nullable(IdentifierSchema),
    email: nullable(TextSchema),
    username: nullable(TextSchema),
    ipAddress: nullable(IdentifierSchema),
    name: nullable(TextSchema),
  }, { policy: 'closed' })),
  /**
   * What was withheld, and what sensitive data survived. §8.4 builds its disclosure
   * from these two arrays, which is why they are published rather than derived: a
   * disclosure assembled from a boolean is a guess.
   */
  redactions: defineProtocolArray(SentryRedactionV1Schema),
  sensitivePaths: defineProtocolArray(LabelSchema),
  projectionTruncated: SentryBooleanSchema,
  omitted: defineProtocolObject({
    sections: CountSchema,
    frames: CountSchema,
    breadcrumbs: CountSchema,
    tags: CountSchema,
    redactions: CountSchema,
    sensitivePaths: CountSchema,
  }, { policy: 'closed' }),
}, { policy: 'closed' });

export const SentryReadEventResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('event'),
    projection: SentryEventProjectionV1Schema,
  }, { policy: 'closed' }),
  SentryUnavailableSchema,
]);
export type SentryReadEventResultV1 = ReturnType<typeof SentryReadEventResultV1Schema.parse>;
