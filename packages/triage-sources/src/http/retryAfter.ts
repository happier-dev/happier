import { parseRetryAfterValue } from '@happier-dev/plugin-sdk/connected-accounts';

/**
 * Parses RFC 9110 `Retry-After` syntax shared by providers that attach no other
 * reset-header precedence or provider policy to the value.
 *
 * The result is the provider-stated absolute instant. This owner neither caps it
 * nor invents a fallback when the header is absent or malformed.
 */
export function parseRetryAfterNotBeforeMsV1(
  raw: string | null,
  nowMs: number,
): number | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;

  const evidence = parseRetryAfterValue(value);
  if (/^\d+$/u.test(value)) {
    const seconds = evidence.seconds;
    if (seconds === null || !Number.isSafeInteger(seconds)) return null;
    const retryNotBeforeMs = nowMs + seconds * 1_000;
    return Number.isSafeInteger(retryNotBeforeMs) ? retryNotBeforeMs : null;
  }

  // HTTP-date begins with a weekday. This prevents permissive `Date.parse`
  // from turning malformed numeric-looking values such as `-5` into dates.
  if (!/^[A-Za-z]/u.test(value)) return null;
  const retryNotBeforeMs = evidence.dateMs;
  return retryNotBeforeMs !== null && retryNotBeforeMs >= nowMs
    ? retryNotBeforeMs
    : null;
}
