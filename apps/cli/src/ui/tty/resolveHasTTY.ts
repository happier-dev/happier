export function resolveHasTTY(params: {
  stdoutIsTTY: unknown;
  stdinIsTTY: unknown;
  startedBy?: 'daemon' | 'terminal';
}): boolean {
  return Boolean(params.stdoutIsTTY) && Boolean(params.stdinIsTTY) && params.startedBy !== 'daemon';
}

