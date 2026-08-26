export const CODEX_CLI_AUTH_STATUS_ARGS = ['login', 'status'] as const;
export const DEFAULT_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS = 6_000;

export type CodexCliAuthCommandStatus = Readonly<{
  ok: boolean;
  exitCode: number | null;
}>;

export type CodexCliAuthStatusDraft = Readonly<{
  state: 'logged_in' | 'logged_out' | 'unknown';
  method?: 'api_key_env' | 'credentials_file' | 'oauth_cli' | null;
  accountLabel?: string | null;
  reason?: 'missing_credentials' | 'probe_failed' | null;
  source?: 'env' | 'file' | 'command' | null;
}>;

export function resolveCodexCliAuthStatus(params: Readonly<{
  commandStatus: CodexCliAuthCommandStatus;
}>): CodexCliAuthStatusDraft {
  if (params.commandStatus.ok) {
    return {
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
    };
  }

  return {
    state: params.commandStatus.exitCode === null ? 'unknown' : 'logged_out',
    reason: params.commandStatus.exitCode === null ? 'probe_failed' : 'missing_credentials',
    ...(params.commandStatus.exitCode === null ? { source: 'command' as const } : {}),
  };
}
