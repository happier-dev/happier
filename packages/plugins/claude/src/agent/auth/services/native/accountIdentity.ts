import { computeConnectedAccountAccessTokenFingerprint } from '@happier-dev/plugin-sdk/connected-accounts';
import { readClaudeCodeNativeCredentialPayload, type ClaudeCodeNativeCredentialPayload } from './credentials.js';

export type ClaudeNativeAccountIdentity = Readonly<{
  providerAccountId: string | null;
  providerEmail: string | null;
  providerOrganizationId: string | null;
  accountLabel: string | null;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readClaudeNativeAccountIdentity(rootConfig: unknown): ClaudeNativeAccountIdentity | null {
  const root = readRecord(rootConfig);
  const oauthAccount = readRecord(root?.oauthAccount);
  if (!oauthAccount) return null;
  const providerAccountId = readString(oauthAccount.accountUuid) ?? readString(oauthAccount.uuid);
  const providerEmail = readString(oauthAccount.emailAddress) ?? readString(oauthAccount.email);
  const accountLabel = providerEmail
    ?? readString(oauthAccount.displayName)
    ?? readString(oauthAccount.name);
  if (!providerAccountId && !providerEmail && !accountLabel) return null;
  return { providerAccountId, providerEmail, providerOrganizationId: readString(oauthAccount.organizationUuid), accountLabel };
}

/** Capture native account qualification once for the provider request that used it. */
export function readClaudeNativeUsageIdentity(rootConfig: unknown, nativeCredential: unknown) {
  const identity = readClaudeNativeAccountIdentity(rootConfig);
  const credential = readClaudeCodeNativeCredentialPayload(nativeCredential);
  return { identity, credentialProof: identity?.providerAccountId && credential ? {
    providerAccountId: identity.providerAccountId,
    credentialFingerprint: computeConnectedAccountAccessTokenFingerprint(credential.claudeAiOauth.accessToken),
  } : null };
}

/** Reconcile only the selected native home's account context; workspace trust stays intact. */
export function reconcileClaudeNativeAccountConfig(input: Readonly<{
  rootConfig: unknown;
  nativeCredential?: ClaudeCodeNativeCredentialPayload;
  previousCredential?: unknown;
  providerAccountId: string | null;
  providerEmail: string | null;
  providerOrganizationId: string | null;
}>): Readonly<Record<string, unknown>> {
  const root = { ...(readRecord(input.rootConfig) ?? {}), hasCompletedOnboarding: true };
  const existing = readClaudeNativeAccountIdentity(root);
  const previous = readClaudeCodeNativeCredentialPayload(input.previousCredential);
  const samePlan = previous !== null && input.nativeCredential !== undefined
    && previous.claudeAiOauth.subscriptionType === input.nativeCredential.claudeAiOauth.subscriptionType
    && previous.claudeAiOauth.rateLimitTier === input.nativeCredential.claudeAiOauth.rateLimitTier;
  const sameContext = Boolean(samePlan && input.providerAccountId && input.providerOrganizationId
    && existing?.providerAccountId === input.providerAccountId
    && existing.providerOrganizationId === input.providerOrganizationId);
  const next: Record<string, unknown> = { ...root };
  if (!sameContext) {
    for (const key of ['oauthAccount', 'modelAccessCache', 'additionalModelOptionsCache', 'cachedExtraUsageDisabledReason']) delete next[key];
  }
  const previousAccount = sameContext ? readRecord(next.oauthAccount) : null;
  const safeAccount = Object.fromEntries(Object.entries(previousAccount ?? {}).filter(([key]) => !key.toLowerCase().includes('token')));
  const oauthAccount = {
    ...safeAccount,
    ...(input.providerAccountId ? { accountUuid: input.providerAccountId } : {}),
    ...(input.providerEmail ? { emailAddress: input.providerEmail } : {}),
    ...(input.providerOrganizationId ? { organizationUuid: input.providerOrganizationId } : {}),
  };
  if (Object.keys(oauthAccount).length > 0) next.oauthAccount = oauthAccount;
  return next;
}
