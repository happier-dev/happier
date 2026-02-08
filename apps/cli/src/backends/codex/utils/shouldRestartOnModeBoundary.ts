export type CodexBackendKindForRestart = 'mcp' | 'acp';

export function shouldRestartCodexSessionForModeBoundary(opts: {
  backendKind: CodexBackendKindForRestart;
  wasCreated: boolean;
  currentModeHash: string | null;
  nextModeHash: string;
}): boolean {
  if (!opts.wasCreated) return false;
  if (!opts.currentModeHash) return false;
  if (opts.nextModeHash === opts.currentModeHash) return false;

  // Permission mode boundaries must not force a session restart:
  // - MCP: Codex resume is memory-bound in many builds; restarting drops context.
  // - ACP: apply via runtime mode APIs if supported, otherwise via approvals gating.
  //
  // Other boundary types (model/tooling) should be handled explicitly elsewhere.
  void opts.backendKind;
  return false;
}
