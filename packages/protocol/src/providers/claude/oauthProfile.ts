export type ClaudeOauthCredentialMetadata = Readonly<{
  subscriptionType?: string;
  rateLimitTier?: string;
  organizationUuid?: string;
}>;

export type ClaudeOauthEntitlementMetadata = Readonly<{
  claudeAiOauth: ClaudeOauthCredentialMetadata;
}>;

function readObject(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readClaudeOauthCredentialMetadata(raw: unknown): ClaudeOauthCredentialMetadata | null {
  const root = readObject(raw);
  const native = readObject(root?.claudeAiOauth) ?? readObject(root?.['claude.ai_oauth']);
  const subscriptionType = readString(native?.subscriptionType);
  const rateLimitTier = readString(native?.rateLimitTier);
  const organizationUuid = readString(native?.organizationUuid);
  if (!subscriptionType && !rateLimitTier && !organizationUuid) return null;
  return {
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(rateLimitTier ? { rateLimitTier } : {}),
    ...(organizationUuid ? { organizationUuid } : {}),
  };
}

export function readClaudeOauthCredentialOrganizationId(raw: unknown): string | null {
  return readClaudeOauthCredentialMetadata(raw)?.organizationUuid ?? null;
}

/** Project provider-attested profile/token facts; never retain arbitrary provider payloads. */
export function normalizeClaudeOauthProfileEntitlement(value: unknown): ClaudeOauthEntitlementMetadata | null {
  const root = readObject(value);
  if (!root) return null;
  const account = readObject(root.account);
  const organization = readObject(root.organization);
  const native = readObject(root.claudeAiOauth) ?? readObject(root['claude.ai_oauth']);
  const nativeMetadata = readClaudeOauthCredentialMetadata(root);
  const organizationType = readString(organization?.organization_type);
  const subscriptionType = nativeMetadata?.subscriptionType ?? readString(native?.subscription_type)
    ?? readString(root.subscriptionType) ?? readString(root.subscription_type)
    ?? (organizationType === 'claude_max' || account?.has_claude_max === true
      ? 'max'
      : organizationType === 'claude_pro' || account?.has_claude_pro === true ? 'pro' : null);
  const rateLimitTier = nativeMetadata?.rateLimitTier ?? readString(native?.rate_limit_tier)
    ?? readString(root.rateLimitTier) ?? readString(root.rate_limit_tier) ?? readString(organization?.rate_limit_tier);
  const organizationUuid = readString(organization?.uuid) ?? readString(root.organization_uuid)
    ?? nativeMetadata?.organizationUuid;
  if (!subscriptionType && !rateLimitTier && !organizationUuid) return null;
  return { claudeAiOauth: {
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(rateLimitTier ? { rateLimitTier } : {}),
    ...(organizationUuid ? { organizationUuid } : {}),
  } };
}
