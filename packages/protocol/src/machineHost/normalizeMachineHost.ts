/**
 * Normalize a machine hostname so semantically-equivalent values compare equal
 * across the surfaces that produce them.
 *
 * The values we have to reconcile in practice:
 * - `os.hostname()` on macOS often returns `name.local` (Bonjour suffix).
 * - `os.hostname()` on a corporate-domain Windows/Linux box can return
 *   `name.<corp>.<tld>`.
 * - The session metadata's `host` field is whatever the daemon recorded at
 *   spawn time, which is also `os.hostname()` of *that* run — same drift.
 * - User-facing displays like `host: 'leeroy-mbp'` come straight off the
 *   server-side raw session row, also unprocessed.
 *
 * Treating these as equal is required for the CLI to recognise "this session
 * is on this machine" without false negatives. `mbp.local` and `mbp` must
 * compare equal; `MBP` and `mbp` must compare equal.
 *
 * Returns an empty string for null/undefined/blank inputs so callers can
 * use plain `===` comparisons.
 */
const KNOWN_LAN_DOMAIN_SUFFIXES = ['.local', '.lan', '.localdomain'];

export function normalizeMachineHost(value: string | null | undefined): string {
  const trimmed = String(value ?? '').trim().toLowerCase();
  if (!trimmed) return '';
  for (const suffix of KNOWN_LAN_DOMAIN_SUFFIXES) {
    if (trimmed.endsWith(suffix)) {
      return trimmed.slice(0, -suffix.length);
    }
  }
  return trimmed;
}

/**
 * Compare two hostnames after normalisation. Returns false for any pair where
 * either input normalises to an empty string — there's no meaningful identity
 * for "machine without a name", so we err on the side of "not the same".
 */
export function compareMachineHosts(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeMachineHost(a);
  const right = normalizeMachineHost(b);
  if (!left || !right) return false;
  return left === right;
}
