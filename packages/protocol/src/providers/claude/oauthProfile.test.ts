import { describe, expect, it } from 'vitest';
import {
  CLAUDE_OAUTH_AUTHORIZE_URL,
  CLAUDE_OAUTH_CALLBACK_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_PROFILE_HEADERS,
  CLAUDE_OAUTH_PROFILE_URL,
  CLAUDE_OAUTH_TOKEN_URL,
  normalizeClaudeOauthProfileEntitlement,
} from './oauthProfile';

describe('normalizeClaudeOauthProfileEntitlement', () => {
  it('uses Claude Code current token endpoint', () => {
    expect(CLAUDE_OAUTH_CLIENT_ID).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(CLAUDE_OAUTH_AUTHORIZE_URL).toBe('https://claude.com/cai/oauth/authorize');
    expect(CLAUDE_OAUTH_CALLBACK_URL).toBe('https://platform.claude.com/oauth/code/callback');
    expect(CLAUDE_OAUTH_TOKEN_URL).toBe('https://platform.claude.com/v1/oauth/token');
    expect(CLAUDE_OAUTH_PROFILE_URL).toBe('https://api.anthropic.com/api/oauth/profile');
    expect(CLAUDE_OAUTH_PROFILE_HEADERS).toEqual({
      'anthropic-beta': 'oauth-2025-04-20',
    });
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
