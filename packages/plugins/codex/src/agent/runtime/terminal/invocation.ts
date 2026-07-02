import { join } from 'node:path';

export type CodexTerminalRolloutDiscoveryConfig = Readonly<{
  initialTimeoutMs: number;
  initialPollIntervalMs: number;
  extendedPollIntervalMs: number;
}>;

export const DEFAULT_CODEX_TERMINAL_ROLLOUT_DISCOVERY_CONFIG: CodexTerminalRolloutDiscoveryConfig = {
  initialTimeoutMs: 30_000,
  initialPollIntervalMs: 500,
  extendedPollIntervalMs: 2_000,
};

export type CodexTerminalPermissionPolicy = Readonly<{
  approvalPolicy: string;
  sandbox: string;
}>;

export type CodexTerminalEnv = Readonly<Record<string, string | undefined>>;

export function resolveCodexTerminalRolloutDiscoveryConfig(
  overrides?: Partial<CodexTerminalRolloutDiscoveryConfig> | null,
): CodexTerminalRolloutDiscoveryConfig {
  return {
    initialTimeoutMs: typeof overrides?.initialTimeoutMs === 'number'
      ? overrides.initialTimeoutMs
      : DEFAULT_CODEX_TERMINAL_ROLLOUT_DISCOVERY_CONFIG.initialTimeoutMs,
    initialPollIntervalMs: typeof overrides?.initialPollIntervalMs === 'number'
      ? overrides.initialPollIntervalMs
      : DEFAULT_CODEX_TERMINAL_ROLLOUT_DISCOVERY_CONFIG.initialPollIntervalMs,
    extendedPollIntervalMs: typeof overrides?.extendedPollIntervalMs === 'number'
      ? overrides.extendedPollIntervalMs
      : DEFAULT_CODEX_TERMINAL_ROLLOUT_DISCOVERY_CONFIG.extendedPollIntervalMs,
  };
}

export function resolveCodexTerminalSessionsRootDir(params: Readonly<{
  env: CodexTerminalEnv;
  homeDir: string;
}>): string {
  const override =
    typeof params.env.HAPPIER_CODEX_SESSIONS_DIR === 'string'
      ? params.env.HAPPIER_CODEX_SESSIONS_DIR.trim()
      : typeof params.env.HAPPY_CODEX_SESSIONS_DIR === 'string'
        ? params.env.HAPPY_CODEX_SESSIONS_DIR.trim()
        : '';
  if (override) return override;
  const codexHome = typeof params.env.CODEX_HOME === 'string' ? params.env.CODEX_HOME.trim() : '';
  if (codexHome) return join(codexHome, 'sessions');
  return join(params.homeDir, '.codex', 'sessions');
}

export function buildCodexTerminalChildEnv(params: Readonly<{
  env: CodexTerminalEnv;
}>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...params.env };
  const preserveRaw =
    typeof params.env.HAPPIER_CODEX_TUI_PRESERVE_CODEX_ENV_KEYS === 'string'
      ? params.env.HAPPIER_CODEX_TUI_PRESERVE_CODEX_ENV_KEYS.trim()
      : '';
  const preserveKeys = new Set<string>(
    preserveRaw
      ? preserveRaw
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.startsWith('CODEX_'))
      : [],
  );
  preserveKeys.add('CODEX_HOME');

  for (const key of ['CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_SHELL'] as const) {
    if (preserveKeys.has(key)) continue;
    delete env[key];
  }
  return env;
}

export function buildCodexTerminalArgs<PermissionMode extends string>(opts: Readonly<{
  cwd: string;
  resumeId?: string | null;
  permissionMode: PermissionMode;
  codexArgs?: readonly string[];
  resolvePermissionPolicy: (permissionMode: PermissionMode) => CodexTerminalPermissionPolicy;
}>): string[] {
  const args: string[] = [];

  const resumeId = normalizeCodexTerminalSessionId(opts.resumeId);
  if (resumeId) {
    args.push('resume', resumeId);
  }

  args.push('--cd', opts.cwd);

  if (opts.permissionMode !== 'default') {
    const { approvalPolicy, sandbox } = opts.resolvePermissionPolicy(opts.permissionMode);
    args.push('--ask-for-approval', approvalPolicy);
    args.push('--sandbox', sandbox);
  }

  args.push(...(opts.codexArgs ?? []));
  return args;
}

export function normalizeCodexTerminalSessionId(raw: unknown): string | null {
  const next = typeof raw === 'string' ? raw.trim() : '';
  return next.length > 0 ? next : null;
}
