import { describe, expect, it } from 'vitest';

import pageOne from './fixtures/pullRequestsPageOne.json' with { type: 'json' };
import pageTwo from './fixtures/pullRequestsPageTwo.json' with { type: 'json' };
import {
  BITBUCKET_MAX_PAGE_LENGTH,
  BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH,
  decodeBitbucketPageEnvelope,
  resolveBitbucketNextPageUrl,
  resolveBitbucketPageGeometry,
} from './pagination.js';

describe('Bitbucket page geometry', () => {
  it('refuses a scan limit below the published page minimum before any provider I/O', () => {
    for (const limit of [1, 9]) {
      const resolved = resolveBitbucketPageGeometry(limit);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.failure).toMatchObject({
          class: 'unsupportedContract',
          code: 'scan-limit-below-provider-page-minimum',
        });
      }
    }
  });

  it('fixes one native page size for the whole invocation and caps it at the route maximum', () => {
    const small = resolveBitbucketPageGeometry(25);
    expect(small.ok && small.geometry).toEqual({ scanLimit: 25, nativePageSize: 25 });

    // The pull-request collection rejects `pagelen` above 50 with a `400 Invalid pagelen` rather
    // than clamping, so the documented global maximum is the wrong ceiling for this walk: every
    // request a larger geometry issued would fail outright, and the whole scan would return
    // nothing while looking like an empty account.
    expect(BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH).toBeLessThan(BITBUCKET_MAX_PAGE_LENGTH);
    const large = resolveBitbucketPageGeometry(500);
    expect(large.ok && large.geometry)
      .toEqual({ scanLimit: 500, nativePageSize: BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH });
    // The largest page the published scan bound can ask for is still served in one request.
    const protocolMaximum = resolveBitbucketPageGeometry(64);
    expect(protocolMaximum.ok && protocolMaximum.geometry.nativePageSize)
      .toBe(BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH);
  });
});

describe('Bitbucket page envelope', () => {
  it('decodes the documented wrapper and treats size as advisory rather than as a count', () => {
    const decoded = decodeBitbucketPageEnvelope(pageOne);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.envelope.values).toHaveLength(2);
    expect(decoded.envelope.pagelen).toBe(10);
    expect(decoded.envelope.size).toBeNull();
    expect(decoded.envelope.next).toContain('/pullrequests/');
  });

  it('rejects a body that is not the documented wrapper', () => {
    for (const body of [null, 42, { values: 'nope' }, {}]) {
      const decoded = decodeBitbucketPageEnvelope(body);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.failure.class).toBe('unsupportedContract');
    }
  });

  it('follows only an absolute same-origin next link and ends the walk when it is absent', () => {
    const first = decodeBitbucketPageEnvelope(pageOne);
    const last = decodeBitbucketPageEnvelope(pageTwo);
    expect(first.ok && last.ok).toBe(true);
    if (!first.ok || !last.ok) return;

    expect(resolveBitbucketNextPageUrl(first.envelope))
      .toMatchObject({ kind: 'next', url: first.envelope.next });
    expect(resolveBitbucketNextPageUrl(last.envelope)).toEqual({ kind: 'end' });

    const hostile = resolveBitbucketNextPageUrl({
      ...first.envelope,
      next: 'https://api.bitbucket.org.example.com/2.0/pullrequests?page=2',
    });
    expect(hostile.kind).toBe('invalid');

    const relative = resolveBitbucketNextPageUrl({ ...first.envelope, next: '/2.0/pullrequests?page=2' });
    expect(relative.kind).toBe('invalid');
  });
});
