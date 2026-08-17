/**
 * Sentry's cursor pagination is carried entirely by an RFC-style `Link` header.
 * `[DOC]` https://docs.sentry.io/api/pagination/ — cursors are returned for both
 * directions even when a page is empty, and the walk terminates when the
 * `rel="next"` relation carries `results="false"`.
 *
 * The absence of the header is reported as its own state: for the request shapes
 * this source builds, first-party Sentry always writes `Link`, so a missing one
 * means an intermediary rewrote the response — never that the walk finished.
 */

export type SentryLinkRelationV1 = Readonly<{
  url: string;
  /** The `cursor` link parameter, or the `cursor` query value of the URL. */
  cursor: string | null;
  /** `results="true"` — the provider says the pointed-at page has rows. */
  hasResults: boolean;
}>;

export type SentryLinkHeaderV1 =
  | Readonly<{ present: false }>
  | Readonly<{
    present: true;
    next: SentryLinkRelationV1 | null;
    previous: SentryLinkRelationV1 | null;
  }>;

const LINK_ENTRY_PATTERN = /<([^>]*)>([^,<]*)/gu;
const LINK_PARAMETER_PATTERN = /;\s*([A-Za-z0-9_-]+)\s*=\s*("[^"]*"|[^;,\s]*)/gu;

function readHeaderCaseInsensitive(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1)
    : value;
}

function readCursorFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get('cursor');
  } catch {
    return null;
  }
}

function parseRelation(url: string, parameterText: string): {
  rel: string | null;
  relation: SentryLinkRelationV1;
} {
  let rel: string | null = null;
  let cursor: string | null = null;
  let results: string | null = null;

  LINK_PARAMETER_PATTERN.lastIndex = 0;
  for (
    let match = LINK_PARAMETER_PATTERN.exec(parameterText);
    match !== null;
    match = LINK_PARAMETER_PATTERN.exec(parameterText)
  ) {
    const key = match[1]?.toLowerCase() ?? '';
    const value = unquote(match[2] ?? '');
    if (key === 'rel') rel = value.toLowerCase();
    else if (key === 'cursor') cursor = value;
    else if (key === 'results') results = value.toLowerCase();
  }

  return {
    rel,
    relation: {
      url,
      cursor: cursor ?? readCursorFromUrl(url),
      hasResults: results === 'true',
    },
  };
}

export function parseSentryLinkHeader(
  headers: Readonly<Record<string, string>>,
): SentryLinkHeaderV1 {
  const raw = readHeaderCaseInsensitive(headers, 'link');
  if (raw === undefined) return Object.freeze({ present: false as const });

  let next: SentryLinkRelationV1 | null = null;
  let previous: SentryLinkRelationV1 | null = null;

  LINK_ENTRY_PATTERN.lastIndex = 0;
  for (
    let match = LINK_ENTRY_PATTERN.exec(raw);
    match !== null;
    match = LINK_ENTRY_PATTERN.exec(raw)
  ) {
    const { rel, relation } = parseRelation(match[1] ?? '', match[2] ?? '');
    if (rel === 'next' && next === null) next = Object.freeze(relation);
    else if (rel === 'previous' && previous === null) previous = Object.freeze(relation);
  }

  return Object.freeze({ present: true as const, next, previous });
}
