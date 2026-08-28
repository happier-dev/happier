import { describe, expect, it } from 'vitest';

import {
  decodeGithubDetailContinuation,
  encodeGithubDetailContinuation,
} from './continuation.js';
import { GITHUB_MAX_DETAIL_PAGE_SIZE_V1 } from './routes.js';

describe('GitHub detail continuation codec', () => {
  it('round-trips a position this source minted', () => {
    const token = encodeGithubDetailContinuation({ v: 1, page: 4, perPage: 50 });
    expect(token).not.toBeNull();
    expect(decodeGithubDetailContinuation(token ?? '')).toEqual({ v: 1, page: 4, perPage: 50 });
  });

  it('refuses a provider URL, another version and an out-of-geometry page', () => {
    // The whole point of minting our own token: a provider-controlled URL can
    // never become a position this source will request.
    expect(decodeGithubDetailContinuation(
      'https://api.github.com/repos/o/r/issues/1/timeline?page=2',
    )).toBeNull();
    expect(decodeGithubDetailContinuation(JSON.stringify({ v: 2, page: 2, perPage: 50 })))
      .toBeNull();
    expect(decodeGithubDetailContinuation(JSON.stringify({ v: 1, page: 0, perPage: 50 })))
      .toBeNull();
    expect(decodeGithubDetailContinuation(JSON.stringify({ v: 1, page: 1.5, perPage: 50 })))
      .toBeNull();
    expect(decodeGithubDetailContinuation(JSON.stringify({
      v: 1,
      page: 2,
      perPage: GITHUB_MAX_DETAIL_PAGE_SIZE_V1 + 1,
    }))).toBeNull();
    expect(decodeGithubDetailContinuation('not json at all')).toBeNull();
  });

  it('refuses to mint a token for a geometry it would not accept back', () => {
    expect(encodeGithubDetailContinuation({ v: 1, page: 0, perPage: 50 })).toBeNull();
    expect(encodeGithubDetailContinuation({
      v: 1,
      page: 2,
      perPage: GITHUB_MAX_DETAIL_PAGE_SIZE_V1 + 1,
    })).toBeNull();
  });
});
