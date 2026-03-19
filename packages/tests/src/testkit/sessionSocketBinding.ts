import { randomUUID } from 'node:crypto';

import { fetchJson } from './http';
import { createSessionScopedSocketCollector, type SocketCollector } from './socketClient';

async function ensureSessionScopedAccessKey(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  machineId: string;
}>): Promise<void> {
  const requestInit = {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    timeoutMs: 15_000,
  };

  const machineRes = await fetchJson<{ machine?: { id?: string } }>(`${params.baseUrl}/v1/machines`, {
    method: 'POST',
    headers: requestInit.headers,
    body: JSON.stringify({
      id: params.machineId,
      metadata: 'e2e-machine-metadata',
    }),
    timeoutMs: requestInit.timeoutMs,
  });
  if (machineRes.status !== 200) {
    throw new Error(`Failed to create machine (${machineRes.status})`);
  }

  const accessKeyRes = await fetchJson<{ success?: boolean; error?: string }>(
    `${params.baseUrl}/v1/access-keys/${encodeURIComponent(params.sessionId)}/${encodeURIComponent(params.machineId)}`,
    {
      method: 'POST',
      headers: requestInit.headers,
      body: JSON.stringify({
        data: `session-socket-binding:${randomUUID()}`,
      }),
      timeoutMs: requestInit.timeoutMs,
    },
  );
  if (accessKeyRes.status !== 200 && accessKeyRes.status !== 409) {
    throw new Error(`Failed to create session access key (${accessKeyRes.status})`);
  }
}

export async function createMachineBoundSessionScopedSocketCollector(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  machineId?: string;
}>): Promise<{ machineId: string; socket: SocketCollector }> {
  const machineId = params.machineId ?? randomUUID();
  await ensureSessionScopedAccessKey({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    machineId,
  });

  return {
    machineId,
    socket: createSessionScopedSocketCollector(params.baseUrl, params.token, params.sessionId, machineId),
  };
}
