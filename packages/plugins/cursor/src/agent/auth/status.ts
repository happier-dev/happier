type CursorEnvironmentReader = Readonly<{
  get(key: string): string | undefined;
}>;

type CursorLegacyCommandRunner = Readonly<{
  run(input: Readonly<{
    kind: 'binary';
    executablePath: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
  }>): Promise<Readonly<{
    stdout: string;
    exitCode: number | null;
  }>>;
}>;

export const CURSOR_API_KEY_ENV = 'CURSOR_API_KEY';
const CURSOR_ABOUT_ARGS = Object.freeze(['about', '--format', 'json'] as const);

export type CursorAuthStatus = Readonly<{
  status: 'logged_in' | 'logged_out' | 'unknown';
  source: 'api_key' | 'about_json' | 'probe_failed';
}>;

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function readUserLikeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readCursorAccountLabel(record: Record<string, unknown> | null): string | null {
  for (const key of ['email', 'emailAddress', 'username', 'displayName', 'name', 'id']) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function materializeCursorAuthEnv(
  env: CursorEnvironmentReader,
): Readonly<Record<typeof CURSOR_API_KEY_ENV, string>> | Readonly<Record<string, never>> {
  const apiKey = env.get(CURSOR_API_KEY_ENV)?.trim() ?? '';
  return apiKey ? { [CURSOR_API_KEY_ENV]: apiKey } : {};
}

export function resolveCursorAuthStatus(params: Readonly<{
  apiKey?: string | null;
  aboutJson?: string | null;
  exitCode?: number | null;
}>): CursorAuthStatus {
  if (hasNonEmptyString(params.apiKey)) {
    return { status: 'unknown', source: 'api_key' };
  }
  const result = interpretCursorCliAuthCommand({
    ok: params.exitCode === 0,
    stdout: params.aboutJson ?? '',
    stderr: '',
    exitCode: params.exitCode ?? null,
  });
  return { status: result.state, source: result.state === 'unknown' ? 'probe_failed' : 'about_json' };
}

/** Interprets only the bounded result of the declared Cursor CLI tool. */
export function interpretCursorCliAuthCommand(params: Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>) {
  if (!params.ok) {
    return { state: 'unknown' as const, reason: 'probe_failed' as const, source: 'command' as const };
  }

  try {
    const parsed = JSON.parse(params.stdout) as unknown;
    const record = readUserLikeRecord(parsed);
    const user = readUserLikeRecord(record?.user ?? record?.userInfo);
    const accountLabel = readCursorAccountLabel(user) ?? readCursorAccountLabel(record);
    return accountLabel
      ? {
        state: 'logged_in' as const,
        method: 'oauth_cli' as const,
        source: 'command' as const,
        accountLabel,
      }
      : { state: 'logged_out' as const, reason: 'missing_credentials' as const, source: 'command' as const };
  } catch {
    return { state: 'unknown' as const, reason: 'probe_failed' as const, source: 'command' as const };
  }
}

export async function checkCursorAuthStatus(params: Readonly<{
  env: CursorEnvironmentReader;
  exec: CursorLegacyCommandRunner;
  executablePath: string;
}>): Promise<CursorAuthStatus> {
  const authEnv = materializeCursorAuthEnv(params.env);
  const apiKey = authEnv[CURSOR_API_KEY_ENV] ?? null;
  try {
    const result = await params.exec.run({
      kind: 'binary',
      executablePath: params.executablePath,
      args: CURSOR_ABOUT_ARGS,
      env: authEnv,
    });
    return resolveCursorAuthStatus({
      apiKey,
      aboutJson: result.stdout,
      exitCode: result.exitCode,
    });
  } catch {
    return resolveCursorAuthStatus({
      apiKey,
      aboutJson: null,
      exitCode: null,
    });
  }
}
