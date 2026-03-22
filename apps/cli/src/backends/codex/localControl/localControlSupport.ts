export type CodexLocalControlBackend = 'acp' | 'appServer';

export type CodexLocalControlSupportDecision =
  | Readonly<{ ok: true; backend: CodexLocalControlBackend }>
  | Readonly<{
      ok: false;
      reason: CodexLocalControlUnsupportedReason;
    }>;

export type CodexLocalControlUnsupportedReason =
  | 'started-by-daemon'
  | 'resume-disabled';

export function formatCodexLocalControlLaunchFallbackMessage(
  reason: CodexLocalControlUnsupportedReason
): string {
  switch (reason) {
    case 'started-by-daemon':
      return 'Codex local mode is not available when started by the daemon. Starting in remote mode instead.';
    case 'resume-disabled':
      return 'Codex local mode requires a resumable Codex remote backend. Starting in remote mode instead.';
    default:
      return 'Codex local mode is not available. Starting in remote mode instead.';
  }
}

export function formatCodexLocalControlSwitchDeniedMessage(
  reason: CodexLocalControlUnsupportedReason
): string {
  switch (reason) {
    case 'resume-disabled':
      return 'Cannot switch to Codex local mode: no resumable Codex remote backend is enabled on this machine.';
    case 'started-by-daemon':
      return 'Cannot switch to Codex local mode: daemon-started sessions are not supported.';
    default:
      return 'Cannot switch to Codex local mode: resume support is unavailable on this machine.';
  }
}

export function decideCodexLocalControlSupport(opts: Readonly<{
  startedBy: 'daemon' | 'cli';
  experimentalCodexAcpEnabled: boolean;
  localControlBackend?: CodexLocalControlBackend | null;
  hasTtyForLocal?: boolean;
}>): CodexLocalControlSupportDecision {
  const hasTtyForLocal = opts.hasTtyForLocal === true;
  const localControlBackend = opts.localControlBackend ?? (opts.experimentalCodexAcpEnabled ? 'acp' : null);

  if (opts.startedBy === 'daemon' && !hasTtyForLocal) return { ok: false, reason: 'started-by-daemon' };

  if (!localControlBackend) return { ok: false, reason: 'resume-disabled' };
  return { ok: true, backend: localControlBackend };
}
