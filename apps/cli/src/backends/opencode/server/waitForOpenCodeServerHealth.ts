export async function waitForOpenCodeServerHealth(params: {
  baseUrl: string;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    if (params.signal?.aborted) throw new Error('Aborted while waiting for OpenCode server health');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(1_500, params.pollIntervalMs * 5));
      timer.unref?.();
      const res = await fetch(`${params.baseUrl}/global/health`, {
        signal: ctrl.signal,
        ...(params.headers && Object.keys(params.headers).length > 0 ? { headers: params.headers } : {}),
      }).catch(() => null);
      clearTimeout(timer);
      if (res && res.ok) return;
    } catch {
      // ignore and retry until deadline
    }
    await new Promise((r) => setTimeout(r, params.pollIntervalMs));
  }
  throw new Error(`Timed out waiting for OpenCode server health after ${params.timeoutMs}ms`);
}
