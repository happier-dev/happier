import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ClaudeNativeAccountIdentity = Readonly<{
  providerAccountId: string | null;
  providerEmail: string | null;
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
  return { providerAccountId, providerEmail, accountLabel };
}

export async function readClaudeNativeAccountIdentityFromConfigDir(
  claudeConfigDir: string,
): Promise<ClaudeNativeAccountIdentity | null> {
  try {
    const rootConfig = JSON.parse(await readFile(join(claudeConfigDir, '.claude.json'), 'utf8')) as unknown;
    return readClaudeNativeAccountIdentity(rootConfig);
  } catch {
    return null;
  }
}
