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
 * Returns the provider-issued next-page URL, verbatim, only when it addresses the
 * exact origin this invocation was authorized against. A cross-origin `Link` is
 * dropped rather than followed: sending the binding's credential to another host is
 * a credential disclosure, and a read answered by another host is a confidently
 * wrong list.
 */
export function selectGitlabNextPageUrl(
  headers: GitlabResponseHeaders,
  invokedOrigin: string,
): string | null {
  const next = parseForgeLinkHeader(headers.get('link')).next;
  if (next === undefined) return null;
  return admitForgeRequestUrl(next, invokedOrigin);
}
