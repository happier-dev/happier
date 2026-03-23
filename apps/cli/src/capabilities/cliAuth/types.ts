export type CliAuthState = 'logged_in' | 'logged_out' | 'unknown';

export type CliAuthMethod =
  | 'api_key_env'
  | 'auth_token_env'
  | 'credentials_file'
  | 'oauth_cli'
  | 'config_file'
  | 'gcloud_adc'
  | 'unknown';

export type CliAuthReason =
  | 'missing_credentials'
  | 'expired'
  | 'cli_missing'
  | 'probe_failed'
  | 'timeout'
  | 'unsupported'
  | 'interactive_blocked'
  | 'not_configured';

export type CliAuthSource = 'env' | 'file' | 'command' | 'mixed';

export type CliAuthStatus = Readonly<{
  state: CliAuthState;
  method?: CliAuthMethod | null;
  accountLabel?: string | null;
  reason?: CliAuthReason | null;
  source?: CliAuthSource | null;
  checkedAt: number;
}>;

export type CliAuthStatusDraft = Omit<CliAuthStatus, 'checkedAt'>;

export type CliAuthSpec = Readonly<{
  binaryNames: ReadonlyArray<string>;
  detectAuthStatus?: (args: Readonly<{ resolvedPath: string }>) => Promise<CliAuthStatusDraft>;
}>;
