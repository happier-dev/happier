import { readBitbucketApiUrl } from '../apiUrl.js';

/**
 * The paging position of one mounted Bitbucket Cloud detail panel.
 *
 * There is exactly one cursor kind in this vertical because Bitbucket offers
 * exactly one: the `next` of the collection just read. Atlassian documents it as
 * "an opaque location that is not to be constructed by clients or even assumed
 * to be predictable", so this source carries that URL and never a page number.
 *
 * The URL is untrusted input in both directions. It is admitted against the
 * exact Cloud API base on the way out and again on the way in, so a token cannot
 * aim the materialized credential at another host and a response cannot redirect
 * the walk off the API.
 *
 * Like the scan continuation, this token is invocation-local, is never
 * persisted, and is never a watermark.
 */

const CONTINUATION_VERSION = 1;

export type BitbucketDetailFrontierV1 = Readonly<{ v: 1; nextUrl: string }>;

export function encodeBitbucketDetailContinuation(nextUrl: string): string | null {
  if (readBitbucketApiUrl(nextUrl) === null) return null;
  return JSON.stringify({ v: CONTINUATION_VERSION, nextUrl });
}

/**
 * Decodes a continuation this source minted. Anything else — another version, a
 * malformed token, or a URL outside the Cloud API base — is refused whole, and
 * the caller restarts the walk rather than requesting a position nobody can
 * vouch for.
 */
export function decodeBitbucketDetailContinuation(token: string): BitbucketDetailFrontierV1 | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(token);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
  const raw = decoded as Readonly<Record<string, unknown>>;
  if (raw['v'] !== CONTINUATION_VERSION) return null;
  const admitted = readBitbucketApiUrl(raw['nextUrl']);
  return admitted === null ? null : Object.freeze({ v: 1 as const, nextUrl: admitted });
}
