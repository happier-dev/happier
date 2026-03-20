export type ResolvedTerminalShell = Readonly<{
  file: string;
  args: readonly string[];
}>;

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function shouldUseLoginArgs(file: string): boolean {
  const lower = file.toLowerCase();
  return lower.endsWith('/zsh') || lower.endsWith('/bash') || lower === 'zsh' || lower === 'bash';
}

export function resolveTerminalShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ResolvedTerminalShell {
  const override = normalizeNonEmptyString(env.HAPPIER_DAEMON_TERMINAL_SHELL);
  if (override) {
    return { file: override, args: [] };
  }

  if (platform === 'win32') {
    const comspec = normalizeNonEmptyString(env.ComSpec);
    if (comspec) return { file: comspec, args: [] };
    return { file: 'cmd.exe', args: [] };
  }

  const shell = normalizeNonEmptyString(env.SHELL) ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const args = shouldUseLoginArgs(shell) ? ['-l'] : [];
  return { file: shell, args };
}

