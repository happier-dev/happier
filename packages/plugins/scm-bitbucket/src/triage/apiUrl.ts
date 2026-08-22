import { admitForgeRequestUrl } from '@happier-dev/triage-sources/runtime';

export const BITBUCKET_CLOUD_API_ORIGIN = 'https://api.bitbucket.org';
export const BITBUCKET_CLOUD_API_BASE_URL = `${BITBUCKET_CLOUD_API_ORIGIN}/2.0`;

/**
 * Validates an absolute URL against the exact Bitbucket Cloud API base before it is fetched.
 * This is the one gate every forge-supplied location passes through — opaque `next` links and
 * redirect targets alike — so an attacker-influenced or misconfigured location can never receive
 * the materialized credential.
 *
 * The rule is the shared forge credential-disclosure gate; what this module owns is the base URL
 * it is applied against, which is Bitbucket Cloud's single fixed `2.0` API.
 */
export function readBitbucketApiUrl(candidate: unknown): string | null {
  return admitForgeRequestUrl(candidate, BITBUCKET_CLOUD_API_BASE_URL);
}
