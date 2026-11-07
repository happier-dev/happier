import { describe, expect, it } from 'vitest';
import { MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';

import {
  BITBUCKET_REPOSITORY_ROUTE_ID,
  decodeBitbucketScanContinuation,
  encodeBitbucketScanContinuation,
  type BitbucketScanFrontierRecord,
} from './scanContinuation.js';

const REPOSITORY_UUID = '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}';
const LANE_NEXT_URL = 'https://api.bitbucket.org/2.0/repositories/x/y/pullrequests?page=2&pagelen=50';
const LIST_NEXT_URL = 'https://api.bitbucket.org/2.0/repositories/w?page=2&pagelen=100';
const SCOPE = 'bitbucket-scan-test-scope';
const probe = (cursor: string) => ({ cursor, stepsSince: 0, interval: 2 } as const);

function frontier(
  overrides: Partial<BitbucketScanFrontierRecord> = {},
): BitbucketScanFrontierRecord {
  return {
    scanLimit: 64,
    nativePageSize: 50,
    nextLaneIndex: 0,
    walkHealth: [],
    authored: { nextUrl: LANE_NEXT_URL, ended: false, cycleProbe: probe(LANE_NEXT_URL) },
    repositoryListNextUrl: null,
    repositoryListCycleProbe: null,
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
      repositoryListCycleProbe: probe(LIST_NEXT_URL),
      currentRepository: {
        repositoryUuid: REPOSITORY_UUID,
        lanes: [{
          laneId: BITBUCKET_REPOSITORY_ROUTE_ID,
          nextUrl: null,
          ended: false,
          cycleProbe: null,
        }],
      },
    });

    const encoded = encodeBitbucketScanContinuation(record, SCOPE);
    expect(encoded).not.toBeNull();
    if (encoded === null) return;
    expect(decodeBitbucketScanContinuation(encoded, SCOPE)).toEqual(record);
    expect(decodeBitbucketScanContinuation(encoded, 'another-configured-source')).toBeNull();

    // The scope and frontier carry no credential, viewer, or delivered row data.
    expect(encoded.token).not.toContain('Basic ');
    expect(encoded.token).not.toContain('observedAt');
  });

  it('accepts a plain versioned frontier and refuses malformed or mismatched positions', () => {
    const base = {
      v: 1,
      s: SCOPE,
      l: 64,
      n: 50,
      i: 0,
      h: [],
      a: [LANE_NEXT_URL, false, probe(LANE_NEXT_URL)],
      r: null,
      c: null,
    } as const;
    // SIMPLIFY-CHALLENGE-1106 #7: positions carry no authority and need no process signature.
    expect(decodeBitbucketScanContinuation({ v: 1, token: JSON.stringify(base) }, SCOPE))
      .toEqual(frontier());
    const vectors: readonly string[] = [
      'not-json',
      JSON.stringify({ ...base, s: 'another-configured-source' }),
      JSON.stringify({ ...base, v: 2 }),
      // Geometry that disagrees with itself would fetch pages the budget can never admit.
      JSON.stringify({ ...base, l: 10, n: 64 }),
      // Native geometry is derived, not caller-selected: a smaller page size changes the walk.
      JSON.stringify({ ...base, l: 64, n: 10 }),
      // A rotation position outside the open lane set would silently skip a lane.
      JSON.stringify({ ...base, i: 2 }),
      // An unrecognized sticky reason is a caveat this version cannot carry; it is never dropped.
      JSON.stringify({ ...base, h: ['result-ceiling-typo'] }),
      // A repository frontier without a routable repository is unroutable.
      JSON.stringify({ ...base, c: ['not-a-uuid', [['r', null, false, null]]] }),
      // An unknown repository lane code names a collection this walk cannot address.
      JSON.stringify({ ...base, c: [REPOSITORY_UUID, [['z', null, false, null]]] }),
      // A forge-supplied URL is revalidated on the way back in, never trusted for having been
      // validated once already.
      JSON.stringify({ ...base, r: ['https://evil.example.com/2.0/x', probe(LIST_NEXT_URL)] }),
      JSON.stringify({ ...base, a: ['https://evil.example.com/2.0/x', false, probe(LANE_NEXT_URL)] }),
      JSON.stringify({ ...base, a: [LANE_NEXT_URL, 'no', probe(LANE_NEXT_URL)] }),
    ];

    for (const token of vectors) {
      expect(decodeBitbucketScanContinuation({ v: 1, token }, SCOPE)).toBeNull();
    }
  });

  it('preserves a frontier up to the canonical paging-token byte ceiling', () => {
    const baseListUrl = `${LIST_NEXT_URL}&pad=`;
    const base = frontier({
      repositoryListNextUrl: baseListUrl,
      // The constant-space checkpoint is an earlier reached cursor, not another copy of the
      // current provider URL. Keeping the earlier position is the cycle evidence it exists for.
      repositoryListCycleProbe: probe(LIST_NEXT_URL),
    });
    const baseToken = encodeBitbucketScanContinuation(base, SCOPE);
    if (baseToken === null) throw new Error('the unpadded frontier must fit');
    const paddingBytes = MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1
      - new TextEncoder().encode(baseToken.token).byteLength;
    const wide = { ...base, repositoryListNextUrl: `${baseListUrl}${'p'.repeat(paddingBytes)}` };

    const encoded = encodeBitbucketScanContinuation(wide, SCOPE);
    expect(encoded).not.toBeNull();
    expect(encoded === null ? null : decodeBitbucketScanContinuation(encoded, SCOPE)).toEqual(wide);
    expect(encodeBitbucketScanContinuation({
      ...wide, repositoryListNextUrl: `${wide.repositoryListNextUrl}p`,
    }, SCOPE)).toBeNull();
  });
});
