import { randomUUID } from 'node:crypto';

import { fetchJson } from './http';
import { sleep } from './timing';
import { createSessionScopedSocketCollector, type SocketCollector } from './socketClient';

const machineCreateRetryStatuses = new Set([500, 502, 503, 504]);
const machineCreateMaxAttempts = 3;
const machineCreateRetryDelayMs = 250;

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

  let machineRes: Awaited<ReturnType<typeof fetchJson<{ machine?: { id?: string } }>>>;
  for (let attempt = 1; attempt <= machineCreateMaxAttempts; attempt += 1) {
    machineRes = await fetchJson<{ machine?: { id?: string } }>(`${params.baseUrl}/v1/machines`, {
      method: 'POST',
      headers: requestInit.headers,
      body: JSON.stringify({
        id: params.machineId,
        metadata: 'e2e-machine-metadata',
      }),
      timeoutMs: requestInit.timeoutMs,
    });
    if (machineRes.status === 200) {
      break;
    }
    if (!machineCreateRetryStatuses.has(machineRes.status) || attempt === machineCreateMaxAttempts) {
      throw new Error(`Failed to create machine (${machineRes.status})`);
    }
    await sleep(machineCreateRetryDelayMs);
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
  transports?: readonly ('websocket' | 'polling')[];
  connectTimeoutMs?: number;
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
    socket: createSessionScopedSocketCollector(params.baseUrl, params.token, params.sessionId, machineId, {
      transports: params.transports,
      connectTimeoutMs: params.connectTimeoutMs,
    }),
  };
}
