type KiroCliCommandResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

type KiroCliAuthStatus =
  | Readonly<{
    state: 'logged_in';
    method: 'oauth_cli';
    source: 'command';
    accountLabel?: string;
  }>
  | Readonly<{
    state: 'logged_out';
    reason: 'missing_credentials';
    source: 'command';
  }>
  | Readonly<{
    state: 'unknown';
    reason: 'probe_failed';
    source: 'command';
  }>;

export type KiroCliAuthRunCommand = (
  args: readonly string[],
  options?: Readonly<{ timeoutMs?: number }>
) => Promise<KiroCliCommandResult>;

function parseKiroWhoamiAccountLabel(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['email', 'username', 'displayName', 'name']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
  } catch {
    return null;
  }

  return null;
}

export async function detectKiroCliAuthStatus(params: Readonly<{
  runCommand: KiroCliAuthRunCommand;
}>): Promise<KiroCliAuthStatus> {
  const result = await params.runCommand(['whoami', '--format', 'json'], { timeoutMs: 2_000 });

  if (!result.ok) {
    return result.exitCode === null
      ? { state: 'unknown', reason: 'probe_failed', source: 'command' }
      : { state: 'logged_out', reason: 'missing_credentials', source: 'command' };
  }

  const accountLabel = parseKiroWhoamiAccountLabel(result.stdout);
  return {
    state: 'logged_in',
    method: 'oauth_cli',
    source: 'command',
    ...(accountLabel ? { accountLabel } : {}),
  };
}
