import { randomUUID } from 'node:crypto';

import { fetchJson } from './http';
import { sleep } from './timing';
import { createSessionScopedSocketCollector, type SocketCollector } from './socketClient';

const machineCreateRetryStatuses = new Set([500, 502, 503, 504]);
const machineCreateMaxAttempts = 3;
const machineCreateRetryDelayMs = 250;

export type SessionSocketBindingProvisioningStage = 'machine_create' | 'access_key_create';

export type SessionSocketBindingProvisioningObservation = Readonly<{
  stage: SessionSocketBindingProvisioningStage;
  result: 'ok' | 'error';
  durationMs: number;
  status: number;
}>;

async function ensureSessionScopedAccessKey(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  machineId: string;
  requestTimeoutMs: number;
  onProvisioningStage?: (observation: SessionSocketBindingProvisioningObservation) => void;
}>): Promise<void> {
  const requestInit = {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    timeoutMs: params.requestTimeoutMs,
  };

  let machineRes: Awaited<ReturnType<typeof fetchJson<{ machine?: { id?: string } }>>>;
  for (let attempt = 1; attempt <= machineCreateMaxAttempts; attempt += 1) {
    const machineCreateStartedAt = Date.now();
    machineRes = await fetchJson<{ machine?: { id?: string } }>(`${params.baseUrl}/v1/machines`, {
      method: 'POST',
      headers: requestInit.headers,
      body: JSON.stringify({
        id: params.machineId,
        metadata: 'e2e-machine-metadata',
      }),
      timeoutMs: requestInit.timeoutMs,
    });
    const machineCreateDurationMs = Date.now() - machineCreateStartedAt;
    if (machineRes.status === 200) {
      params.onProvisioningStage?.({
        stage: 'machine_create',
        result: 'ok',
        durationMs: machineCreateDurationMs,
        status: machineRes.status,
      });
      break;
    }
    params.onProvisioningStage?.({
      stage: 'machine_create',
      result: 'error',
      durationMs: machineCreateDurationMs,
      status: machineRes.status,
    });
    if (!machineCreateRetryStatuses.has(machineRes.status) || attempt === machineCreateMaxAttempts) {
      throw new Error(`Failed to create machine (${machineRes.status})`);
    }
    await sleep(machineCreateRetryDelayMs);
  }

  const accessKeyStartedAt = Date.now();
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
  params.onProvisioningStage?.({
    stage: 'access_key_create',
    result: accessKeyRes.status === 200 || accessKeyRes.status === 409 ? 'ok' : 'error',
    durationMs: Date.now() - accessKeyStartedAt,
    status: accessKeyRes.status,
  });
  if (accessKeyRes.status !== 200 && accessKeyRes.status !== 409) {
    throw new Error(`Failed to create session access key (${accessKeyRes.status})`);
  }
}

export async function provisionMachineBoundSessionScopedSocketBinding(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  machineId?: string;
  requestTimeoutMs?: number;
  onProvisioningStage?: (observation: SessionSocketBindingProvisioningObservation) => void;
}>): Promise<{ machineId: string }> {
  const machineId = params.machineId ?? randomUUID();
  await ensureSessionScopedAccessKey({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    machineId,
    requestTimeoutMs: params.requestTimeoutMs ?? 15_000,
    onProvisioningStage: params.onProvisioningStage,
  });
  return { machineId };
}

export async function createMachineBoundSessionScopedSocketCollector(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  machineId?: string;
  transports?: readonly ('websocket' | 'polling')[];
  connectTimeoutMs?: number;
  autoReconnect?: boolean;
  captureEvents?: boolean;
  requestTimeoutMs?: number;
  onProvisioningStage?: (observation: SessionSocketBindingProvisioningObservation) => void;
}>): Promise<{ machineId: string; socket: SocketCollector }> {
  const { machineId } = await provisionMachineBoundSessionScopedSocketBinding({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    machineId: params.machineId,
    requestTimeoutMs: params.requestTimeoutMs,
    onProvisioningStage: params.onProvisioningStage,
  });

  return {
    machineId,
    socket: createSessionScopedSocketCollector(params.baseUrl, params.token, params.sessionId, machineId, {
      transports: params.transports,
      connectTimeoutMs: params.connectTimeoutMs,
      autoReconnect: params.autoReconnect,
      captureEvents: params.captureEvents,
    }),
  };
}
