export function createTerminalHostDeadline(timeoutMs: number | undefined): number | undefined {
  return timeoutMs !== undefined && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
}

export function remainingTerminalHostDeadlineMs(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  return Math.max(0, deadline - Date.now());
}
