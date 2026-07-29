export function resolveBugReportServerDiagnosticsLines(contextWindowMs?: number): number {
  if (typeof contextWindowMs !== 'number' || !Number.isFinite(contextWindowMs)) return 200;
  const windowSeconds = Math.max(1, Math.floor(contextWindowMs / 1000));
  return Math.max(50, Math.min(500, Math.floor(windowSeconds / 3)));
}

