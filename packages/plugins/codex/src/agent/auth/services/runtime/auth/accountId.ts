import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function decodeJwtPayload(value: unknown): Record<string, unknown> | null {
  const token = readString(value);
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    return readRecord(JSON.parse(payload));
  } catch {
    return null;
  }
}

export type CodexAuthStoreProviderAccountIdProof =
  | Readonly<{ status: 'resolved'; accountId: string; accountEmail?: string }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'conflict'; accountIds: readonly string[] }>;

export type CodexActiveProviderAccount = Readonly<{
  providerAccountId: string | null;
  providerEmail: string | null;
}>;

export type CodexActiveProviderAccountVerification =
  | Readonly<{ status: 'verified'; providerAccountId: string; reason?: string }>
  | Readonly<{ status: 'weakly_verified'; providerAccountId: string; reason: string }>
  | Readonly<{
      status: 'mismatch';
      expectedProviderAccountId: string;
      actualProviderAccountId: string | null;
      retryable: true;
      reason: string;
    }>
  | Readonly<{ status: 'unavailable'; retryable: true; reason: string }>;

export function readCodexAuthStoreProviderAccountIdFromJson(value: unknown): CodexAuthStoreProviderAccountIdProof {
  const record = readRecord(value);
  if (!record) return { status: 'missing' };
  const tokens = readRecord(record.tokens);
  const tokenIdTokenRecord = readRecord(tokens?.id_token);
  const tokenIdTokenPayload = decodeJwtPayload(tokens?.id_token);
  const ids = [
    readString(record.account_id),
    readString(record.accountId),
    readString(record.chatgptAccountId),
    readString(tokens?.account_id),
    readString(tokenIdTokenRecord?.chatgpt_account_id),
    readString(tokenIdTokenPayload?.chatgpt_account_id),
  ].filter((id): id is string => Boolean(id));
  if (ids.length === 0) return { status: 'missing' };
  const first = ids[0];
  if (ids.every((id) => id === first)) {
    const accountEmail =
      readString(record.email)
      ?? readString(readRecord(record.account)?.email)
      ?? readString(tokens?.email)
      ?? readString(tokenIdTokenRecord?.email)
      ?? readString(tokenIdTokenPayload?.email);
    return {
      status: 'resolved',
      accountId: first,
      ...(accountEmail ? { accountEmail } : {}),
    };
  }
  return { status: 'conflict', accountIds: Array.from(new Set(ids)) };
}

export function readCodexAuthStoreProviderAccountIdProofFromValue(value: unknown): CodexAuthStoreProviderAccountIdProof {
  const accountId = readString(value);
  if (accountId) return { status: 'resolved', accountId };
  const record = readRecord(value);
  if (!record) return { status: 'missing' };
  if (readString(record.status) === 'resolved') {
    const resolvedAccountId = readString(record.accountId);
    const accountEmail = readString(record.accountEmail);
    return resolvedAccountId
      ? {
          status: 'resolved',
          accountId: resolvedAccountId,
          ...(accountEmail ? { accountEmail } : {}),
        }
      : { status: 'missing' };
  }
  if (readString(record.status) === 'conflict') {
    const accountIds = Array.isArray(record.accountIds)
      ? record.accountIds.flatMap((entry) => {
          const parsed = readString(entry);
          return parsed ? [parsed] : [];
        })
      : [];
    return { status: 'conflict', accountIds };
  }
  return { status: 'missing' };
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

export function readCodexActiveProviderAccount(value: unknown): CodexActiveProviderAccount {
  const record = readRecord(value);
  if (!record) return { providerAccountId: null, providerEmail: null };
  const account = readRecord(record.account);
  const auth = readRecord(record.auth);
  const profile = readRecord(record.profile);
  return {
    providerAccountId: readString(record.chatgptAccountId)
      ?? readString(record.chatgpt_account_id)
      ?? readString(record.accountId)
      ?? readString(record.account_id)
      ?? readString(account?.id)
      ?? readString(account?.chatgptAccountId)
      ?? readString(account?.chatgpt_account_id)
      ?? readString(account?.accountId)
      ?? readString(auth?.account_id)
      ?? readString(auth?.chatgptAccountId)
      ?? readString(auth?.chatgpt_account_id)
      ?? readString(profile?.accountId)
      ?? readString(profile?.chatgptAccountId)
      ?? readString(profile?.chatgpt_account_id)
      ?? readString(profile?.providerAccountId),
    providerEmail: normalizeEmail(
      readString(record.email)
        ?? readString(record.emailAddress)
        ?? readString(record.email_address)
        ?? readString(account?.email)
        ?? readString(account?.emailAddress)
        ?? readString(account?.email_address)
        ?? readString(auth?.email)
        ?? readString(profile?.email),
    ),
  };
}

export function verifyCodexActiveProviderAccount(params: Readonly<{
  expectedProviderAccountId: string;
  expectedProviderEmail: string | null;
  rawAccount: unknown;
  authStoreProviderAccountIdProof: CodexAuthStoreProviderAccountIdProof;
}>): CodexActiveProviderAccountVerification {
  const expectedProviderEmail = normalizeEmail(params.expectedProviderEmail);
  const activeAccount = readCodexActiveProviderAccount(params.rawAccount);
  if (activeAccount.providerAccountId) {
    if (activeAccount.providerAccountId !== params.expectedProviderAccountId) {
      return {
        status: 'mismatch',
        expectedProviderAccountId: params.expectedProviderAccountId,
        actualProviderAccountId: activeAccount.providerAccountId,
        retryable: true,
        reason: 'provider_account_adoption_mismatch',
      };
    }
    return {
      status: 'verified',
      providerAccountId: activeAccount.providerAccountId,
    };
  }

  if (params.authStoreProviderAccountIdProof.status === 'conflict') {
    return {
      status: 'mismatch',
      expectedProviderAccountId: params.expectedProviderAccountId,
      actualProviderAccountId: params.authStoreProviderAccountIdProof.accountIds
        .find((accountId) => accountId !== params.expectedProviderAccountId) ?? null,
      retryable: true,
      reason: 'provider_account_auth_store_conflict',
    };
  }

  if (params.authStoreProviderAccountIdProof.status === 'resolved') {
    if (params.authStoreProviderAccountIdProof.accountId !== params.expectedProviderAccountId) {
      return {
        status: 'mismatch',
        expectedProviderAccountId: params.expectedProviderAccountId,
        actualProviderAccountId: params.authStoreProviderAccountIdProof.accountId,
        retryable: true,
        reason: 'provider_account_auth_store_mismatch',
      };
    }
  }

  // Auth-store and email proof can diagnose mismatches, but Codex adoption
  // success must be proven by the live app-server account id.
  return {
    status: 'unavailable',
    retryable: true,
    reason: 'active_account_probe_missing_account_id',
  };
}

export async function readCodexAuthStoreProviderAccountId(
  codexHome: string,
): Promise<CodexAuthStoreProviderAccountIdProof> {
  const normalizedCodexHome = codexHome.trim();
  if (!normalizedCodexHome) return { status: 'missing' };
  let raw: string;
  try {
    raw = await readFile(join(normalizedCodexHome, 'auth.json'), 'utf8');
  } catch {
    return { status: 'missing' };
  }
  try {
    return readCodexAuthStoreProviderAccountIdFromJson(JSON.parse(raw));
  } catch {
    return { status: 'missing' };
  }
}
