/**
 * GitLab `Link` header pagination.
 *
 * GitLab returns `Link` headers with `rel` of `prev`, `next`, `first` or `last` on
 * each response, and for keyset pagination states outright that only the given link
 * may be used to retrieve the next page. So the next page URL is followed
 * byte-for-byte: it is never rebuilt, re-signed, re-ordered, or reduced.
 *
 * `x-total`, `x-total-pages` and `rel="last"` are advisory and GitLab omits them
 * above 10,000 records, so their absence proves nothing about collection size and no
 * completeness claim may read them.
 *
 * The header grammar itself is RFC 8288 rather than a GitLab rule, and the credential
 * gate on a URL GitLab supplied is the same gate every forge needs, so both come from
 * `@happier-dev/triage-sources`. What a `next` MEANS here — keyset, verbatim, never
 * reconstructed — stays this source's decision.
 */

import { admitForgeRequestUrl, parseForgeLinkHeader } from '@happier-dev/triage-sources/runtime';

import type { GitlabResponseHeaders } from './gitlabHeaders.js';

/**
 * What one response says about the lane's next page.
 *
 * `end`, `malformed`, and `refused` are deliberately not one answer. GitLab omitting
 * `next` is the lane's own end; syntax we could not interpret or a named `next` this
 * invocation may not follow leaves a lane this walk cannot finish. Collapsing any of
 * them lets incomplete evidence settle as clean exhaustion.
 */
export type GitlabNextPageSelection =
  /** GitLab issued a `next` addressing the exact invoked origin; follow it verbatim. */
  | Readonly<{ kind: 'next'; url: string }>
  /** GitLab issued no `next`: this lane has no further page. */
  | Readonly<{ kind: 'end' }>
  /** GitLab emitted a present `Link` value whose syntax could not be interpreted. */
  | Readonly<{ kind: 'malformed' }>
  /** GitLab issued a `next` this invocation may not follow, so the lane stops unfinished. */
  | Readonly<{ kind: 'refused' }>;

/** A native page may advance inside its resource, never into another project. */
export function isGitlabPageWithinResource(candidate: string, resourceUrl: string, preserveQuery = false): boolean {
  try {
    const url = new URL(candidate);
    const resource = new URL(resourceUrl);
    return url.origin === resource.origin && url.pathname === resource.pathname
      && url.username === '' && url.password === '' && url.hash === ''
      && (!preserveQuery || [...resource.searchParams.keys()].every(key => key === 'page'
        || JSON.stringify(url.searchParams.getAll(key)) === JSON.stringify(resource.searchParams.getAll(key))));
  } catch { return false; }
}

/**
 * Returns the provider-issued next-page URL, verbatim, only when it addresses the
 * exact origin this invocation was authorized against. A cross-origin `Link` is
 * dropped rather than followed: sending the binding's credential to another host is
 * a credential disclosure, and a read answered by another host is a confidently
 * wrong list.
 *
 * An inadmissible URL is `refused`, and uninterpretable header syntax is `malformed`;
 * neither is absence, because neither proves the lane ended.
 */
export function selectGitlabNextPageUrl(
  headers: GitlabResponseHeaders,
  invokedOrigin: string,
): GitlabNextPageSelection {
  const parsed = parseForgeLinkHeader(headers.get('link'));
  if (parsed.kind === 'malformed') return { kind: 'malformed' };
  if (parsed.kind === 'absent') return { kind: 'end' };
  const next = parsed.links.next;
  if (next === undefined) return { kind: 'end' };
  const admitted = admitForgeRequestUrl(next, invokedOrigin);
  return admitted === null ? { kind: 'refused' } : { kind: 'next', url: admitted };
}
