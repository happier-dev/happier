/**
 * Canonical URL-value redaction for browser diagnostics/automation egress (RU2 capstone L2-3/L2-5).
 *
 * THE single owner for stripping secret-bearing parts out of URL-shaped string VALUES before they
 * reach an agent timeline, an agent context, or a remote snapshot:
 * - query strings and fragments are always dropped (token values live there),
 * - token-shaped PATH segments (e.g. `/reset/<token>`, UUIDs, JWTs, long hex ids) are replaced
 *   with `:redacted` — key-name matching (`url`, `href`, …) is explicitly NOT the gating
 *   condition anywhere; callers classify by value shape.
 *
 * The injected-page collector (`apps/ui/.../diagnostics/injectedPage.ts` `sanitizeUrl`) runs in
 * the page realm and cannot import this module; it carries a hand-mirrored vanilla-JS copy kept
 * in lockstep by a parity test over `SANITIZE_URL_PARITY_VECTORS`. Change the behavior here and
 * the blob together, never one side alone.
 */

const REDACTED_PATH_SEGMENT = ':redacted';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERCENT_ESCAPE_PATTERN = /%[0-9a-f]{2}/iu;
const INLINE_URL_PATTERN = /(?:https?|wss?):\/\/[^\s"'<>()[\]{}\\]+/giu;
const EMBEDDED_ENCODED_WEB_URL_PATTERN = /(?:https?|wss?)%3A%2F%2F[^\s"'<>()[\]{}\\]+/giu;

// Whole-value non-web schemes that must collapse to the scheme alone: each can smuggle secrets
// in its body (data/blob payloads, javascript source, mailto/tel identities, filesystem paths).
const SCHEME_ONLY_VALUE_PATTERN = /^(?:data|javascript|vbscript|blob|filesystem|file|ftp|mailto|tel|sms|intent|chrome|chrome-extension|about):/iu;

function isTokenShapedChunk(chunk: string): boolean {
  if (chunk.length >= 20 && /^[0-9a-f]+$/i.test(chunk)) return true;
  if (chunk.length >= 16 && /^[0-9]+$/.test(chunk)) return true;
  return chunk.length >= 12
    && /^[A-Za-z0-9_~+=%]+$/.test(chunk)
    && /[0-9]/.test(chunk)
    && /[A-Za-z]/.test(chunk);
}

/**
 * True when a single path segment looks like a credential/token rather than a human-readable
 * slug. Shape-based on purpose (L2-3 acceptance): UUIDs, JWT-like triples, long hex/digit runs,
 * and mixed alphanumeric chunks ≥12 chars. Hyphen/dot/underscore-separated chunks are tested
 * individually so date-and-word slugs (`2026-07-08-release-notes`) survive while
 * `sk_live_<random>` does not. Over-redaction is the safe direction at egress.
 */
export function isSensitiveUrlPathSegment(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Keep the raw segment; a malformed escape is still checked by shape below.
  }
  if (UUID_PATTERN.test(decoded)) return true;
  return decoded.split(/[-._]/).some(isTokenShapedChunk);
}

/**
 * Replace token-shaped segments of a URL path with `:redacted`, preserving the path structure so
 * diagnostics stay navigable (`/reset/:redacted` instead of `/`).
 */
export function redactSensitiveUrlPathSegments(pathname: string): string {
  if (!pathname) return pathname;
  return pathname
    .split('/')
    .map((segment) => (segment && isSensitiveUrlPathSegment(segment) ? REDACTED_PATH_SEGMENT : segment))
    .join('/');
}

function decodePercentEncodedValue(value: string): string | null {
  if (!PERCENT_ESCAPE_PATTERN.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded === value ? null : decoded;
  } catch {
    return null;
  }
}

function decodedValueLooksUrlShaped(decoded: string): boolean {
  return /^(?:https?|wss?):\/\//iu.test(decoded)
    || SCHEME_ONLY_VALUE_PATTERN.test(decoded)
    || decoded.startsWith('/')
    || decoded.includes('/');
}

function decodeWholeUrlShapedValue(value: string): string | null {
  const decoded = decodePercentEncodedValue(value);
  return decoded && decodedValueLooksUrlShaped(decoded) ? decoded : null;
}

/**
 * Reduce a URL-shaped string to a value safe for agent/remote egress:
 * - web URLs (http/https/ws/wss) → origin + token-redacted pathname (no query/fragment ever),
 * - other schemes (data:, javascript:, …) → the scheme alone,
 * - rooted paths → token-redacted pathname,
 * - anything else → best effort: query/fragment stripped, token-shaped chunks redacted.
 *
 * Moved from `apps/ui/.../diagnostics/redaction.ts` (the split-brain the RU2 audit flagged) and
 * extended with sensitive-path-segment redaction; the UI and the injected blob now follow this
 * owner.
 */
export function stripBrowserDiagnosticUrlValues(value: string): string {
  const decoded = decodeWholeUrlShapedValue(value);
  if (decoded) return stripBrowserDiagnosticUrlValues(decoded);

  const schemeMatch = value.match(/^([a-zA-Z][a-zA-Z\d+.-]*:)/u);
  try {
    if (schemeMatch) {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        return parsed.protocol;
      }
      return `${parsed.origin}${redactSensitiveUrlPathSegments(parsed.pathname)}`;
    }
    if (value.startsWith('/')) {
      return redactSensitiveUrlPathSegments(new URL(value, 'https://happier.invalid').pathname);
    }
  } catch {
    if (schemeMatch) return schemeMatch[1];
    return redactSensitiveUrlPathSegments(value.split(/[?#]/u)[0] ?? value);
  }
  return redactSensitiveUrlPathSegments(value.split(/[?#]/u)[0] ?? value);
}

/**
 * Redact URL-shaped content inside an ARBITRARY string value, regardless of the key it sits
 * under. Prose stays readable; every inline URL is reduced via
 * `stripBrowserDiagnosticUrlValues`; a whole value carrying a secret-capable non-web scheme is
 * reduced to its scheme. This is the value-shape classifier the automation timeline/result
 * redactors apply to every string (L2-3: key-name matching is insufficient by design).
 */
export function stripUrlValuesInString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length > 0 && !/\s/u.test(trimmed)) {
    const schemeOnly = trimmed.match(SCHEME_ONLY_VALUE_PATTERN);
    if (schemeOnly) {
      const colonIndex = trimmed.indexOf(':');
      return trimmed.slice(0, colonIndex + 1);
    }
    const decoded = decodeWholeUrlShapedValue(trimmed);
    if (decoded) {
      return stripBrowserDiagnosticUrlValues(decoded);
    }
    if (/^(?:https?|wss?):\/\//iu.test(trimmed)) {
      return stripBrowserDiagnosticUrlValues(trimmed);
    }
    if (trimmed.startsWith('/')) {
      return stripBrowserDiagnosticUrlValues(trimmed);
    }
    if (trimmed.includes('/')) {
      return stripBrowserDiagnosticUrlValues(trimmed);
    }
  }
  return value
    .replace(INLINE_URL_PATTERN, (match) => stripBrowserDiagnosticUrlValues(match))
    .replace(EMBEDDED_ENCODED_WEB_URL_PATTERN, (match) => stripBrowserDiagnosticUrlValues(match));
}

/**
 * Shared parity vectors between this owner and the injected-page blob's `sanitizeUrl`. The UI
 * parity test feeds each input to both implementations and requires identical output, so the
 * hand-mirrored vanilla copy cannot drift (RU2 capstone L2-5).
 */
export const SANITIZE_URL_PARITY_VECTORS: readonly string[] = [
  'https://app.example.test/reset/tok9f8e7d6c5b4a3210ffeeddcc?token=sk_live_secret&page=2',
  'https%3A%2F%2Fapp.example.test%2Freset%2Ftok9f8e7d6c5b4a3210ffeeddcc%3Ftoken%3Dsk_live_secret%26page%3D2',
  'https://app.example.test/settings/profile',
  'https://app.example.test/confirm/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.sig#frag',
  'https://app.example.test/users/123e4567-e89b-42d3-a456-426614174000/detail',
  'http://localhost:3000/',
  'wss://relay.example.test/socket?auth=SECRET',
  'data:text/html;base64,SGVsbG8=',
  'javascript:void(0)',
  'mailto:user@example.test',
  '/reset/tok9f8e7d6c5b4a3210ffeeddcc?x=1',
  '/settings/profile',
  'example.test/reset/tok9f8e7d6c5b4a3210ffeeddcc?x=1',
  'not a url at all',
  '',
];
