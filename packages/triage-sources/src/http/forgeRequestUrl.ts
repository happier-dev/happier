/**
 * The one admission gate for an absolute URL a forge source did not build itself.
 *
 * Every forge source reaches at least one URL it was handed rather than composed: a
 * provider `Link` header, a paging envelope's `next`, a redirect target, or a
 * continuation the target copied back. Each of those would otherwise send the
 * binding's materialized credential to whatever host the string names, and answer the
 * user's list from that host's reply. The rule is identical for every forge, so it is
 * enforced once here rather than reimplemented per source — a second copy is how one
 * of the paths quietly loses the check.
 *
 * The admitted candidate is returned VERBATIM. Re-serializing it would change bytes a
 * forge signed into a keyset cursor, and a URL is validated in order to be sent
 * unchanged, not to be rebuilt.
 */

/**
 * Admits `candidate` only when it is an absolute `https` URL on the exact origin of
 * `authorizedBaseUrl`, under that base URL's path, carrying no userinfo and no
 * fragment.
 *
 * `authorizedBaseUrl` is the full base a binding authorized — `https://api.github.com`,
 * `https://api.bitbucket.org/2.0`, or a self-managed deployment under a subpath such as
 * `https://git.example.com/forge`. A base URL with a path confines the candidate to a
 * descendant path segment, so a sibling prefix like `/2.0evil` cannot pass.
 */
export function admitForgeRequestUrl(
  candidate: unknown,
  authorizedBaseUrl: string,
): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;

  let parsed: URL;
  let authorized: URL;
  try {
    parsed = new URL(candidate);
    authorized = new URL(authorizedBaseUrl);
  } catch {
    return null;
  }

  // Checked independently of the base URL: a binding that recorded a plaintext origin
  // still may not carry a credential in the clear.
  if (parsed.protocol !== 'https:') return null;
  if (parsed.origin !== authorized.origin) return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.hash !== '') return null;

  const authorizedPath = authorized.pathname.replace(/\/+$/u, '');
  if (authorizedPath !== '' && !parsed.pathname.startsWith(`${authorizedPath}/`)) return null;

  return candidate;
}
