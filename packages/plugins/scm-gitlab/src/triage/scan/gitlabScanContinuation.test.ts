import { MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { buildGitlabScanLanes, type GitlabLaneRequest } from '../mapping/gitlabInvolvement.js';
import { normalizeGitlabConfiguredBaseUrl } from '../origin.js';
import {
  decodeGitlabScanContinuation,
  encodeGitlabScanContinuation,
} from './gitlabScanContinuation.js';
import { createGitlabScanFrontier } from './gitlabScanFrontier.js';

const origin = normalizeGitlabConfiguredBaseUrl('https://gitlab.com');
if (!origin) throw new Error('unusable fixture origin');
const GITLAB_COM = origin;

function lanes(): readonly GitlabLaneRequest[] {
  return buildGitlabScanLanes({ kindId: 'merge-request', viewerUserId: 42 }).requests;
}

function frontierOf(laneRequests: readonly GitlabLaneRequest[] = lanes()) {
  return createGitlabScanFrontier({ scanLimit: 32, origin: GITLAB_COM, lanes: laneRequests });
}

describe('the GitLab scan continuation codec', () => {
  it('carries the rotation, the fixed geometry and the sticky reasons, and nothing else', () => {
    const frontier = frontierOf();
    frontier.nextLaneIndex = 2;
    frontier.walkHealth.add('undecodable-items');
    const continuation = encodeGitlabScanContinuation(frontier);
    if (continuation === null) throw new Error('expected an encodable frontier');

    const resumed = decodeGitlabScanContinuation({ continuation, origin: GITLAB_COM, lanes: lanes() });
    if (resumed === null) throw new Error('expected the codec to accept its own token');
    expect(resumed.nextLaneIndex).toBe(2);
    expect(resumed.nativePageSize).toBe(frontier.nativePageSize);
    expect([...resumed.walkHealth]).toEqual(['undecodable-items']);

    // No credential, account ref, viewer identity, delivered-id history or accumulated
    // row ever rides in the token.
    const token = continuation.token.toLowerCase();
    expect(token).not.toContain('authorization');
    expect(token).not.toContain('bearer');
    expect(token).not.toContain('account');
  });

  it('refuses a token whose lane set is not the one this invocation built', () => {
    const continuation = encodeGitlabScanContinuation(frontierOf());
    if (continuation === null) throw new Error('expected an encodable frontier');

    // The issue lanes reuse the lane ids the merge-request lanes use, so a key that
    // dropped the kind would silently resume an issue walk against merge-request URLs.
    const issueLanes = buildGitlabScanLanes({ kindId: 'issue', viewerUserId: 42 }).requests;
    expect(decodeGitlabScanContinuation({ continuation, origin: GITLAB_COM, lanes: issueLanes }))
      .toBeNull();
  });

  it('refuses a token whose next URL points at another host', () => {
    const frontier = frontierOf();
    const tampered = JSON.parse(encodeGitlabScanContinuation(frontier)?.token ?? '{}') as {
      lanes: { nextUrl: string }[];
    };
    const first = tampered.lanes[0];
    if (!first) throw new Error('expected an encoded lane');
    first.nextUrl = 'https://gitlab.example.test/api/v4/merge_requests?scope=created_by_me';

    // A token is untrusted input. Without re-admitting every URL against the origin THIS
    // invocation authorized, it aims that binding's credential at whatever host it names.
    expect(decodeGitlabScanContinuation({
      continuation: { v: 1, token: JSON.stringify(tampered) },
      origin: GITLAB_COM,
      lanes: lanes(),
    })).toBeNull();
  });

  it('reports a frontier it cannot fit inside the published token bound', () => {
    // The ceiling is the contract's symbol, not a number this package remembers. A source
    // sized against a remembered number emits a token the strict target rejects, and it
    // does so at exactly the large accounts the fairness rule exists to serve.
    const wide: GitlabLaneRequest[] = Array.from({ length: 400 }, (_unused, index) => ({
      laneId: 'authored',
      kindId: 'merge-request',
      path: '/merge_requests',
      query: [['scope', 'created_by_me'], ['probe', `lane-${index}`]],
      involvement: 'author',
    }));

    const oversize = encodeGitlabScanContinuation(frontierOf(wide));
    expect(oversize).toBeNull();
    // The bound is read, so this test states the relationship rather than a literal.
    expect(encodeGitlabScanContinuation(frontierOf())?.token.length)
      .toBeLessThan(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1);
  });
});
