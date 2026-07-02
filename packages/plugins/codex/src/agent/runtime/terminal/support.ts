export type CodexTerminalRuntimeBackend = 'acp' | 'appServer';

export type CodexTerminalRuntimeSupportDecision =
  | Readonly<{ ok: true; backend: CodexTerminalRuntimeBackend }>
  | Readonly<{
      ok: false;
      reason: CodexTerminalRuntimeUnsupportedReason;
    }>;

export type CodexTerminalRuntimeUnsupportedReason =
  | 'started-by-daemon'
  | 'resume-disabled';

export type CreateCodexTerminalRuntimeSupportResolverParams = Readonly<{
  startedBy: 'daemon' | 'cli';
  terminalRuntimeBackend?: CodexTerminalRuntimeBackend | null | (() => CodexTerminalRuntimeBackend | null);
  hasTtyForTerminal?: boolean;
}>;

export function formatCodexTerminalRuntimeLaunchFallbackMessage(
  reason: CodexTerminalRuntimeUnsupportedReason,
): string {
  switch (reason) {
    case 'started-by-daemon':
      return 'Codex terminal mode is not available when started by the daemon. Starting in remote mode instead.';
    case 'resume-disabled':
      return 'Codex terminal mode requires a resumable Codex remote backend. Starting in remote mode instead.';
    default:
      return 'Codex terminal mode is not available. Starting in remote mode instead.';
  }
}

export function formatCodexTerminalRuntimeSwitchDeniedMessage(
  reason: CodexTerminalRuntimeUnsupportedReason,
): string {
  switch (reason) {
    case 'resume-disabled':
      return 'Cannot switch to Codex terminal mode: no resumable Codex remote backend is enabled on this machine.';
    case 'started-by-daemon':
      return 'Cannot switch to Codex terminal mode: daemon-started sessions are not supported.';
    default:
      return 'Cannot switch to Codex terminal mode: resume support is unavailable on this machine.';
  }
}

export function decideCodexTerminalRuntimeSupport(opts: Readonly<{
  startedBy: 'daemon' | 'cli';
  terminalRuntimeBackend?: CodexTerminalRuntimeBackend | null;
  hasTtyForTerminal?: boolean;
}>): CodexTerminalRuntimeSupportDecision {
  const hasTtyForTerminal = opts.hasTtyForTerminal === true;
  const terminalRuntimeBackend = opts.terminalRuntimeBackend ?? null;

  if (opts.startedBy === 'daemon' && !hasTtyForTerminal) return { ok: false, reason: 'started-by-daemon' };

  if (!terminalRuntimeBackend) return { ok: false, reason: 'resume-disabled' };
  return { ok: true, backend: terminalRuntimeBackend };
}

export function createCodexTerminalRuntimeSupportResolver(
  params: CreateCodexTerminalRuntimeSupportResolverParams,
): (opts: { includeAcpProbe: boolean }) => Promise<CodexTerminalRuntimeSupportDecision> {
  const resolveBackend = (
    value: CodexTerminalRuntimeBackend | null | undefined | (() => CodexTerminalRuntimeBackend | null),
  ): CodexTerminalRuntimeBackend | null => {
    if (typeof value === 'function') return value() ?? null;
    return value ?? null;
  };

  return async (_opts: { includeAcpProbe: boolean }): Promise<CodexTerminalRuntimeSupportDecision> => {
    const decision = decideCodexTerminalRuntimeSupport({
      startedBy: params.startedBy,
      terminalRuntimeBackend: resolveBackend(params.terminalRuntimeBackend),
      hasTtyForTerminal: params.hasTtyForTerminal,
    });
    return decision;
  };
}
