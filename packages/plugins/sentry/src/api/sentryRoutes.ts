/**
 * The one owner of every Sentry route this source addresses by template.
 *
 * A route is where an identity becomes a request, so it is the last place a
 * caller-supplied value can still escape the resource it was meant to name. All
 * three templates therefore validate before they interpolate: the deployment
 * origin must already be the canonical normalized one the configured instance
 * encodes, the organization and issue ids must be the provider's immutable
 * numeric ids, and a tag key must be one path segment and nothing else. A value
 * that fails throws rather than producing a URL that addresses something the
 * caller did not name.
 *
 * The scan's own query string keeps its dedicated owner (`sentryScanQuery.ts`);
 * that module consumes the same routability assertion rather than restating it,
 * so there is exactly one rule for what makes an instance addressable.
 */

import { normalizeSentryOrigin } from '../auth/sentryOrigin.js';
import {
  isSentryNumericId,
  type SentryInvokedInstanceV1,
} from '../instances/sentryCollisionScope.js';

/**
 * `[SCHEMA]` the issue-events and tag-values collections both cap `per_page` at
 * 100. It is a provider ceiling, not a source preference.
 */
export const SENTRY_MAX_DETAIL_PAGE_SIZE = 100;

/**
 * The window every detail collection is read over.
 *
 * `[SOURCE]` `api/utils.py` `MAX_STATS_PERIOD = timedelta(days=90)` — the same
 * ceiling the scan declares, stated here too rather than inherited, so an
 * occurrence list and a scan row describe the same window.
 */
export const SENTRY_DETAIL_STATS_PERIOD = '90d';

/**
 * A Sentry tag key that is safe as exactly one path segment.
 *
 * Sentry's own keys are dotted, colon-namespaced or underscored words
 * (`browser.name`, `sentry:user`, `server_name`). Anything carrying a slash,
 * whitespace, or a traversal sequence is refused outright instead of being
 * escaped into something that still addresses another resource after a proxy
 * or server normalizes the path.
 */
const SENTRY_TAG_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/u;

/**
 * Confirms one configured instance can address the provider at all, and returns
 * its canonical origin.
 */
export function assertRoutableSentryInstance(instance: SentryInvokedInstanceV1): string {
  const normalized = normalizeSentryOrigin(instance.deploymentOrigin);
  if (!normalized.ok || normalized.origin !== instance.deploymentOrigin) {
    throw new Error('A Sentry route requires an already-normalized canonical deployment origin.');
  }
  if (!isSentryNumericId(instance.organizationId)) {
    throw new Error('A Sentry route requires the immutable numeric organization id.');
  }
  return normalized.origin;
}

function assertEntryId(entryId: string): string {
  if (!isSentryNumericId(entryId)) {
    throw new Error('A Sentry issue route requires the immutable numeric issue id.');
  }
  return entryId;
}

function assertPageSize(perPage: number): number {
  if (
    !Number.isSafeInteger(perPage)
    || perPage < 1
    || perPage > SENTRY_MAX_DETAIL_PAGE_SIZE
  ) {
    throw new Error('A Sentry detail page size must be an integer within the provider ceiling.');
  }
  return perPage;
}

function issueBasePath(instance: SentryInvokedInstanceV1, entryId: string): string {
  return `/api/0/organizations/${instance.organizationId}/issues/${assertEntryId(entryId)}/`;
}

export type SentryIssueRouteInputV1 = Readonly<{
  instance: SentryInvokedInstanceV1;
  entryId: string;
}>;

/** The one public issue resource, which every detail projection is read from. */
export function buildSentryIssueUrl(input: SentryIssueRouteInputV1): string {
  const origin = assertRoutableSentryInstance(input.instance);
  return new URL(issueBasePath(input.instance, input.entryId), origin).toString();
}

export type SentryIssueEventsRouteInputV1 = SentryIssueRouteInputV1 & Readonly<{
  perPage: number;
  /** Taken verbatim from a validated `rel="next"` link; never composed here. */
  cursor?: string;
}>;

/**
 * The retained-events collection for one issue.
 *
 * `full=false` is explicit and load-bearing: the full form embeds each event's
 * whole body, which is the single largest PII surface this source can touch
 * (`SENTRY.md` §8.1). A list read has no use for it, so it is never requested.
 */
export function buildSentryIssueEventsUrl(input: SentryIssueEventsRouteInputV1): string {
  const origin = assertRoutableSentryInstance(input.instance);
  const url = new URL(`${issueBasePath(input.instance, input.entryId)}events/`, origin);
  url.searchParams.set('per_page', String(assertPageSize(input.perPage)));
  url.searchParams.set('full', 'false');
  url.searchParams.set('statsPeriod', SENTRY_DETAIL_STATS_PERIOD);
  if (input.cursor !== undefined) url.searchParams.set('cursor', input.cursor);
  return url.toString();
}

/**
 * Which occurrence of an issue a single-event read addresses.
 *
 * `representative` is Sentry's own `recommended` selector — the word the
 * provider uses, kept out of the caller's vocabulary so no surface can label it
 * "latest" (`SENTRY.md` §7.3).
 */
export type SentryEventSelectorV1 =
  | Readonly<{ kind: 'representative' }>
  | Readonly<{ kind: 'event'; eventId: string }>;

/**
 * `[SCHEMA]` an `eventID` is a 32-character lowercase hex identifier.
 *
 * `[INFERRED]` the published `event_id` path parameter declares the enum
 * `["latest","oldest","recommended"]` while its own description says "The ID of
 * the event to retrieve, or …", so a concrete id is accepted and the generated
 * enum must not be validated against. Validating the id's shape here is what
 * replaces that: the selector is still the last place a caller-supplied value
 * could address a resource nobody named.
 */
const SENTRY_EVENT_ID_PATTERN = /^[0-9a-f]{32}$/u;

export type SentryIssueEventRouteInputV1 = SentryIssueRouteInputV1 & Readonly<{
  selector: SentryEventSelectorV1;
}>;

/**
 * One occurrence of one issue.
 *
 * No query string at all: `llmFormat` is the only parameter this route offers
 * beyond the selector, and this source never asks Sentry to format an event for
 * a model (`SENTRY.md` §8.5).
 */
export function buildSentryIssueEventUrl(input: SentryIssueEventRouteInputV1): string {
  const origin = assertRoutableSentryInstance(input.instance);
  const segment = input.selector.kind === 'representative'
    ? 'recommended'
    : input.selector.eventId;
  if (input.selector.kind === 'event' && !SENTRY_EVENT_ID_PATTERN.test(segment)) {
    throw new Error('A Sentry event route requires one provider event identifier.');
  }
  return new URL(
    `${issueBasePath(input.instance, input.entryId)}events/${segment}/`,
    origin,
  ).toString();
}

export type SentryTagValuesRouteInputV1 = SentryIssueRouteInputV1 & Readonly<{
  tagKey: string;
  perPage: number;
  cursor?: string;
}>;

/** The value distribution of one tag key on one issue. */
export function buildSentryTagValuesUrl(input: SentryTagValuesRouteInputV1): string {
  const origin = assertRoutableSentryInstance(input.instance);
  if (!SENTRY_TAG_KEY_PATTERN.test(input.tagKey)) {
    throw new Error('A Sentry tag-values route requires a single-segment provider tag key.');
  }
  const url = new URL(
    `${issueBasePath(input.instance, input.entryId)}tags/`
    + `${encodeURIComponent(input.tagKey)}/values/`,
    origin,
  );
  url.searchParams.set('per_page', String(assertPageSize(input.perPage)));
  if (input.cursor !== undefined) url.searchParams.set('cursor', input.cursor);
  return url.toString();
}

/** `true` when a tag key is addressable, for a projector that must drop the rest. */
export function isSentryRoutableTagKey(tagKey: string): boolean {
  return SENTRY_TAG_KEY_PATTERN.test(tagKey);
}
