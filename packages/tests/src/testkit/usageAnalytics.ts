import type { UsageEventIngestRequest } from '@happier-dev/protocol';

import { fetchJson } from './http';

export async function writeUsageEvent(params: Readonly<{
  baseUrl: string;
  token: string;
  request: UsageEventIngestRequest;
}>): Promise<void> {
  const res = await fetchJson<{ success?: boolean }>(`${params.baseUrl}/v2/usage-events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params.request),
    timeoutMs: 15_000,
  });

  if (res.status !== 200 || res.data?.success !== true) {
    throw new Error(`Failed to seed usage event (status=${res.status})`);
  }
}
