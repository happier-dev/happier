import { describe, expect, it } from 'vitest';

import { parseOauthRedirectPaste } from './parseOauthRedirectPaste';

describe('parseOauthRedirectPaste', () => {
  it('parses code + state from a pasted redirect url', () => {
    const parsed = parseOauthRedirectPaste({
      pasted: 'http://localhost:1455/auth/callback?code=abc123&state=state1',
    });
    expect(parsed).toEqual({ ok: true, code: 'abc123', state: 'state1' });
  });

  it('rejects invalid urls', () => {
    const parsed = parseOauthRedirectPaste({ pasted: 'not-a-url' });
    expect(parsed.ok).toBe(false);
  });

  it('rejects when code is missing', () => {
    const parsed = parseOauthRedirectPaste({
      pasted: 'http://localhost:1455/auth/callback?state=state1',
    });
    expect(parsed).toEqual({ ok: false, error: 'missing_code' });
  });

  it('rejects when state is missing', () => {
    const parsed = parseOauthRedirectPaste({
      pasted: 'http://localhost:1455/auth/callback?code=abc123',
    });
    expect(parsed).toEqual({ ok: false, error: 'missing_state' });
  });
});

