const CODEX_APP_SERVER_OVERRIDE_KEYS = [
  'HAPPIER_CODEX_APP_SERVER_BIN',
  'HAPPIER_CODEX_TUI_BIN',
  'HAPPY_CODEX_TUI_BIN',
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

export function readCodexAppServerOverrideCommand(env: Environment): string | null {
  for (const key of CODEX_APP_SERVER_OVERRIDE_KEYS) {
    const value = typeof env[key] === 'string' ? env[key].trim() : '';
    if (value) return value;
  }
  return null;
}

export function looksLikeCodexAppServerFilePath(command: string): boolean {
  return command.includes('/') || command.includes('\\') || command.startsWith('.');
}

export function readCodexAppServerProbeTimeoutMs(env: Environment): number {
  const parsed = Number.parseInt(String(env.HAPPIER_CODEX_APP_SERVER_PROBE_TIMEOUT_MS ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1_500;
}
