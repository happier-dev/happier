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
 * `end` and `refused` are deliberately NOT one answer. GitLab omitting `next` is the
 * lane's own end; GitLab naming a `next` this invocation may not follow is a lane this
 * walk cannot finish. Collapsing them lets a refused continuation settle as a clean
 * exhaustion, which is the one arm that tells the user their inbox is whole when it is
 * not.
 */
export type GitlabNextPageSelection =
  /** GitLab issued a `next` addressing the exact invoked origin; follow it verbatim. */
  | Readonly<{ kind: 'next'; url: string }>
  /** GitLab issued no `next`: this lane has no further page. */
  | Readonly<{ kind: 'end' }>
  /** GitLab issued a `next` this invocation may not follow, so the lane stops unfinished. */
  | Readonly<{ kind: 'refused' }>;

/**
 * Returns the provider-issued next-page URL, verbatim, only when it addresses the
 * exact origin this invocation was authorized against. A cross-origin `Link` is
 * dropped rather than followed: sending the binding's credential to another host is
 * a credential disclosure, and a read answered by another host is a confidently
 * wrong list.
 *
 * The drop is reported as `refused` rather than as absence, because the lane still has
 * a page GitLab named and this walk cannot read it.
 */
export function selectGitlabNextPageUrl(
  headers: GitlabResponseHeaders,
  invokedOrigin: string,
): GitlabNextPageSelection {
  const next = parseForgeLinkHeader(headers.get('link')).next;
  if (next === undefined) return { kind: 'end' };
  const admitted = admitForgeRequestUrl(next, invokedOrigin);
  return admitted === null ? { kind: 'refused' } : { kind: 'next', url: admitted };
}
