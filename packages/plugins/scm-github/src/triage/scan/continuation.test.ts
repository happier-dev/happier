import { describe, expect, it } from 'vitest';

import { MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';

import { decodeGithubScanContinuation, encodeGithubScanContinuation } from './continuation.js';
import { createGithubScanFrontier } from './frontier.js';
import { GITHUB_SCAN_LANE_ORDER_V1, type GithubScanLaneIdV1 } from './query.js';

const SCAN_LIMIT = 50;
const MAX_SCAN_LIMIT = 200;

/** A lane query long enough that five lane URLs cannot fit the protocol paging bound. */
function wideLaneQuery(laneId: GithubScanLaneIdV1): string {
  return `${laneId} ${'repo:acme/service-with-a-long-name'.repeat(20)}`;
}

function shortLaneQuery(laneId: GithubScanLaneIdV1): string {
  return `${laneId} is:open`;
}

function laneNextUrl(laneQuery: string, page: number): string {
  const url = new URL('https://api.github.com/search/issues');
  url.searchParams.set('q', laneQuery);
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('advanced_search', 'true');
  url.searchParams.set('per_page', String(SCAN_LIMIT));
  url.searchParams.set('page', String(page));
  return url.toString();
}

function handMintedToken(buildLaneQuery: (laneId: GithubScanLaneIdV1) => string): string {
  return JSON.stringify({
    v: 1,
    scanLimit: SCAN_LIMIT,
    nativePageSize: SCAN_LIMIT,
    nextLaneIndex: 0,
    walkHealth: [],
    lanes: GITHUB_SCAN_LANE_ORDER_V1.map((laneId) => ({
      laneId,
      nextUrl: laneNextUrl(buildLaneQuery(laneId), 2),
      pagesConsumed: 1,
      ended: false,
    })),
  });
}

describe('GitHub scan continuation envelope', () => {
  it('round-trips a frontier that fits the protocol paging bound', () => {
    const token = handMintedToken(shortLaneQuery);
    expect(new TextEncoder().encode(token).byteLength)
      .toBeLessThanOrEqual(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1);

    const decoded = decodeGithubScanContinuation(token, {
      buildLaneQuery: shortLaneQuery,
      maxScanLimit: MAX_SCAN_LIMIT,
    });
    expect(decoded?.lanes).toHaveLength(GITHUB_SCAN_LANE_ORDER_V1.length);
    expect(decoded?.lanes[0]?.frontier).toEqual({
      kind: 'next',
      nextUrl: laneNextUrl(shortLaneQuery(GITHUB_SCAN_LANE_ORDER_V1[0]!), 2),
    });
  });

  it('refuses a token wider than the protocol paging bound, which its own encoder would never mint', () => {
    const frontier = createGithubScanFrontier({
      scanLimit: SCAN_LIMIT,
      buildLaneQuery: wideLaneQuery,
      resume: {
        nextLaneIndex: 0,
        walkHealth: [],
        lanes: GITHUB_SCAN_LANE_ORDER_V1.map((laneId) => ({
          frontier: { kind: 'next' as const, nextUrl: laneNextUrl(wideLaneQuery(laneId), 2) },
          pagesConsumed: 1,
          ended: false,
        })),
      },
    });
    // The encoder refuses to mint it: the same bytes must not be admitted on the way back in.
    expect(encodeGithubScanContinuation(frontier)).toBeNull();

    const token = handMintedToken(wideLaneQuery);
    expect(new TextEncoder().encode(token).byteLength)
      .toBeGreaterThan(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1);
    expect(decodeGithubScanContinuation(token, {
      buildLaneQuery: wideLaneQuery,
      maxScanLimit: MAX_SCAN_LIMIT,
    })).toBeNull();
  });
});
