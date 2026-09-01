export type CodexLiveAccountIdentity = Readonly<{
  activeAccountId: string | null;
  accountLabel: string | null;
}>;

type CodexAccountReadClient = Readonly<{
  request(
    method: 'account/read',
    params: Record<string, never>,
    options?: Readonly<{ timeoutMs?: number | null }>,
  ): Promise<unknown>;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const parsed = readString(value);
    if (parsed) return parsed;
  }
  return null;
}

export function readCodexLiveAccountIdentity(value: unknown): CodexLiveAccountIdentity {
  const response = readRecord(value);
  const account = readRecord(response?.account);
  const auth = readRecord(response?.auth);
  const profile = readRecord(response?.profile);
  return {
    activeAccountId: firstString(
      response?.chatgptAccountId,
      response?.chatgpt_account_id,
      response?.accountId,
      response?.account_id,
      account?.id,
      account?.accountId,
      account?.account_id,
      account?.chatgptAccountId,
      account?.chatgpt_account_id,
      auth?.account_id,
      auth?.accountId,
      auth?.chatgptAccountId,
      auth?.chatgpt_account_id,
      profile?.accountId,
      profile?.providerAccountId,
      profile?.account_id,
      profile?.chatgptAccountId,
      profile?.chatgpt_account_id,
      response?.id,
    ),
    accountLabel: firstString(
      account?.email,
      account?.accountEmail,
      account?.account_email,
      response?.email,
      response?.accountEmail,
      response?.account_email,
      auth?.email,
      profile?.email,
    ),
  };
}

export async function readCodexLiveAccountIdentityFromClient(
  client: CodexAccountReadClient,
  requestOptions?: Readonly<{ timeoutMs?: number | null }>,
): Promise<CodexLiveAccountIdentity> {
  return readCodexLiveAccountIdentity(await client.request('account/read', {}, requestOptions));
}
