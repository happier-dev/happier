import {
  decodeTriagePagingTokenV1,
  encodeTriagePagingTokenV1,
} from '@happier-dev/triage-protocol/v1';

import { readBitbucketApiUrl } from '../apiUrl.js';

/**
 * The paging position of one mounted Bitbucket Cloud detail panel.
 *
 * Bitbucket's `next` is opaque, so its query is carried byte-for-byte in a plain
 * versioned payload. Invocation admission chooses the configured source/account;
 * this codec admits only the selected detail collection's API origin, pathname
 * and native page geometry. The paging position grants no credential authority.
 */

const CONTINUATION_VERSION = 1;

export type BitbucketDetailContinuationContextV1 = Readonly<{
  firstUrl: string;
  nativePageSize: number;
}>;

export type BitbucketDetailFrontierV1 = Readonly<{ v: 1; nextUrl: string }>;

/** Admits only a provider position for this exact collection and geometry. */
function readIssuedNextUrl(
  candidate: unknown,
  input: BitbucketDetailContinuationContextV1,
): string | null {
  const admitted = readBitbucketApiUrl(candidate);
  const first = readBitbucketApiUrl(input.firstUrl);
  if (admitted === null || first === null) return null;

  const actual = new URL(admitted);
  const expected = new URL(first);
  if (actual.pathname !== expected.pathname) return null;
  const pageLengths = actual.searchParams.getAll('pagelen');
  if (pageLengths.length !== 1 || pageLengths[0] !== String(input.nativePageSize)) return null;
  return admitted;
}

export function encodeBitbucketDetailContinuation(
  nextUrl: string,
  input: BitbucketDetailContinuationContextV1,
): string | null {
  const admitted = readIssuedNextUrl(nextUrl, input);
  return admitted === null
    ? null
    : encodeTriagePagingTokenV1({ v: CONTINUATION_VERSION, nextUrl: admitted });
}

/** Refuses malformed, cross-route, cross-plane, and wrong-geometry tokens whole. */
export function decodeBitbucketDetailContinuation(
  token: string,
  input: BitbucketDetailContinuationContextV1,
): BitbucketDetailFrontierV1 | null {
  const decoded = decodeTriagePagingTokenV1(token);
  if (
    decoded === null
    || Object.keys(decoded).length !== 2
    || decoded.v !== CONTINUATION_VERSION
  ) {
    return null;
  }
  const admitted = readIssuedNextUrl(decoded.nextUrl, input);
  return admitted === null ? null : Object.freeze({ v: 1 as const, nextUrl: admitted });
}
