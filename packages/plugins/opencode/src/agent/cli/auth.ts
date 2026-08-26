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

export function extractOpenCodeCliAuthAccountLabel(stdout: string): string | null {
  const email = stdout.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0]?.trim();
  return email && email.length > 0 ? email : null;
}

export async function detectOpenCodeCliAuthStatus(params: Readonly<{
  runAuthList: () => Promise<Readonly<{ ok: boolean; stdout: string }>>;
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

  return {
    state: 'logged_in',
    method: 'oauth_cli',
    source: 'command',
    accountLabel,
  };
}
