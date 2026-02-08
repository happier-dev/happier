import { fetchJson } from '../http';

export async function daemonControlPostJson<T = any>(params: {
  port: number;
  path: string;
  body?: any;
  timeoutMs?: number;
  controlToken?: string | null;
}): Promise<{ status: number; data: T }> {
  try {
    const res = await fetchJson<T>(`http://127.0.0.1:${params.port}${params.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(typeof params.controlToken === 'string' && params.controlToken.length > 0
          ? { 'x-happier-daemon-token': params.controlToken }
          : {}),
      },
      body: JSON.stringify(params.body ?? {}),
      timeoutMs: params.timeoutMs ?? 30_000,
    });
    return { status: res.status, data: res.data };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`daemonControlPostJson failed (port=${params.port} path=${params.path}): ${reason}`);
  }
}
