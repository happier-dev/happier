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

/** Display label for a Claude plan, e.g. `max` + `default_claude_max_20x` → `Max 20x`. */
export function formatClaudeOauthPlanLabel(metadata: ClaudeOauthCredentialMetadata | null): string | null {
  const subscriptionType = metadata?.subscriptionType ?? null;
  if (!subscriptionType) return metadata?.rateLimitTier ?? null;
  const name = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
  // Only Max plans are sold as usage multipliers (Max 5x / Max 20x); the tier carries the multiplier.
  const multiplier = subscriptionType === 'max' ? /_(\d+x)$/i.exec(metadata?.rateLimitTier ?? '')?.[1] : undefined;
  return multiplier ? `${name} ${multiplier.toLowerCase()}` : name;
}

const ACTIVE_CLAUDE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due']);
const ENDED_CLAUDE_SUBSCRIPTION_STATUSES = new Set(['canceled', 'cancelled', 'expired', 'inactive']);
const PAID_CLAUDE_ORGANIZATION_TYPES = new Set(['claude_max', 'claude_pro', 'claude_team', 'claude_enterprise']);

/**
 * Subscription status attested by the OAuth profile. The profile exposes no renewal or
 * period end, so callers must not infer either. `null` means the payload carries no evidence.
 */
export function readClaudeOauthProfileSubscriptionStatus(value: unknown): 'subscribed' | 'none' | null {
  const root = readObject(value);
  if (!root) return null;
  const account = readObject(root.account);
  const organization = readObject(root.organization);
  const status = (readString(organization?.subscription_status) ?? readString(root.subscription_status))?.toLowerCase();
  if (status && ACTIVE_CLAUDE_SUBSCRIPTION_STATUSES.has(status)) return 'subscribed';
  if (status && ENDED_CLAUDE_SUBSCRIPTION_STATUSES.has(status)) return 'none';
  if (status) return null;
  const organizationType = readString(organization?.organization_type);
  return (organizationType && PAID_CLAUDE_ORGANIZATION_TYPES.has(organizationType))
    || account?.has_claude_max === true || account?.has_claude_pro === true ? 'subscribed' : null;
}
