import { fetchJson } from './http';

export type PendingQueueV2Row = {
  localId: string;
  content: { t: 'encrypted'; c: string };
  status: 'queued' | 'discarded';
  position: number;
  createdAt: number;
  updatedAt: number;
  discardedAt?: number | null;
  discardedReason?: string | null;
  authorAccountId?: string | null;
};

export async function enqueuePendingQueueV2(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  localId: string;
  ciphertext: string;
  timeoutMs?: number;
}): Promise<{ status: number; data: any }> {
  const sessionId = encodeURIComponent(params.sessionId);
  return await fetchJson<any>(`${params.baseUrl}/v2/sessions/${sessionId}/pending`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ localId: params.localId, ciphertext: params.ciphertext }),
    timeoutMs: params.timeoutMs ?? 20_000,
  });
}

export async function listPendingQueueV2(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  includeDiscarded?: boolean;
  timeoutMs?: number;
}): Promise<{ status: number; data: { pending?: PendingQueueV2Row[] } }> {
  const includeDiscarded = params.includeDiscarded === true;
  const sessionId = encodeURIComponent(params.sessionId);
  const url = new URL(`${params.baseUrl}/v2/sessions/${sessionId}/pending`);
  if (includeDiscarded) url.searchParams.set('includeDiscarded', 'true');
  return await fetchJson<any>(url.toString(), {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: params.timeoutMs ?? 20_000,
  });
}

export async function patchPendingQueueV2(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  localId: string;
  ciphertext: string;
  timeoutMs?: number;
}): Promise<{ status: number; data: any }> {
  const sessionId = encodeURIComponent(params.sessionId);
  const localId = encodeURIComponent(params.localId);
  return await fetchJson<any>(`${params.baseUrl}/v2/sessions/${sessionId}/pending/${localId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ciphertext: params.ciphertext }),
    timeoutMs: params.timeoutMs ?? 20_000,
  });
}

export async function deletePendingQueueV2(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  localId: string;
  timeoutMs?: number;
}): Promise<{ status: number; data: any }> {
  const sessionId = encodeURIComponent(params.sessionId);
  const localId = encodeURIComponent(params.localId);
  return await fetchJson<any>(`${params.baseUrl}/v2/sessions/${sessionId}/pending/${localId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: params.timeoutMs ?? 20_000,
  });
}

export async function discardPendingQueueV2(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  localId: string;
  reason?: string;
  timeoutMs?: number;
}): Promise<{ status: number; data: any }> {
  const sessionId = encodeURIComponent(params.sessionId);
  const localId = encodeURIComponent(params.localId);
  return await fetchJson<any>(`${params.baseUrl}/v2/sessions/${sessionId}/pending/${localId}/discard`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: params.reason ?? 'test' }),
    timeoutMs: params.timeoutMs ?? 20_000,
  });
}

export async function restorePendingQueueV2(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  localId: string;
  timeoutMs?: number;
}): Promise<{ status: number; data: any }> {
  const sessionId = encodeURIComponent(params.sessionId);
  const localId = encodeURIComponent(params.localId);
  return await fetchJson<any>(`${params.baseUrl}/v2/sessions/${sessionId}/pending/${localId}/restore`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: params.timeoutMs ?? 20_000,
  });
}

export async function reorderPendingQueueV2(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  orderedLocalIds: string[];
  timeoutMs?: number;
}): Promise<{ status: number; data: any }> {
  const sessionId = encodeURIComponent(params.sessionId);
  return await fetchJson<any>(`${params.baseUrl}/v2/sessions/${sessionId}/pending/reorder`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedLocalIds: params.orderedLocalIds }),
    timeoutMs: params.timeoutMs ?? 20_000,
  });
}
