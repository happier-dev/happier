import { describe, expect, it } from 'vitest';

import { parseOauthCallbackUrl } from './oauthCore';

describe('parseOauthCallbackUrl', () => {
  it('extracts code/state from a matching redirect URL', () => {
    const res = parseOauthCallbackUrl({
      url: 'http://localhost:54545/callback?code=abc&state=st1',
      redirectUri: 'http://localhost:54545/callback',
    });
    expect(res).toEqual({ code: 'abc', state: 'st1' });
  });

  it('ignores non-matching paths', () => {
    const res = parseOauthCallbackUrl({
      url: 'http://localhost:54545/other?code=abc&state=st1',
      redirectUri: 'http://localhost:54545/callback',
    });
    expect(res).toEqual({});
  });

  it('extracts error when present', () => {
    const res = parseOauthCallbackUrl({
      url: 'http://localhost:1455/auth/callback?error=access_denied&state=st1',
      redirectUri: 'http://localhost:1455/auth/callback',
    });
    expect(res).toEqual({ error: 'access_denied', state: 'st1' });
  });
});

