/**
 * The mutable display-and-routing locator (`SENTRY.md` §2.4c).
 *
 * Every field is replaced wholesale on each observation and is never read back
 * as a key. **No `routingToken` is emitted**: the configured-instance carrier
 * already binds the exact account, the origin-bearing `localInstanceKey` and the
 * configuration, so a second routing authority could only go stale.
 */

import {
  normalizeTriageSingleLineV1,
  projectTriageDisplayTextV1,
} from '@happier-dev/triage-protocol/v1';

import {
  SENTRY_DISPLAY_PATH_SEPARATOR,
  SENTRY_MAX_LOCATION_UTF8_BYTES,
  SENTRY_MAX_TEXT_UTF8_BYTES,
} from '../sentryContracts.js';

export type SentryLocatorInputV1 = Readonly<{
  /** `[SCHEMA]` `permalink`, used verbatim when it is a usable http(s) URL. */
  permalink: string | null | undefined;
  organizationSlug: string | null | undefined;
  projectSlug: string | null | undefined;
  shortId: string | null | undefined;
  deploymentOrigin: string;
  organizationId: string;
  entryId: string;
}>;

export type SentryLocatorV1 = Readonly<{
  /** `null` when no destination could be published within the location bound. */
  webUrl: string | null;
  displayPath: string;
  /** True when a locator value was shortened or omitted to satisfy a published bound. */
  truncated: boolean;
}>;

function usablePermalink(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * A destination is emitted whole or not at all.
 *
 * Shortening a URL produces a different destination and normalizing one silently rewrites
 * it, so a value that is not already a bounded V1 single-line string is omitted rather
 * than repaired. Both ceilings are read from the published owner, because the target
 * rejects an over-bound or control-bearing result ATOMICALLY: one long provider permalink
 * would otherwise discard every sibling row on the same scan page. `URL` accepts an
 * embedded tab or newline and drops it while parsing, so a raw permalink really can carry
 * one past the parse above, and Sentry publishes no length ceiling for the field at all.
 */
function fittingLocation(value: string): string | null {
  if (value === '' || value !== normalizeTriageSingleLineV1(value)) return null;
  return new TextEncoder().encode(value).byteLength > SENTRY_MAX_LOCATION_UTF8_BYTES
    ? null
    : value;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function buildSentryLocator(input: SentryLocatorInputV1): SentryLocatorV1 {
  const organizationSlug = nonEmpty(input.organizationSlug);
  const projectSlug = nonEmpty(input.projectSlug);
  const shortId = nonEmpty(input.shortId);

  // Sentry's own organization-scoped issue route is the fallback when the
  // provider gave no usable permalink; it is built from the configured origin,
  // never from response data.
  const fallbackPath = organizationSlug === null
    ? `${input.deploymentOrigin}/organizations/${input.organizationId}/issues/${input.entryId}/`
    : `${input.deploymentOrigin}/organizations/${organizationSlug}/issues/${input.entryId}/`;

  const pathHead = [organizationSlug, projectSlug].filter((part) => part !== null).join('/');

  // A permalink this source cannot publish falls back to its own composed route before the
  // field is abandoned: the entry keeps a usable destination wherever one is expressible.
  const permalink = usablePermalink(input.permalink);
  const webUrl = (permalink === null ? null : fittingLocation(permalink))
    ?? fittingLocation(fallbackPath);
  // The display path is built from provider slugs and a provider short id, none of which
  // this source gets to limit, so it is projected like every other V1 display string:
  // normalized to one line and shortened rather than dropped.
  const displayPath = projectTriageDisplayTextV1(
    `${pathHead}${SENTRY_DISPLAY_PATH_SEPARATOR}${shortId ?? input.entryId}`,
    SENTRY_MAX_TEXT_UTF8_BYTES,
  );

  return Object.freeze({
    webUrl,
    displayPath: displayPath.value,
    truncated: displayPath.truncated || webUrl === null,
  });
}
