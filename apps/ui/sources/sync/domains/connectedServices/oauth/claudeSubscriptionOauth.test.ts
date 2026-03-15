import { describe, expect, it } from 'vitest';

import { buildClaudeSubscriptionAuthorizationUrl, CLAUDE_SUBSCRIPTION_OAUTH } from './claudeSubscriptionOauth';

describe('claudeSubscriptionOauth', () => {
  it('uses the console callback redirect URI by default', () => {
    const url = buildClaudeSubscriptionAuthorizationUrl({
      redirectUri: CLAUDE_SUBSCRIPTION_OAUTH.defaultRedirectUri,
      state: 'st1',
      challenge: 'ch1',
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(parsed.searchParams.get('scope')).toBe('user:inference user:profile');
  });
});
