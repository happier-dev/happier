export type CodexAcpResumePreflightProbe =
  | Readonly<{ ok: true; loadSessionSupported: boolean }>
  | Readonly<{ ok: false; errorMessage: string }>;

export type CodexAcpResumePreflightResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorMessage: string }>;

function normalizeResumeId(resumeId: string | null): string {
  const trimmed = typeof resumeId === 'string' ? resumeId.trim() : '';
  return trimmed;
}

export function resolveCodexAcpResumePreflight(opts: Readonly<{
  resumeId: string | null;
  probe: CodexAcpResumePreflightProbe;
}>): CodexAcpResumePreflightResult {
  const resumeId = normalizeResumeId(opts.resumeId);
  if (!resumeId) return { ok: true };

  if (!opts.probe.ok) {
    const errRaw = typeof opts.probe.errorMessage === 'string' ? opts.probe.errorMessage.trim() : '';
    const err = errRaw || 'Unknown error';
    return {
      ok: false,
      errorMessage:
        `Cannot resume this Codex session in Codex ACP.\n` +
        `Reason: failed to probe Codex ACP capabilities (${err}).\n` +
        `Fix: disable the Codex ACP experiment or install/enable a Codex ACP build that supports resume.\n` +
        `Note: Happy refuses to silently start a new Codex ACP session when --resume was requested.`,
    };
  }

  if (!opts.probe.loadSessionSupported) {
    return {
      ok: false,
      errorMessage:
        `Cannot resume this Codex session in Codex ACP: this Codex ACP build does not support loadSession.\n` +
        `Fix: disable the Codex ACP experiment (use Codex MCP + resume server) or install a Codex ACP build with loadSession support.\n` +
        `Note: Happy refuses to silently start a new Codex ACP session when --resume was requested.`,
    };
  }

  return { ok: true };
}
