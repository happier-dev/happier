export type CodexLocalControlSupportDecision =
  | Readonly<{ ok: true; backend: 'acp' }>
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
      return 'Codex local mode requires Codex ACP mode. Starting in remote mode instead.';
    default:
      return 'Codex local mode is not available. Starting in remote mode instead.';
  }
}

export function formatCodexLocalControlSwitchDeniedMessage(
  reason: CodexLocalControlUnsupportedReason
): string {
  switch (reason) {
    case 'resume-disabled':
      return 'Cannot switch to Codex local mode: Codex ACP mode is disabled on this machine.';
    case 'started-by-daemon':
      return 'Cannot switch to Codex local mode: daemon-started sessions are not supported.';
    default:
      return 'Cannot switch to Codex local mode: resume support is unavailable on this machine.';
  }
}

export function decideCodexLocalControlSupport(opts: Readonly<{
  startedBy: 'daemon' | 'cli';
  experimentalCodexAcpEnabled: boolean;
  hasTtyForLocal?: boolean;
}>): CodexLocalControlSupportDecision {
  const hasTtyForLocal = opts.hasTtyForLocal === true;

  if (opts.startedBy === 'daemon' && !hasTtyForLocal) return { ok: false, reason: 'started-by-daemon' };

  if (!opts.experimentalCodexAcpEnabled) return { ok: false, reason: 'resume-disabled' };
  return { ok: true, backend: 'acp' };
}
