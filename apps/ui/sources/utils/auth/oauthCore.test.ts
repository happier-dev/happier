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

  it('treats loopback host variants as equivalent (127.0.0.1)', () => {
    const res = parseOauthCallbackUrl({
      url: 'http://127.0.0.1:54545/callback?code=abc&state=st1',
      redirectUri: 'http://localhost:54545/callback',
    });
    expect(res).toEqual({ code: 'abc', state: 'st1' });
  });

  it('treats loopback host variants as equivalent ([::1])', () => {
    const res = parseOauthCallbackUrl({
      url: 'http://[::1]:54545/callback?code=abc&state=st1',
      redirectUri: 'http://localhost:54545/callback',
    });
    expect(res).toEqual({ code: 'abc', state: 'st1' });
  });

  it('ignores trailing slash differences in the callback path', () => {
    const res = parseOauthCallbackUrl({
      url: 'http://localhost:54545/callback/?code=abc&state=st1',
      redirectUri: 'http://localhost:54545/callback',
    });
    expect(res).toEqual({ code: 'abc', state: 'st1' });
  });

  it('extracts code/state from pasted text that contains a URL', () => {
    const res = parseOauthCallbackUrl({
      url: 'Paste this redirect URL: http://localhost:54545/callback?code=abc&state=st1',
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

  it('extracts code/state from hash fragment params', () => {
    const res = parseOauthCallbackUrl({
      url: 'http://localhost:54545/callback#code=abc&state=st1',
      redirectUri: 'http://localhost:54545/callback',
    });
    expect(res).toEqual({ code: 'abc', state: 'st1' });
  });

  it('extracts code/state from ?code=...#state=... split form', () => {
    const res = parseOauthCallbackUrl({
      url: 'http://localhost:54545/callback?code=abc#state=st1',
      redirectUri: 'http://localhost:54545/callback',
    });
    expect(res).toEqual({ code: 'abc', state: 'st1' });
  });

  it('extracts code/state from a pasted code#state string (headless OAuth)', () => {
    const res = parseOauthCallbackUrl({
      url: 'abc123#st1',
      redirectUri: 'http://localhost:54545/callback',
    });
    expect(res).toEqual({ code: 'abc123', state: 'st1' });
  });
});
