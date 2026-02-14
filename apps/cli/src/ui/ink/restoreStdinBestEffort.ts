export function restoreStdinBestEffort(opts: Readonly<{
  stdin: {
    isTTY?: boolean;
    setRawMode?: (value: boolean) => void;
    pause?: () => void;
    setEncoding?: (encoding: any) => void;
    removeAllListeners?: (event?: string) => void;
    _readableState?: { decoder?: unknown; encoding?: unknown };
  };
}>): void {
  const stdin = opts.stdin;

  try {
    if (stdin?.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
  } catch {
    // best-effort
  }

  try {
    // Remove orphaned listeners from prior UIs.
    stdin?.removeAllListeners?.('data');
  } catch {
    // best-effort
  }

  try {
    stdin?.pause?.();
  } catch {
    // best-effort
  }

  try {
    // Reset encoding back to Buffer mode (Node accepts null).
    stdin?.setEncoding?.(null);
  } catch {
    // best-effort
  }

  try {
    // Best-effort: clear sticky decoder/encoding state that can persist across UIs.
    if (stdin && typeof stdin === 'object' && (stdin as any)._readableState) {
      (stdin as any)._readableState.decoder = null;
      (stdin as any)._readableState.encoding = null;
    }
  } catch {
    // best-effort
  }
}

