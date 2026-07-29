import { describe, expect, it } from 'vitest';
import {
  CLAUDE_OAUTH_AUTHORIZE_URL,
  CLAUDE_OAUTH_TOKEN_URL,
  normalizeClaudeOauthProfileEntitlement,
} from './oauthProfile';

describe('normalizeClaudeOauthProfileEntitlement', () => {
  it('uses Claude Code current OAuth endpoints', () => {
    expect(CLAUDE_OAUTH_AUTHORIZE_URL).toBe('https://platform.claude.com/oauth/authorize');
    expect(CLAUDE_OAUTH_TOKEN_URL).toBe('https://platform.claude.com/v1/oauth/token');
  });

  it('projects only native Claude plan facts', () => {
    expect(normalizeClaudeOauthProfileEntitlement({
      account: { has_claude_max: true, email: 'not-retained@example.test' },
      organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
    })).toEqual({
      claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
    });
  });
});
