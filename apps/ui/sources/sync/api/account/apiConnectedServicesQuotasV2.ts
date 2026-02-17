import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';

import { SealedConnectedServiceQuotaSnapshotV1Schema, type ConnectedServiceId, type SealedConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { z } from 'zod';

function extractErrorCode(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  return typeof obj.error === 'string' ? obj.error : null;
}

const ConnectedServiceQuotasV2ResponseSchema = z.object({
  sealed: SealedConnectedServiceQuotaSnapshotV1Schema,
  metadata: z.object({
    fetchedAt: z.number().int().nonnegative(),
    staleAfterMs: z.number().int().nonnegative(),
    status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
    refreshRequestedAt: z.number().int().nonnegative().optional(),
  }),
});

export async function getConnectedServiceQuotaSnapshotSealed(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
): Promise<Readonly<{
  sealed: SealedConnectedServiceQuotaSnapshotV1;
  metadata: {
    fetchedAt: number;
    staleAfterMs: number;
    status: 'ok' | 'unavailable' | 'estimated' | 'error';
    refreshRequestedAt?: number;
  };
} | null>> {
  return await backoff(async () => {
    const response = await serverFetch(
      `/v2/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/quotas`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
      },
      { includeAuth: false },
    );

    if (response.status === 404) return null;

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        let message = `Failed to load quotas for ${params.serviceId}`;
        try {
          const json = await response.json();
          message = extractErrorCode(json) ?? message;
        } catch {
          // ignore
        }
        throw new HappyError(message, false, { status: response.status, kind: 'server' });
      }
      throw new Error(`Failed to load quotas for ${params.serviceId}: ${response.status}`);
    }

    const json: unknown = await response.json();
    const parsed = ConnectedServiceQuotasV2ResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Invalid quota snapshot response for ${params.serviceId}`);
    }
    return parsed.data;
  });
}

export async function requestConnectedServiceQuotaSnapshotRefresh(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
): Promise<boolean> {
  return await backoff(async () => {
    const response = await serverFetch(
      `/v2/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/quotas/refresh`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      { includeAuth: false },
    );

    if (response.status === 404) return false;
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        let message = `Failed to request quota refresh for ${params.serviceId}`;
        try {
          const json = await response.json();
          message = extractErrorCode(json) ?? message;
        } catch {
          // ignore
        }
        throw new HappyError(message, false, { status: response.status, kind: 'server' });
      }
      throw new Error(`Failed to request quota refresh for ${params.serviceId}: ${response.status}`);
    }

    return true;
  });
}
