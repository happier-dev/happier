import { describe, expect, it, vi } from 'vitest';

import { buildGeminiAuthorizationUrl } from './geminiOauth';

describe('geminiOauth', () => {
  it('builds an authorization URL containing redirect_uri and state', () => {
    const url = buildGeminiAuthorizationUrl({
      redirectUri: 'http://localhost:54545/oauth2callback',
      state: 'st1',
      challenge: 'ch1',
    });
    expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    expect(url).toContain(`redirect_uri=${encodeURIComponent('http://localhost:54545/oauth2callback')}`);
    expect(url).toContain('state=st1');
    expect(url).toContain('code_challenge=ch1');
  });

  it('includes offline access + challenge params', () => {
    const url = buildGeminiAuthorizationUrl({
      redirectUri: 'http://localhost:54545/oauth2callback',
      state: 'st1',
      challenge: 'ch1',
    });
    expect(url).toContain('access_type=offline');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('prompt=consent');
  });
});
