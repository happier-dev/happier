export type GithubRepositoryEventsCursorV1 = Readonly<{
  v: 1;
  /**
   * The immutable point at which this source began observing. It is not a
   * polling watermark: GitHub can expose a pre-existing event late.
   */
  observationStartsAtMs: number;
  observedAtMs: number;
  seenEventIds: readonly string[];
  etag: string | null;
}>;

export type GithubRepositoryTimelineEntryV1<TObservation> = Readonly<{
  eventId: string;
  createdAtMs: number;
  observation: TObservation | null;
}>;

export type GithubRepositoryEventsClassificationV1<TObservation> =
  | Readonly<{ kind: 'historyGap' }>
  | Readonly<{
    kind: 'observations';
    observations: readonly TObservation[];
    checkpoint: GithubRepositoryEventsCursorV1;
  }>;

const GITHUB_REPOSITORY_EVENT_TIMELINE_LIMIT = 300;
const GITHUB_REPOSITORY_EVENTS_RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('GitHub repository event timestamps must be nonnegative safe integers');
  }
  return value;
}

function validateEventId(value: string): string {
  if (!value || value.length > 256) {
    throw new RangeError('GitHub repository event IDs must be bounded nonempty strings');
  }
  return value;
}

function validateCursor(cursor: GithubRepositoryEventsCursorV1): void {
  validateTimestamp(cursor.observationStartsAtMs);
  validateTimestamp(cursor.observedAtMs);
  if (cursor.observedAtMs < cursor.observationStartsAtMs) {
    throw new RangeError('GitHub repository event observation cannot precede its activation cutoff');
  }
}

/** Parses the provider-owned cursor before a background observer lends it any cursor semantics. */
export function parseGithubRepositoryEventsCursor(value: unknown): GithubRepositoryEventsCursorV1 {
  if (!isRecord(value)
    || Object.keys(value).length !== 5
    || value.v !== 1
    || typeof value.observationStartsAtMs !== 'number'
    || typeof value.observedAtMs !== 'number'
    || !Array.isArray(value.seenEventIds)
    || value.seenEventIds.some((eventId) => typeof eventId !== 'string')
    || (value.etag !== null && typeof value.etag !== 'string')) {
    throw new RangeError('GitHub repository event checkpoint must use strict V1 cursor fields');
  }
  const seenEventIds = value.seenEventIds.map((eventId) => validateEventId(eventId));
  if (seenEventIds.length > GITHUB_REPOSITORY_EVENT_TIMELINE_LIMIT
    || new Set(seenEventIds).size !== seenEventIds.length) {
    throw new RangeError('GitHub repository event checkpoint has an invalid seen-event set');
  }
  const cursor = Object.freeze({
    v: 1 as const,
    observationStartsAtMs: validateTimestamp(value.observationStartsAtMs),
    observedAtMs: validateTimestamp(value.observedAtMs),
    seenEventIds: Object.freeze(seenEventIds),
    etag: value.etag,
  });
  validateCursor(cursor);
  return cursor;
}

function validateTimeline<TObservation>(events: readonly GithubRepositoryTimelineEntryV1<TObservation>[]): void {
  if (events.length > GITHUB_REPOSITORY_EVENT_TIMELINE_LIMIT) {
    throw new RangeError('GitHub repository event timelines cannot exceed 300 entries');
  }
  const eventIds = new Set<string>();
  for (const event of events) {
    const eventId = validateEventId(event.eventId);
    validateTimestamp(event.createdAtMs);
    if (eventIds.has(eventId)) {
      throw new RangeError('GitHub repository event timelines cannot contain duplicate event IDs');
    }
    eventIds.add(eventId);
  }
}

function compareTimelineEntries<TObservation>(
  left: GithubRepositoryTimelineEntryV1<TObservation>,
  right: GithubRepositoryTimelineEntryV1<TObservation>,
): number {
  if (left.createdAtMs !== right.createdAtMs) {
    return left.createdAtMs < right.createdAtMs ? -1 : 1;
  }
  if (left.eventId === right.eventId) return 0;
  return left.eventId < right.eventId ? -1 : 1;
}

/**
 * GitHub does not contractually define the response order for repository
 * Events. The poll adapter supplies every Link-followed page here so cursor
 * processing and serialized checkpoint state both have one stable order.
 */
export function orderGithubRepositoryEventTimeline<TObservation>(
  events: readonly GithubRepositoryTimelineEntryV1<TObservation>[],
): readonly GithubRepositoryTimelineEntryV1<TObservation>[] {
  validateTimeline(events);
  return Object.freeze([...events].sort(compareTimelineEntries));
}

function checkpoint<TObservation>(input: Readonly<{
  events: readonly GithubRepositoryTimelineEntryV1<TObservation>[];
  observationStartsAtMs: number;
  observedAtMs: number;
  seenEventIds: ReadonlySet<string>;
  etag: string | null;
}>): GithubRepositoryEventsCursorV1 {
  const observationStartsAtMs = validateTimestamp(input.observationStartsAtMs);
  const observedAtMs = validateTimestamp(input.observedAtMs);
  if (observedAtMs < observationStartsAtMs) {
    throw new RangeError('GitHub repository event observation cannot precede its activation cutoff');
  }
  return Object.freeze({
    v: 1,
    observationStartsAtMs,
    observedAtMs,
    seenEventIds: Object.freeze(orderGithubRepositoryEventTimeline(input.events)
      .map(({ eventId }) => eventId)
      .filter((eventId) => input.seenEventIds.has(eventId))),
    etag: input.etag,
  });
}

/**
 * Establishes the documented no-history baseline. The caller has already
 * drained the complete bounded timeline; no event can be emitted at baseline.
 */
export function createGithubRepositoryEventsBaseline<TObservation>(input: Readonly<{
  observationStartsAtMs: number;
  observedAtMs: number;
  events: readonly GithubRepositoryTimelineEntryV1<TObservation>[];
  etag?: string | null;
}>): GithubRepositoryEventsCursorV1 {
  validateTimeline(input.events);
  return checkpoint({
    events: input.events,
    observationStartsAtMs: input.observationStartsAtMs,
    observedAtMs: input.observedAtMs,
    seenEventIds: new Set(input.events.map(({ eventId }) => eventId)),
    etag: input.etag ?? null,
  });
}

export function reuseGithubRepositoryEventsCheckpointOnNotModified(
  cursor: GithubRepositoryEventsCursorV1,
  observedAtMs: number,
): GithubRepositoryEventsCursorV1 {
  validateCursor(cursor);
  validateTimestamp(observedAtMs);
  if (observedAtMs < cursor.observedAtMs) {
    throw new RangeError('GitHub repository event observation watermark cannot move backwards');
  }
  return Object.freeze({
    ...cursor,
    observedAtMs,
    seenEventIds: Object.freeze([...cursor.seenEventIds]),
  });
}

/**
 * The Events API is a bounded timeline rather than a durable stream. The poll
 * adapter must exhaust Link-followed pages; this owner then derives a stable
 * oldest-first order from immutable `created_at` and `id` fields instead of
 * assuming a response order. It preserves an unprocessed supported entry as
 * unseen for the next request. A completely displaced prior timeline is an
 * explicit gap, never a fabricated cursor.
 */
export function classifyGithubRepositoryEvents<TObservation>(input: Readonly<{
  cursor: GithubRepositoryEventsCursorV1;
  observedAtMs: number;
  etag: string | null;
  maxEntries: number;
  events: readonly GithubRepositoryTimelineEntryV1<TObservation>[];
}>): GithubRepositoryEventsClassificationV1<TObservation> {
  validateTimeline(input.events);
  validateCursor(input.cursor);
  validateTimestamp(input.observedAtMs);
  if (input.observedAtMs < input.cursor.observedAtMs) {
    throw new RangeError('GitHub repository event observation watermark cannot move backwards');
  }
  if (!Number.isSafeInteger(input.maxEntries) || input.maxEntries < 1) {
    throw new RangeError('GitHub repository event batches require a positive safe maxEntries');
  }

  const orderedEvents = orderGithubRepositoryEventTimeline(input.events);
  const priorSeen = new Set(input.cursor.seenEventIds.map(validateEventId));
  const currentIds = new Set(orderedEvents.map(({ eventId }) => eventId));
  const hasPriorOverlap = [...priorSeen].some((eventId) => currentIds.has(eventId));
  const currentTimelineIsNewerThanBaseline = orderedEvents.length === GITHUB_REPOSITORY_EVENT_TIMELINE_LIMIT
    && orderedEvents.every(({ createdAtMs }) => createdAtMs > input.cursor.observedAtMs);
  const continuityHorizonOutlastedRetention = input.observedAtMs - input.cursor.observedAtMs
    > GITHUB_REPOSITORY_EVENTS_RETENTION_WINDOW_MS;
  if ((priorSeen.size > 0 && !hasPriorOverlap)
    || (priorSeen.size === 0 && currentTimelineIsNewerThanBaseline)
    || (continuityHorizonOutlastedRetention && !hasPriorOverlap)) {
    return Object.freeze({ kind: 'historyGap' });
  }

  const classified = new Set(priorSeen);
  const observations: TObservation[] = [];
  let complete = true;
  let blockedByUncommittedObservation = false;
  for (const event of orderedEvents) {
    if (classified.has(event.eventId)) continue;
    // A checkpoint is a contiguous provider-order prefix. Once an admitted
    // candidate is left uncommitted, even a later terminal/unsupported event
    // must remain unseen so a retry cannot leap over the blocked occurrence.
    if (blockedByUncommittedObservation) {
      complete = false;
      continue;
    }
    if (event.createdAtMs <= input.cursor.observationStartsAtMs) {
      classified.add(event.eventId);
      continue;
    }
    if (event.observation === null) {
      classified.add(event.eventId);
      continue;
    }
    if (observations.length >= input.maxEntries) {
      complete = false;
      blockedByUncommittedObservation = true;
      continue;
    }
    observations.push(event.observation);
    classified.add(event.eventId);
  }

  return Object.freeze({
    kind: 'observations',
    observations: Object.freeze(observations),
    checkpoint: checkpoint({
      events: input.events,
      observationStartsAtMs: input.cursor.observationStartsAtMs,
      observedAtMs: input.observedAtMs,
      seenEventIds: classified,
      etag: complete ? input.etag : null,
    }),
  });
}
