/**
 * Is this hostname the local machine?
 *
 * **The question this answers: can another device reach a URL on this host?**
 * Its correctness criterion is being accurate about networking — it should
 * classify exactly the addresses that resolve back to the machine reading them.
 *
 * It is NOT the answer to "are these two URLs the same server?". That is
 * `createServerUrlComparableKey` in `./serverUrlComparableKey.ts`, and the two
 * deliberately disagree: `127.0.0.2` is loopback (no other device can reach it)
 * yet is a *different server* from `localhost`, because the identity key is
 * persisted and gates which stored credentials a machine may use. Widening one
 * to match the other merges those credential scopes. Keep them apart.
 *
 * One owner, because getting it wrong is quiet and consequential: a relay URL
 * misclassified as remote is embedded into mobile QR and deep links that cannot
 * work, and one misclassified as local suppresses the warning that would have
 * told the user their phone cannot reach it.
 *
 * Two parsing details cause almost every miss:
 *
 * - `new URL('http://[::1]:3005').hostname` returns `"[::1]"`, brackets and all,
 *   so a raw `=== '::1'` comparison never matches.
 * - a fully qualified name may carry a trailing dot (`localhost.`), which is the
 *   same host.
 *
 * Loopback is the whole `127.0.0.0/8` range, not just `127.0.0.1`, and RFC 6761
 * reserves the entire `.localhost` TLD.
 *
 * Deliberately excluded: `0.0.0.0`. It is not loopback — it means "every
 * interface". Callers for whom an all-interfaces bind is also unusable as a
 * remote address say so themselves, at their own call site.
 */

function stripBrackets(hostname: string): string {
  const host = hostname.trim();
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

function isIpv4LoopbackAddress(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d{1,3}$/u.test(part))) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}

export function normalizeHostnameForLoopbackCheck(hostname: string): string {
  return stripBrackets(String(hostname ?? '').trim().toLowerCase()).replace(/\.$/u, '');
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostnameForLoopbackCheck(hostname);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  return isIpv4LoopbackAddress(host);
}
