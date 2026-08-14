import {
  settleSpawnSessionNonce,
  type SpawnSessionNonceResolution,
} from '@happier-dev/protocol';

import { fetchJson } from '../http';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

export async function daemonControlPostJson<T = any>(params: {
  port: number;
  path: string;
  body?: any;
  timeoutMs?: number;
  controlToken?: string | null;
}): Promise<{ status: number; data: T }> {
  const defaultTimeoutMs = params.path === '/spawn-session' ? 90_000 : 30_000;
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
      timeoutMs: params.timeoutMs ?? defaultTimeoutMs,
    });
    if (params.path !== '/spawn-session') {
      return { status: res.status, data: res.data };
    }

    const spawnResponse = asRecord(res.data);
    const immediateSessionId = typeof spawnResponse?.sessionId === 'string'
      ? spawnResponse.sessionId.trim()
      : '';
    const spawnNonce = typeof spawnResponse?.spawnNonce === 'string'
      ? spawnResponse.spawnNonce.trim()
      : '';
    const isPending = spawnResponse?.success === true
      && (spawnResponse.status === 'pending' || spawnResponse.sessionIdStatus === 'pending');
    if (!isPending || immediateSessionId || !spawnNonce) {
      return { status: res.status, data: res.data };
    }

    const sessionId = await resolveDaemonSpawnSessionId({
      port: params.port,
      controlToken: params.controlToken,
      spawnNonce,
      timeoutMs: params.timeoutMs ?? defaultTimeoutMs,
    });
    return {
      status: res.status,
      data: {
        ...spawnResponse,
        status: 'success',
        sessionIdStatus: 'available',
        sessionId,
      } as T,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`daemonControlPostJson failed (port=${params.port} path=${params.path}): ${reason}`);
  }
}

export async function resolveDaemonSpawnSessionId(params: Readonly<{
  port: number;
  controlToken?: string | null;
  immediateSessionId?: string;
  spawnNonce?: string;
  timeoutMs?: number;
}>): Promise<string> {
  const immediateSessionId = params.immediateSessionId?.trim() ?? '';
  if (immediateSessionId) return immediateSessionId;

  const spawnNonce = params.spawnNonce?.trim() ?? '';
  if (!spawnNonce) throw new Error('Missing sessionId and spawnNonce from daemon spawn-session');

  const timeoutMs = params.timeoutMs ?? 45_000;
  const settled = await settleSpawnSessionNonce({
    spawnNonce,
    timeoutMs,
    pollIntervalMs: 50,
    resolve: async (nonce, remainingTimeoutMs): Promise<SpawnSessionNonceResolution> => {
      const resolved = await daemonControlPostJson<{
        success: true;
        status: 'success' | 'pending' | 'not_found' | 'unsupported';
        sessionId?: string;
      }>({
        port: params.port,
        path: '/spawn-session/resolve',
        controlToken: params.controlToken,
        body: { spawnNonce: nonce },
        timeoutMs: Math.min(5_000, remainingTimeoutMs),
      });
      if (resolved.status !== 200 || resolved.data.success !== true) {
        throw new Error(`spawn-session/resolve failed (status=${resolved.status})`);
      }
      if (resolved.data.status !== 'success') {
        return { status: resolved.data.status };
      }
      return {
        status: 'success',
        sessionId: resolved.data.sessionId ?? '',
      };
    },
  });
  if (settled.status === 'success') {
    return settled.sessionId;
  }
  if (settled.status === 'not_found') {
    throw new Error(`spawn-session/resolve lost spawn nonce ${spawnNonce}`);
  }
  if (settled.status === 'unsupported') {
    throw new Error('spawn-session/resolve is unsupported by this daemon');
  }
  throw new Error(`Timed out resolving daemon spawn nonce ${spawnNonce}`);
}
