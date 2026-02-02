import { fetchJson } from './http';

export type ChangesCursor = { cursor: number; changesFloor: number };

export async function fetchCursor(baseUrl: string, token: string): Promise<ChangesCursor> {
  const res = await fetchJson<Partial<ChangesCursor>>(`${baseUrl}/v2/cursor`, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 15_000,
  });
  const cursor = res.data?.cursor;
  const changesFloor = res.data?.changesFloor;
  if (res.status !== 200 || typeof cursor !== 'number' || typeof changesFloor !== 'number') {
    throw new Error(`Failed to fetch cursor (status=${res.status})`);
  }
  return { cursor, changesFloor };
}

export type AccountChangeRow = {
  cursor: number;
  kind: string;
  entityId: string;
  changedAt: number;
  hint: unknown | null;
};

export async function fetchChanges(baseUrl: string, token: string, params?: { after?: number; limit?: number }): Promise<{ changes: AccountChangeRow[]; nextCursor: number }> {
  const after = params?.after ?? 0;
  const limit = params?.limit ?? 200;
  const url = new URL(`${baseUrl}/v2/changes`);
  url.searchParams.set('after', String(after));
  url.searchParams.set('limit', String(limit));

  const res = await fetchJson<any>(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 20_000,
  });
  if (res.status !== 200 || !res.data || !Array.isArray(res.data.changes) || typeof res.data.nextCursor !== 'number') {
    throw new Error(`Failed to fetch changes (status=${res.status})`);
  }
  return { changes: res.data.changes as AccountChangeRow[], nextCursor: res.data.nextCursor };
}

