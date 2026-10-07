import type { TriageConfiguredSourceConnectedAccountInstanceV1 } from '@happier-dev/triage-protocol/v1';

import { readBitbucketApiUrl } from '../apiUrl.js';
import {
  buildBitbucketContinuationBindingScope,
  decodeBitbucketContinuationPayload,
  encodeBitbucketContinuationPayload,
} from '../continuationIntegrity.js';

/**
 * The paging position of one mounted Bitbucket Cloud detail panel.
 *
 * Bitbucket's `next` is opaque, so its query is carried byte-for-byte. The token
 * is nevertheless source-owned: a process-local MAC binds that query to the
 * configured source/account, immutable entry identity, locator route, detail
 * plane, and native page geometry. A caller therefore cannot forge a page or
 * replay a genuine token through another mounted route.
 */

const CONTINUATION_VERSION = 1;

export type BitbucketDetailContinuationPlaneV1 =
  | 'activity'
  | 'builds'
  | 'comments'
  | 'diffstat';

export type BitbucketDetailContinuationContextV1 = Readonly<{
  instance: TriageConfiguredSourceConnectedAccountInstanceV1;
  route: Readonly<{
    workspaceUuid: string;
    repositorySlug: string;
    repositoryKey: string;
    expectedRepositoryUuid: string;
    entryId: string;
  }>;
  plane: BitbucketDetailContinuationPlaneV1;
  firstUrl: string;
  nativePageSize: number;
}>;

export type BitbucketDetailFrontierV1 = Readonly<{ v: 1; nextUrl: string }>;

function buildScope(input: BitbucketDetailContinuationContextV1): string {
  return JSON.stringify([
    'bitbucket-detail-v1',
    buildBitbucketContinuationBindingScope(input.instance),
    input.route.workspaceUuid,
    input.route.repositorySlug,
    input.route.repositoryKey,
    input.route.expectedRepositoryUuid,
    input.route.entryId,
    input.plane,
    input.nativePageSize,
  ]);
}

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
    : encodeBitbucketContinuationPayload(
      { v: CONTINUATION_VERSION, nextUrl: admitted },
      buildScope(input),
    );
}

/** Refuses malformed, forged, cross-route, cross-plane, and wrong-geometry tokens whole. */
export function decodeBitbucketDetailContinuation(
  token: string,
  input: BitbucketDetailContinuationContextV1,
): BitbucketDetailFrontierV1 | null {
  const decoded = decodeBitbucketContinuationPayload(token, buildScope(input));
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
