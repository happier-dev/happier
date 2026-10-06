export type CodexCloudAuthFileTokens = Readonly<{
  accessToken: string;
  idToken: string | null;
  accountId: string | null;
}>;

export type CodexCloudAuthFile = Readonly<{
  auth_mode: 'chatgptAuthTokens';
  OPENAI_API_KEY: null;
  access_token: string;
  refresh_token: '';
  id_token: string;
  account_id: string | null;
  tokens: Readonly<{
    access_token: string;
    refresh_token: '';
    id_token: string;
    account_id: string | null;
  }>;
  last_refresh: string;
}>;

export function buildCodexCloudAuthFile(params: CodexCloudAuthFileTokens & Readonly<{ lastRefreshIso: string }>): CodexCloudAuthFile {
  const tokens = {
    access_token: params.accessToken,
    // Codex's TokenData requires this field, but external auth has no rotation authority.
    refresh_token: '',
    id_token: params.idToken ?? params.accessToken,
    account_id: params.accountId,
  } as const;
  return {
    auth_mode: 'chatgptAuthTokens',
    OPENAI_API_KEY: null,
    ...tokens,
    tokens,
    last_refresh: params.lastRefreshIso,
  };
}
