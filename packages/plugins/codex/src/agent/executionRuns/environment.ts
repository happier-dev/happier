export const CODEX_EXECUTION_RUN_PROCESS_ENV_KEYS = [
  'HAPPIER_CODEX_APP_SERVER_BIN',
  'HAPPIER_CODEX_TUI_BIN',
  'HAPPY_CODEX_TUI_BIN',
  'HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT',
  'HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS',
  'HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS',
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

export function buildCodexExecutionRunBaseEnv(args: Readonly<{
  processEnv: Environment;
  isolationEnv?: Environment;
}>): Record<string, string | undefined> | undefined {
  const inheritedEnv: Record<string, string> = {};
  for (const key of CODEX_EXECUTION_RUN_PROCESS_ENV_KEYS) {
    const value = args.processEnv[key];
    if (typeof value === 'string' && value.length > 0) {
      inheritedEnv[key] = value;
    }
  }

  if (Object.keys(inheritedEnv).length === 0) {
    return args.isolationEnv;
  }

  return {
    ...inheritedEnv,
    ...(args.isolationEnv ?? {}),
  };
}
