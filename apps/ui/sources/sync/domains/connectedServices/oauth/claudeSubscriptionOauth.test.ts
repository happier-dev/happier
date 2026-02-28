import { describe, expect, it } from 'vitest';

import { buildClaudeSubscriptionAuthorizationUrl, CLAUDE_SUBSCRIPTION_OAUTH } from './claudeSubscriptionOauth';

describe('claudeSubscriptionOauth', () => {
  it('uses the console callback redirect URI by default', () => {
    const url = buildClaudeSubscriptionAuthorizationUrl({
      redirectUri: CLAUDE_SUBSCRIPTION_OAUTH.defaultRedirectUri,
      state: 'st1',
      challenge: 'ch1',
    });

    expect(url).toContain(`redirect_uri=${encodeURIComponent('https://platform.claude.com/oauth/code/callback')}`);
  });
});
