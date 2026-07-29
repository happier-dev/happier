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

const CURSOR_API_KEY_ENV = 'CURSOR_API_KEY';
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
    return { status: 'logged_in', source: 'api_key' };
  }
  if (params.exitCode !== 0 || !hasNonEmptyString(params.aboutJson)) {
    return { status: 'unknown', source: 'probe_failed' };
  }

  try {
    const parsed = JSON.parse(params.aboutJson ?? '{}') as unknown;
    const record = readUserLikeRecord(parsed);
    const user = readUserLikeRecord(record?.user ?? record?.userInfo);
    if (hasNonEmptyString(user?.email) || hasNonEmptyString(user?.id) || hasNonEmptyString(record?.email)) {
      return { status: 'logged_in', source: 'about_json' };
    }
    return { status: 'logged_out', source: 'about_json' };
  } catch {
    return { status: 'unknown', source: 'probe_failed' };
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
