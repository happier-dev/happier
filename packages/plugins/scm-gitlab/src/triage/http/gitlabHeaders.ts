/**
 * Case-insensitive response-header reading for this corridor.
 *
 * HTTP header names are case-insensitive and GitLab's own documentation spells the
 * same header two ways across pages, so every read in this corridor goes through here.
 * The RULE is not GitLab's — it is `readTriageResponseHeaderV1`, shared by every Triage
 * source. What stays here is only the accessor shape the client, link and rate-limit
 * readers take, so a fetcher that hands back something other than a plain record can
 * still satisfy them.
 */
import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

export interface GitlabResponseHeaders {
  get(name: string): string | null;
}

/** Wraps a plain record — used by fixtures and by any fetcher that returns one. */
export function createGitlabResponseHeaders(
  record: Readonly<Record<string, string>>,
): GitlabResponseHeaders {
  return { get: (name: string) => readTriageResponseHeaderV1(record, name) };
}
