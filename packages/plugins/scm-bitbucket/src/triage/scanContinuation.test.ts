import { MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  BITBUCKET_REPOSITORY_ROUTE_ID,
  decodeBitbucketScanContinuation,
  encodeBitbucketScanContinuation,
  type BitbucketScanFrontierRecord,
} from './scanContinuation.js';

const REPOSITORY_UUID = '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}';
const LANE_NEXT_URL = 'https://api.bitbucket.org/2.0/repositories/x/y/pullrequests?page=2';
const LIST_NEXT_URL = 'https://api.bitbucket.org/2.0/repositories/w?page=2';

function frontier(
  overrides: Partial<BitbucketScanFrontierRecord> = {},
): BitbucketScanFrontierRecord {
  return {
    scanLimit: 64,
    nativePageSize: 64,
    nextLaneIndex: 0,
    walkHealth: [],
    authored: { nextUrl: LANE_NEXT_URL, ended: false },
    repositoryListNextUrl: null,
    currentRepository: null,
    ...overrides,
  };
}

describe('Bitbucket scan continuation codec', () => {
  it('round-trips the invocation frontier with its sticky walk health and carries nothing else', () => {
    const record = frontier({
      nextLaneIndex: 1,
      walkHealth: ['undecodable-items', 'repository-enumeration-incomplete'],
      repositoryListNextUrl: LIST_NEXT_URL,
      currentRepository: {
        repositoryUuid: REPOSITORY_UUID,
        lanes: [{ laneId: BITBUCKET_REPOSITORY_ROUTE_ID, nextUrl: null, ended: false }],
      },
    });

    const encoded = encodeBitbucketScanContinuation(record);
    expect(encoded).not.toBeNull();
    if (encoded === null) return;
    expect(decodeBitbucketScanContinuation(encoded)).toEqual(record);

    // The token is the frontier and nothing else: no credential, account, viewer, or delivered row.
    expect(encoded.token).not.toContain('Basic ');
    expect(encoded.token).not.toContain('accountId');
    expect(encoded.token).not.toContain('observedAt');
  });

  it('refuses a token this source did not mint rather than guessing a frontier', () => {
    const base = {
      v: 1,
      l: 64,
      n: 64,
      i: 0,
      h: [],
      a: [LANE_NEXT_URL, false],
      r: null,
      c: null,
    } as const;
    const vectors: readonly string[] = [
      'not-json',
      JSON.stringify({ ...base, v: 2 }),
      // Geometry that disagrees with itself would fetch pages the budget can never admit.
      JSON.stringify({ ...base, l: 10, n: 64 }),
      // A rotation position outside the open lane set would silently skip a lane.
      JSON.stringify({ ...base, i: 2 }),
      // An unrecognized sticky reason is a caveat this version cannot carry; it is never dropped.
      JSON.stringify({ ...base, h: ['result-ceiling-typo'] }),
      // A repository frontier without a routable repository is unroutable.
      JSON.stringify({ ...base, c: ['not-a-uuid', [['r', null, false]]] }),
      // An unknown repository lane code names a collection this walk cannot address.
      JSON.stringify({ ...base, c: [REPOSITORY_UUID, [['z', null, false]]] }),
      // A forge-supplied URL is revalidated on the way back in, never trusted for having been
      // validated once already.
      JSON.stringify({ ...base, r: 'https://evil.example.com/2.0/x' }),
      JSON.stringify({ ...base, a: ['https://evil.example.com/2.0/x', false] }),
      JSON.stringify({ ...base, a: [LANE_NEXT_URL, 'no'] }),
    ];

    for (const token of vectors) {
      expect(decodeBitbucketScanContinuation({ v: 1, token })).toBeNull();
    }
  });

  it('ends the walk instead of truncating a frontier that does not fit the paging bound', () => {
    const oversize = frontier({
      repositoryListNextUrl: `${LIST_NEXT_URL}&pad=${'p'.repeat(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1)}`,
    });

    // Half a frontier addresses the wrong repositories, so it is refused whole and the caller
    // reports bounded partial evidence instead.
    expect(encodeBitbucketScanContinuation(oversize)).toBeNull();
  });
});
