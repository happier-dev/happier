export type OpenCodeCliAuthProbeResult =
  | Readonly<{
    state: 'logged_in';
    method: 'oauth_cli';
    source: 'command';
    accountLabel: string | null;
  }>
  | Readonly<{
    state: 'logged_out';
    reason: 'missing_credentials' | 'probe_failed';
    method: 'oauth_cli';
    source: 'command' | 'mixed';
    accountLabel: string | null;
  }>;

export type OpenCodeOauthRefreshTokenProbeResult = 'valid' | 'invalid' | 'unknown';

export function extractOpenCodeCliAuthAccountLabel(stdout: string): string | null {
  const email = stdout.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0]?.trim();
  return email && email.length > 0 ? email : null;
}

export function resolveOpenCodeCliAuthProbeTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = Number(env.HAPPIER_OPENCODE_CLI_AUTH_PROBE_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return 6000;
  return Math.max(250, Math.trunc(raw));
}

export async function detectOpenCodeCliAuthStatus(params: Readonly<{
  runAuthList: () => Promise<Readonly<{ ok: boolean; stdout: string }>>;
  readOauthRefreshToken: () => Promise<string | null> | string | null;
  probeOauthRefreshToken: (refreshToken: string) => Promise<OpenCodeOauthRefreshTokenProbeResult>;
}>): Promise<OpenCodeCliAuthProbeResult> {
  const command = await params.runAuthList();
  const accountLabel = extractOpenCodeCliAuthAccountLabel(command.stdout);
  if (!command.ok) {
    return {
      state: 'logged_out',
      reason: 'missing_credentials',
      method: 'oauth_cli',
      source: 'command',
      accountLabel,
    };
  }

  if (!command.stdout.trim()) {
    return {
      state: 'logged_out',
      reason: 'missing_credentials',
      method: 'oauth_cli',
      source: 'command',
      accountLabel,
    };
  }

  const refreshToken = await params.readOauthRefreshToken();
  if (refreshToken) {
    const probe = await params.probeOauthRefreshToken(refreshToken);
    if (probe === 'invalid') {
      return {
        state: 'logged_out',
        reason: 'probe_failed',
        method: 'oauth_cli',
        source: 'mixed',
        accountLabel,
      };
    }
  }

  return {
    state: 'logged_in',
    method: 'oauth_cli',
    source: 'command',
    accountLabel,
  };
}
