import type { CodexEnvironmentAuthState } from './environment.js';

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

export function resolveCodexCliAuthProbeTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS;
  const parsed = typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS;
}

export function resolveCodexCliAuthStatus(params: Readonly<{
  commandStatus: CodexCliAuthCommandStatus;
  environmentAuth: CodexEnvironmentAuthState;
}>): CodexCliAuthStatusDraft {
  if (params.commandStatus.ok) {
    return {
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      reason: null,
      ...(params.environmentAuth.accountLabel ? { accountLabel: params.environmentAuth.accountLabel } : {}),
    };
  }

  if (params.environmentAuth.method === 'api_key_env') {
    return {
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    };
  }

  if (params.commandStatus.exitCode === null && params.environmentAuth.method === 'credentials_file') {
    return {
      state: 'logged_in',
      method: 'credentials_file',
      source: 'file',
      ...(params.environmentAuth.accountLabel ? { accountLabel: params.environmentAuth.accountLabel } : {}),
    };
  }

  return {
    state: params.commandStatus.exitCode === null ? 'unknown' : 'logged_out',
    reason: params.commandStatus.exitCode === null ? 'probe_failed' : 'missing_credentials',
    source: params.commandStatus.exitCode === null ? 'command' : null,
  };
}
