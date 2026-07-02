export type CodexAuthTokens = Readonly<{
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
  expires_in?: number;
  expires_at?: number | null;
}>;

export type CodexCloudAuthenticateOptions = Readonly<{
  paste?: boolean;
  device?: boolean;
  noOpen?: boolean;
  timeoutSeconds?: number;
}>;
