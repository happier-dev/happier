/**
 * The four bound source-native detail operations.
 *
 * Each is the whole vertical for one Action invocation: it validates the
 * published input, admits the ref against the exact configured instance through
 * the same rule `get` uses, materializes that exact account inside one request
 * closure, and shapes the result into the published contract. It owns no
 * registry, cache or second route authority, and it writes no configured state.
 *
 * The detail body invokes these; it never holds a credential, constructs a URL,
 * or sees a raw provider body. What crosses back is only what the boundary
 * projector copied.
 *
 * Every failure is a **stated** outcome rather than an empty result. A tags read
 * refused for permission, an activity field that could not be parsed, and an
 * issue with no activity at all are three different answers, and each panel is
 * given the one that is true.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  createBoundedInvocation,
  type CursorCycleWalkV1,
} from '@happier-dev/triage-sources/runtime';
import {
  fitActionResultPageV1,
  fitActionResultSequenceV1,
} from '@happier-dev/triage-sources/projection/actionResultSequence';

import { createSentryApiClient } from '../api/sentryApiClient.js';
import { SENTRY_FAILURE_CODES } from '../sentryContracts.js';
import {
  SentryIssueEventsInputV1Schema,
  SentryReadEventInputV1Schema,
  SentryReadIssueInputV1Schema,
  SentryTagValuesInputV1Schema,
  decodeSentryDetailContinuation,
  encodeSentryDetailContinuation,
  type SentryIssueEventsResultV1,
  type SentryReadEventResultV1,
  type SentryReadIssueResultV1,
  type SentryTagValuesResultV1,
} from '../detail/detailContracts.js';
import {
  readSentryEventProjection,
  readSentryIssueEventsPage,
  readSentryIssueProjection,
  readSentryTagValuesPage,
  type SentryNextPageV1,
} from '../detail/detailReads.js';
import type { SentryDetailIncompleteReasonV1 } from '../ui/detail/panelState.js';
import type {
  SentryEventProjectionV1,
  SentryEventSectionV1,
} from '../privacy/sentryEventProjection.js';

import { toTriageFailure } from './observation.js';
import { admitSentryEntryInvocation } from './operations.js';

const CONTINUATION_UNREADABLE = Object.freeze({
  class: 'unsupportedContract' as const,
  code: SENTRY_FAILURE_CODES.paginationCursorMalformed,
});

type SentryEventActionResultV1 = Extract<SentryReadEventResultV1, { kind: 'event' }>;

function eventResult(projection: SentryEventProjectionV1): SentryEventActionResultV1 {
  return Object.freeze({ kind: 'event' as const, projection: Object.freeze(projection) });
}

function fitSentryReadIssueResult(
  value: Exclude<SentryReadIssueResultV1, { kind: 'unavailable' }>,
): SentryReadIssueResultV1 {
  if (value.kind === 'tags') {
    return fitActionResultSequenceV1(value.tags, (tags, omittedCount) => Object.freeze({
      ...value,
      tags: Object.freeze([...tags]),
      omittedTagCount: value.omittedTagCount + omittedCount,
      projectionTruncated: value.projectionTruncated || omittedCount > 0,
    })).result;
  }
  if (value.kind === 'activity' && value.activity.status === 'available') {
    const activity = value.activity;
    return fitActionResultSequenceV1(activity.items, (items, omittedCount) => Object.freeze({
      ...value,
      activity: Object.freeze({
        ...activity,
        items: Object.freeze([...items]),
        omittedItemCount: activity.omittedItemCount + omittedCount,
        projectionTruncated: activity.projectionTruncated || omittedCount > 0,
      }),
    })).result;
  }
  return value;
}

/**
 * Fits the complete selected-event result against the one real byte resource.
 *
 * The order is deliberate: disclosure evidence is admitted before the content it
 * qualifies, then sections and tags are added in provider order. Every candidate
 * is measured as the complete final Action result accumulated so far, so nested
 * fitting cannot later overflow when sibling fields are combined. There is no
 * source-local count or byte budget.
 */
export function fitSentryEventResult(projection: SentryEventProjectionV1): SentryEventActionResultV1 {
  let current: SentryEventProjectionV1 = Object.freeze({
    ...projection,
    sections: Object.freeze([]),
    tags: Object.freeze([]),
    redactions: Object.freeze([]),
    sensitivePaths: Object.freeze([]),
  });

  const fittedRedactions = fitActionResultSequenceV1(
    projection.redactions,
    (redactions, omittedCount) => eventResult(Object.freeze({
      ...current,
      redactions: Object.freeze([...redactions]),
      projectionTruncated: current.projectionTruncated || omittedCount > 0,
      omitted: Object.freeze({
        ...current.omitted,
        redactions: projection.omitted.redactions + omittedCount,
      }),
    })),
  );
  current = fittedRedactions.result.projection;

  const fittedSensitivePaths = fitActionResultSequenceV1(
    projection.sensitivePaths,
    (sensitivePaths, omittedCount) => eventResult(Object.freeze({
      ...current,
      sensitivePaths: Object.freeze([...sensitivePaths]),
      projectionTruncated: current.projectionTruncated || omittedCount > 0,
      omitted: Object.freeze({
        ...current.omitted,
        sensitivePaths: projection.omitted.sensitivePaths + omittedCount,
      }),
    })),
  );
  current = fittedSensitivePaths.result.projection;

  for (const section of projection.sections) {
    const before = current;
    if (section.kind === 'exception' || section.kind === 'stacktrace') {
      try {
        const fitted = fitActionResultSequenceV1(section.frames, (frames, omittedCount) => {
          const fittedSection: SentryEventSectionV1 = Object.freeze({
            ...section,
            frames: Object.freeze([...frames]),
          });
          return eventResult(Object.freeze({
            ...before,
            sections: Object.freeze([...before.sections, fittedSection]),
            projectionTruncated: before.projectionTruncated || omittedCount > 0,
            omitted: Object.freeze({
              ...before.omitted,
              frames: before.omitted.frames + omittedCount,
            }),
          }));
        });
        current = fitted.result.projection;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        current = Object.freeze({
          ...before,
          projectionTruncated: true,
          omitted: Object.freeze({ ...before.omitted, sections: before.omitted.sections + 1 }),
        });
      }
      continue;
    }
    if (section.kind === 'breadcrumbs') {
      try {
        const fitted = fitActionResultSequenceV1(section.entries, (entries, omittedCount) => {
          const fittedSection: SentryEventSectionV1 = Object.freeze({
            ...section,
            entries: Object.freeze([...entries]),
          });
          return eventResult(Object.freeze({
            ...before,
            sections: Object.freeze([...before.sections, fittedSection]),
            projectionTruncated: before.projectionTruncated || omittedCount > 0,
            omitted: Object.freeze({
              ...before.omitted,
              breadcrumbs: before.omitted.breadcrumbs + omittedCount,
            }),
          }));
        });
        current = fitted.result.projection;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        current = Object.freeze({
          ...before,
          projectionTruncated: true,
          omitted: Object.freeze({ ...before.omitted, sections: before.omitted.sections + 1 }),
        });
      }
      continue;
    }
    try {
      current = fitActionResultSequenceV1([section], (sections, omittedCount) => eventResult(Object.freeze({
        ...before,
        sections: Object.freeze([...before.sections, ...sections]),
        projectionTruncated: before.projectionTruncated || omittedCount > 0,
        omitted: Object.freeze({
          ...before.omitted,
          sections: before.omitted.sections + omittedCount,
        }),
      }))).result.projection;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      current = Object.freeze({
        ...before,
        projectionTruncated: true,
        omitted: Object.freeze({ ...before.omitted, sections: before.omitted.sections + 1 }),
      });
    }
  }

  const fittedTags = fitActionResultSequenceV1(
    projection.tags,
    (tags, omittedCount) => eventResult(Object.freeze({
      ...current,
      tags: Object.freeze([...tags]),
      projectionTruncated: current.projectionTruncated || omittedCount > 0,
      omitted: Object.freeze({
        ...current.omitted,
        tags: projection.omitted.tags + omittedCount,
      }),
    })),
  );
  return fittedTags.result;
}

/**
 * Resolves the position one paged detail read starts from.
 *
 * A rejected token restarts the walk at the first page rather than requesting a
 * position nobody can vouch for — and because the token carries the walk's own
 * cycle evidence, restarting also restarts that evidence rather than resuming a
 * walk with a probe it cannot vouch for either.
 */
function resolveWalkPosition(
  continuation: string | undefined,
  limit: number,
): Readonly<{ ok: true; position: CursorCycleWalkV1 | null }> | Readonly<{ ok: false }> {
  if (continuation === undefined) {
    return Object.freeze({ ok: true as const, position: null });
  }
  const frontier = decodeSentryDetailContinuation(continuation);
  if (frontier === null || frontier.limit !== limit) return Object.freeze({ ok: false as const });
  return Object.freeze({
    ok: true as const,
    position: Object.freeze({ cursor: frontier.cursor, probe: frontier.probe }),
  });
}

/**
 * Projects one walk position into the two published members the panel reads.
 *
 * They are deliberately separate: a continuation says "there is more, ask for
 * it", while `incomplete` says "this walk stopped without reaching the end". A
 * page that ends the walk carries neither. Folding the second into the absence
 * of the first is what let a truncated list render as a complete one.
 */
function projectWalkPosition(
  nextPage: SentryNextPageV1,
  limit: number,
): Readonly<{ continuation?: string; incomplete?: SentryDetailIncompleteReasonV1 }> {
  if (nextPage.kind === 'stoppedShort') return { incomplete: nextPage.reason };
  if (nextPage.kind === 'end') return {};
  const continuation = encodeSentryDetailContinuation({
    v: 1,
    cursor: nextPage.walk.cursor,
    limit,
    probe: nextPage.walk.probe,
  });
  // The walk is open and the provider's cursor is intact; this source simply
  // failed to serialize the frontier, so this page is the last one this panel
  // can ask for. Calling that a malformed cursor would blame the provider for a
  // failure this side owns.
  return continuation === null
    ? { incomplete: 'continuationUnavailable' as const }
    : { continuation };
}

/**
 * One public issue read, projected to exactly the arm the caller named.
 *
 * The arms differ in lifetime and privacy tier, not in the request: `overview`
 * is the Tier-A summary the detail root holds, while `tags` and `activity` are
 * Tier-B content that exists only inside the panel that asked for it.
 */
export async function readSentryIssue(
  input: unknown,
  context: PluginInvocationContext,
): Promise<SentryReadIssueResultV1> {
  const parsed = SentryReadIssueInputV1Schema.parse(input);

  const bounded = createBoundedInvocation({
    callerSignal: context.signal,
  });
  try {
    const routed = admitSentryEntryInvocation({
      localInstanceKey: parsed.instance.localInstanceKey,
      configurationToken: parsed.instance.configuration.token,
      localRef: parsed.localRef,
    });
    if (!routed.ok) {
      return Object.freeze({ kind: 'unavailable' as const, failure: routed.failure });
    }

    const client = await createSentryApiClient(context, {
      account: parsed.instance.binding.account,
      deployment: routed.deployment,
      nowMs: () => Date.now(),
      signal: bounded.signal,
    });
    const read = await readSentryIssueProjection(client, {
      instance: routed.instance,
      entryId: parsed.localRef.entryId,
      projection: parsed.projection,
      nowMs: Date.now(),
    });
    if (!read.ok) {
      return Object.freeze({
        kind: 'unavailable' as const,
        failure: toTriageFailure(read.failure),
      });
    }
    return fitSentryReadIssueResult(read.value);
  } finally {
    bounded.dispose();
  }
}

/** One bounded page of the retained events for one issue. */
export async function listSentryIssueEvents(
  input: unknown,
  context: PluginInvocationContext,
): Promise<SentryIssueEventsResultV1> {
  const parsed = SentryIssueEventsInputV1Schema.parse(input);

  const bounded = createBoundedInvocation({
    callerSignal: context.signal,
  });
  try {
    const routed = admitSentryEntryInvocation({
      localInstanceKey: parsed.instance.localInstanceKey,
      configurationToken: parsed.instance.configuration.token,
      localRef: parsed.localRef,
    });
    if (!routed.ok) {
      return Object.freeze({ kind: 'unavailable' as const, failure: routed.failure });
    }

    const walk = resolveWalkPosition(parsed.continuation, parsed.limit);
    if (!walk.ok) {
      return Object.freeze({
        kind: 'unavailable' as const,
        failure: toTriageFailure(CONTINUATION_UNREADABLE),
      });
    }

    const client = await createSentryApiClient(context, {
      account: parsed.instance.binding.account,
      deployment: routed.deployment,
      nowMs: () => Date.now(),
      signal: bounded.signal,
    });
    const page = await readSentryIssueEventsPage(client, {
      instance: routed.instance,
      entryId: parsed.localRef.entryId,
      limit: parsed.limit,
      position: walk.position,
      nowMs: Date.now(),
    });
    if (!page.ok) {
      return Object.freeze({
        kind: 'unavailable' as const,
        failure: toTriageFailure(page.failure),
      });
    }

    const position = projectWalkPosition(page.value.nextPage, parsed.limit);
    return fitActionResultPageV1(
      page.value.rows,
      position.continuation,
      (rows, omittedCount, continuation, continuationOmitted) => Object.freeze({
        kind: 'events' as const,
        rows: Object.freeze([...rows]),
        omittedRowCount: page.value.omittedRowCount + omittedCount,
        projectionTruncated: page.value.projectionTruncated || omittedCount > 0,
        ...(continuationOmitted
          ? { incomplete: 'continuationUnavailable' as const }
          : continuation === undefined
            ? position
            : { continuation }),
      }),
    ).result;
  } finally {
    bounded.dispose();
  }
}

/** One bounded page of the value distribution of a single tag key. */
export async function listSentryTagValues(
  input: unknown,
  context: PluginInvocationContext,
): Promise<SentryTagValuesResultV1> {
  const parsed = SentryTagValuesInputV1Schema.parse(input);

  const bounded = createBoundedInvocation({
    callerSignal: context.signal,
  });
  try {
    const routed = admitSentryEntryInvocation({
      localInstanceKey: parsed.instance.localInstanceKey,
      configurationToken: parsed.instance.configuration.token,
      localRef: parsed.localRef,
    });
    if (!routed.ok) {
      return Object.freeze({ kind: 'unavailable' as const, failure: routed.failure });
    }

    const walk = resolveWalkPosition(parsed.continuation, parsed.limit);
    if (!walk.ok) {
      return Object.freeze({
        kind: 'unavailable' as const,
        failure: toTriageFailure(CONTINUATION_UNREADABLE),
      });
    }

    const client = await createSentryApiClient(context, {
      account: parsed.instance.binding.account,
      deployment: routed.deployment,
      nowMs: () => Date.now(),
      signal: bounded.signal,
    });
    const page = await readSentryTagValuesPage(client, {
      instance: routed.instance,
      entryId: parsed.localRef.entryId,
      tagKey: parsed.tagKey,
      limit: parsed.limit,
      position: walk.position,
      nowMs: Date.now(),
    });
    if (!page.ok) {
      return Object.freeze({
        kind: 'unavailable' as const,
        failure: toTriageFailure(page.failure),
      });
    }

    const position = projectWalkPosition(page.value.nextPage, parsed.limit);
    return fitActionResultPageV1(
      page.value.rows,
      position.continuation,
      (rows, omittedCount, continuation, continuationOmitted) => Object.freeze({
        kind: 'tagValues' as const,
        tagKey: parsed.tagKey,
        rows: Object.freeze([...rows]),
        omittedRowCount: page.value.omittedRowCount + omittedCount,
        projectionTruncated: page.value.projectionTruncated || omittedCount > 0,
        ...(continuationOmitted
          ? { incomplete: 'continuationUnavailable' as const }
          : continuation === undefined
            ? position
            : { continuation }),
      }),
    ).result;
  } finally {
    bounded.dispose();
  }
}

/**
 * One occurrence of one issue, projected through the redaction owner.
 *
 * It is the only operation that touches a whole event body, and the only one whose
 * result carries Tier-B/C content. Its lifetime belongs to the detail-root selected-event
 * controller, not to a panel: Overview, an explicitly revealed occurrence detail and
 * Stack Trace all read this one projection, so the exact detail instance rather than a
 * tab mount is the privacy boundary (`SENTRY.md` §7.2a).
 */
export async function readSentryEvent(
  input: unknown,
  context: PluginInvocationContext,
): Promise<SentryReadEventResultV1> {
  const parsed = SentryReadEventInputV1Schema.parse(input);

  const bounded = createBoundedInvocation({
    callerSignal: context.signal,
  });
  try {
    const routed = admitSentryEntryInvocation({
      localInstanceKey: parsed.instance.localInstanceKey,
      configurationToken: parsed.instance.configuration.token,
      localRef: parsed.localRef,
    });
    if (!routed.ok) {
      return Object.freeze({ kind: 'unavailable' as const, failure: routed.failure });
    }

    const client = await createSentryApiClient(context, {
      account: parsed.instance.binding.account,
      deployment: routed.deployment,
      nowMs: () => Date.now(),
      signal: bounded.signal,
    });
    const read = await readSentryEventProjection(client, {
      instance: routed.instance,
      entryId: parsed.localRef.entryId,
      selector: parsed.selector,
      nowMs: Date.now(),
    });
    if (!read.ok) {
      return Object.freeze({
        kind: 'unavailable' as const,
        failure: toTriageFailure(read.failure),
      });
    }
    return fitSentryEventResult(read.value);
  } finally {
    bounded.dispose();
  }
}
