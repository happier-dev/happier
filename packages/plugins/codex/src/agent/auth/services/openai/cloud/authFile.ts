export type CodexCloudAuthFileTokens = Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  accountId: string | null;
}>;

export type CodexCloudAuthFile = Readonly<{
  auth_mode: 'chatgpt';
  OPENAI_API_KEY: null;
  access_token: string;
  refresh_token: string;
  id_token: string | null;
  account_id: string | null;
  tokens: Readonly<{
    access_token: string;
    refresh_token: string;
    id_token: string | null;
    account_id: string | null;
  }>;
  last_refresh: string;
}>;

export function buildCodexCloudAuthFile(params: CodexCloudAuthFileTokens & Readonly<{ lastRefreshIso: string }>): CodexCloudAuthFile {
  const tokens = {
    access_token: params.accessToken,
    refresh_token: params.refreshToken,
    id_token: params.idToken,
    account_id: params.accountId,
  } as const;
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    ...tokens,
    tokens,
    last_refresh: params.lastRefreshIso,
  };
}
