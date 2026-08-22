/**
 * RFC 8288 `Link` header parsing, shared by the forge sources whose APIs paginate that
 * way.
 *
 * The header is a provider-published standard rather than a per-forge rule, so it is
 * parsed once. What the parsed `next` means, and whether it may be followed, stays with
 * each source: this module resolves no URL, admits no origin, and asserts nothing about
 * pagination geometry.
 *
 * `link-value`s are separated only by the commas BETWEEN them, so the split looks ahead
 * for the next `<`. Splitting on every comma loses a next page whose URL carries a
 * literal comma in its query.
 */

const LINK_VALUE_SEPARATOR = /,(?=\s*<)/u;
const LINK_VALUE = /^\s*<([^>]+)>\s*;\s*(.+)$/u;
const REL_PARAMETER = /(?:^|;)\s*rel\s*=\s*"?([^";]+)"?/u;

/** Parses one `Link` header value into its lower-cased `rel` → URL map. */
export function parseForgeLinkHeader(
  value: string | null | undefined,
): Readonly<Record<string, string>> {
  if (value === undefined || value === null || value === '') return Object.freeze({});

  const links: Record<string, string> = {};
  for (const section of value.split(LINK_VALUE_SEPARATOR)) {
    const linkValue = LINK_VALUE.exec(section);
    if (linkValue === null) continue;
    const url = linkValue[1]?.trim();
    const parameters = linkValue[2];
    if (url === undefined || url === '' || parameters === undefined) continue;
    const rel = REL_PARAMETER.exec(parameters)?.[1]?.trim().toLowerCase();
    if (rel === undefined || rel === '') continue;
    // First occurrence wins: a duplicated rel is a malformed header, not an invitation
    // to prefer the later value.
    if (!(rel in links)) links[rel] = url;
  }
  return Object.freeze(links);
}

/** Reads the `Link` response header under any casing, trimmed, or `null`. */
export function readForgeLinkHeaderValue(
  headers: Readonly<Record<string, string>>,
): string | null {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'link');
  const value = entry?.[1]?.trim();
  return value === undefined || value === '' ? null : value;
}
