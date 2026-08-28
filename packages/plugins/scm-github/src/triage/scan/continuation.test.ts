import { describe, expect, it } from 'vitest';

import { decodeGithubScanContinuation, encodeGithubScanContinuation } from './continuation.js';
import { createGithubScanFrontier } from './frontier.js';
import { GITHUB_SCAN_LANE_ORDER_V1, type GithubScanLaneIdV1 } from './query.js';

const SCAN_LIMIT = 50;

/** A lane query wider than the retired feature-local token ceiling. */
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
  it('round-trips a frontier', () => {
    const token = handMintedToken(shortLaneQuery);

    const decoded = decodeGithubScanContinuation(token, {
      buildLaneQuery: shortLaneQuery,
    });
    expect(decoded?.lanes).toHaveLength(GITHUB_SCAN_LANE_ORDER_V1.length);
    expect(decoded?.lanes[0]?.frontier).toEqual({
      kind: 'next',
      nextUrl: laneNextUrl(shortLaneQuery(GITHUB_SCAN_LANE_ORDER_V1[0]!), 2),
    });
  });

  it('round-trips a wide valid frontier and leaves size to the Action envelope', () => {
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
    expect(encodeGithubScanContinuation(frontier)).not.toBeNull();

    const token = handMintedToken(wideLaneQuery);
    expect(decodeGithubScanContinuation(token, {
      buildLaneQuery: wideLaneQuery,
    })).not.toBeNull();
  });

  it('accepts the source-minted safe-integer limit without recreating a feature-local ceiling', () => {
    const scanLimit = 65_536;
    const nativePageSize = 100;
    const token = JSON.stringify({
      v: 1,
      scanLimit,
      nativePageSize,
      nextLaneIndex: 0,
      walkHealth: [],
      lanes: GITHUB_SCAN_LANE_ORDER_V1.map((laneId) => ({
        laneId,
        nextUrl: null,
        pagesConsumed: 0,
        ended: false,
      })),
    });

    expect(decodeGithubScanContinuation(token, {
      buildLaneQuery: shortLaneQuery,
    })?.scanLimit).toBe(scanLimit);
  });
});
