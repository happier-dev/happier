export type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export async function fetchJson<T = any>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<{ status: number; headers: Headers; data: T }> {
  const timeoutMs = init?.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T) : (null as any);
    return { status: res.status, headers: res.headers, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForOkHealth(baseUrl: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const intervalMs = opts?.intervalMs ?? 250;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetchJson<{ status?: string }>(`${baseUrl}/health`, { timeoutMs: 2_000 });
      if (res.status === 200 && res.data?.status === 'ok') return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for /health at ${baseUrl}`);
}

