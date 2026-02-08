export type CodexLocalControlSupportDecision =
  | Readonly<{ ok: true; backend: 'mcp' | 'acp' }>
  | Readonly<{
      ok: false;
      reason: CodexLocalControlUnsupportedReason;
    }>;

export type CodexLocalControlUnsupportedReason =
  | 'started-by-daemon'
  | 'resume-disabled'
  | 'acp-load-session-unsupported';

export function formatCodexLocalControlLaunchFallbackMessage(
  reason: CodexLocalControlUnsupportedReason
): string {
  switch (reason) {
    case 'started-by-daemon':
      return 'Codex local mode is not available when started by the daemon. Starting in remote mode instead.';
    case 'resume-disabled':
      return 'Codex local mode requires resume support (Codex resume MCP or Codex ACP). Starting in remote mode instead.';
    case 'acp-load-session-unsupported':
      return 'Codex local mode requires Codex ACP with loadSession support. Starting in remote mode instead.';
    default:
      return 'Codex local mode is not available. Starting in remote mode instead.';
  }
}

export function formatCodexLocalControlSwitchDeniedMessage(
  reason: CodexLocalControlUnsupportedReason
): string {
  switch (reason) {
    case 'resume-disabled':
      return 'Cannot switch to Codex local mode: resume support is disabled on this machine.';
    case 'acp-load-session-unsupported':
      return 'Cannot switch to Codex local mode: Codex ACP loadSession is not supported on this machine.';
    case 'started-by-daemon':
      return 'Cannot switch to Codex local mode: daemon-started sessions are not supported.';
    default:
      return 'Cannot switch to Codex local mode: resume support is unavailable on this machine.';
  }
}

export function shouldUseCodexMcpResumeServer(opts: Readonly<{
  experimentalCodexResumeEnabled: boolean;
  vendorResumeId: string | null;
  localControlSupported: boolean;
}>): boolean {
  if (!opts.experimentalCodexResumeEnabled) return false;
  const hasVendorResumeId = typeof opts.vendorResumeId === 'string' && opts.vendorResumeId.trim().length > 0;
  return hasVendorResumeId || opts.localControlSupported;
}

export function decideCodexLocalControlSupport(opts: Readonly<{
  startedBy: 'daemon' | 'cli';
  experimentalCodexAcpEnabled: boolean;
  experimentalCodexResumeEnabled: boolean;
  acpLoadSessionSupported: boolean;
}>): CodexLocalControlSupportDecision {
  if (opts.startedBy === 'daemon') return { ok: false, reason: 'started-by-daemon' };

  if (opts.experimentalCodexAcpEnabled) {
    if (!opts.acpLoadSessionSupported) return { ok: false, reason: 'acp-load-session-unsupported' };
    return { ok: true, backend: 'acp' };
  }

  if (!opts.experimentalCodexResumeEnabled) return { ok: false, reason: 'resume-disabled' };
  return { ok: true, backend: 'mcp' };
}
