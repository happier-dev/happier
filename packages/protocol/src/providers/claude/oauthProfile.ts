export type ClaudeOauthEntitlementMetadata = Readonly<{
  claudeAiOauth: Readonly<{
    subscriptionType?: string;
    rateLimitTier?: string;
  }>;
}>;

export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_OAUTH_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
export const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_OAUTH_CALLBACK_URL = 'https://platform.claude.com/oauth/code/callback';
export const CLAUDE_OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
export const CLAUDE_OAUTH_PROFILE_HEADERS = Object.freeze({
  'anthropic-beta': 'oauth-2025-04-20',
} as const);

function readObject(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeClaudeOauthProfileEntitlement(value: unknown): ClaudeOauthEntitlementMetadata | null {
  const root = readObject(value);
  const account = readObject(root?.account);
  const organization = readObject(root?.organization);
  if (!root || (!account && !organization)) return null;
  const organizationType = readString(organization?.organization_type);
  const subscriptionType = organizationType === 'claude_max' || account?.has_claude_max === true
    ? 'max'
    : organizationType === 'claude_pro' || account?.has_claude_pro === true
      ? 'pro'
      : null;
  const rateLimitTier = readString(organization?.rate_limit_tier);
  if (!subscriptionType && !rateLimitTier) return null;
  return {
    claudeAiOauth: {
      ...(subscriptionType ? { subscriptionType } : {}),
      ...(rateLimitTier ? { rateLimitTier } : {}),
    },
  };
}

export function projectConnectedAccountOauthProfileMetadata(params: Readonly<{
  projection: 'claude_oauth_profile_entitlement';
  value: unknown;
}>): ClaudeOauthEntitlementMetadata | null {
  return normalizeClaudeOauthProfileEntitlement(params.value);
}
