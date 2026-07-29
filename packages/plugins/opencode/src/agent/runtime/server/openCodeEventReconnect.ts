export function readOpenCodeEventReconnectBackoffMs(attempt: number): number {
  return Math.min(1_000, 50 * 2 ** Math.max(0, Math.trunc(attempt)));
}
