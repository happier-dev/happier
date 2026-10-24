import { readFile } from 'node:fs/promises';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export type ClaudeRootConfigJson = Record<string, unknown>;

function readObject(value: unknown): ClaudeRootConfigJson | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as ClaudeRootConfigJson
    : null;
}

export async function readClaudeRootConfigFile(path: string): Promise<ClaudeRootConfigJson | null> {
  try {
    return readObject(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

export function sanitizeClaudeOauthAccountProjection(value: unknown): ClaudeRootConfigJson | null {
  const oauthAccount = readObject(value);
  if (!oauthAccount) return null;
  const sanitizedEntries = Object.entries(oauthAccount).filter(([key]) => !key.toLowerCase().includes('token'));
  if (sanitizedEntries.length === 0) return null;
  return Object.fromEntries(sanitizedEntries);
}

export function sanitizeClaudeRootConfig(
  rootConfig: ClaudeRootConfigJson,
): ClaudeRootConfigJson {
  const sanitizedOauthAccount = sanitizeClaudeOauthAccountProjection(rootConfig.oauthAccount);
  if (sanitizedOauthAccount) {
    return {
      ...rootConfig,
      oauthAccount: sanitizedOauthAccount,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(rootConfig, 'oauthAccount')) {
    return rootConfig;
  }
  const { oauthAccount: _ignoredOauthAccount, ...rest } = rootConfig;
  return rest;
}

export async function sanitizeClaudeRootConfigFile(path: string): Promise<void> {
  const rootConfig = await readClaudeRootConfigFile(path);
  if (!rootConfig) return;
  await writeJsonAtomic(path, sanitizeClaudeRootConfig(rootConfig));
}

const CLAUDE_ACCOUNT_SCOPED_ROOT_KEYS = [
  'oauthAccount',
  'modelAccessCache',
  'additionalModelOptionsCache',
  'cachedExtraUsageDisabledReason',
] as const;

export function reconcileClaudeAccountScopedRootConfig(params: Readonly<{
  rootConfig: ClaudeRootConfigJson;
  preserveExistingAccountState: boolean;
  providerAccountId: string | null;
  providerEmail: string | null;
  providerOrganizationId?: string | null;
}>): ClaudeRootConfigJson {
  // This owner is invoked only after exact native credential materialization succeeds.
  // Provider onboarding readiness is distinct from workspace trust, which remains unsynthesized.
  const providerReadyRoot = {
    ...params.rootConfig,
    hasCompletedOnboarding: true,
  };
  const existingOrganizationId = readClaudeOauthAccountIdentity(params.rootConfig.oauthAccount).providerOrganizationId;
  const organizationMatches = params.providerOrganizationId === undefined
    || existingOrganizationId === params.providerOrganizationId;
  if (params.preserveExistingAccountState && organizationMatches) return sanitizeClaudeRootConfig(providerReadyRoot);
  const next: ClaudeRootConfigJson = { ...providerReadyRoot };
  for (const key of CLAUDE_ACCOUNT_SCOPED_ROOT_KEYS) delete next[key];
  const oauthAccount = {
    ...(params.providerAccountId ? { accountUuid: params.providerAccountId } : {}),
    ...(params.providerEmail ? { emailAddress: params.providerEmail } : {}),
    ...(params.providerOrganizationId ? { organizationUuid: params.providerOrganizationId } : {}),
  };
  return Object.keys(oauthAccount).length > 0 ? { ...next, oauthAccount } : next;
}

export async function reconcileClaudeAccountScopedRootConfigFile(params: Readonly<{
  path: string;
  preserveExistingAccountState: boolean;
  providerAccountId: string | null;
  providerEmail: string | null;
  providerOrganizationId?: string | null;
}>): Promise<void> {
  const rootConfig = await readClaudeRootConfigFile(params.path) ?? {};
  await writeJsonAtomic(params.path, reconcileClaudeAccountScopedRootConfig({
    rootConfig,
    preserveExistingAccountState: params.preserveExistingAccountState,
    providerAccountId: params.providerAccountId,
    providerEmail: params.providerEmail,
    providerOrganizationId: params.providerOrganizationId,
  }));
}

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readClaudeOauthAccountIdentity(value: unknown): Readonly<{
  email: string | null;
  accountId: string | null;
  providerOrganizationId: string | null;
}> {
  const oauthAccount = readObject(value);
  if (!oauthAccount) {
    return {
      email: null,
      accountId: null,
      providerOrganizationId: null,
    };
  }
  return {
    email: readNonBlankString(oauthAccount.emailAddress) ?? readNonBlankString(oauthAccount.email),
    accountId: readNonBlankString(oauthAccount.accountUuid)
      ?? readNonBlankString(oauthAccount.id)
      ?? readNonBlankString(oauthAccount.uuid),
    providerOrganizationId: readNonBlankString(oauthAccount.organizationUuid),
  };
}
