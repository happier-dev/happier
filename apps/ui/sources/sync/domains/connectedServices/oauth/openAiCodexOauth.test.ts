import { describe, expect, it } from 'vitest';

import { buildOpenAiCodexAuthorizationUrl } from './openAiCodexOauth';

describe('openAiCodexOauth', () => {
  it('builds an authorization URL with redirect_uri, state, and code_challenge', () => {
    const url = buildOpenAiCodexAuthorizationUrl({
      redirectUri: 'http://localhost:1455/auth/callback',
      state: 'st1',
      challenge: 'ch1',
    });
    expect(url).toContain('https://auth.openai.com/oauth/authorize?');
    expect(url).toContain(`redirect_uri=${encodeURIComponent('http://localhost:1455/auth/callback')}`);
    expect(url).toContain('state=st1');
    expect(url).toContain('code_challenge=ch1');
  });
});
