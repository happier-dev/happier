import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';

import {
  ProviderAccountUsageRecordIdSchema,
  PROVIDER_ACCOUNT_SUBSCRIPTION_ACCEPT,
  SealedProviderAccountUsageSnapshotV1Schema,
  type ProviderAccountUsageRecordId,
  type SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

function extractErrorCode(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  return typeof obj.error === 'string' ? obj.error : null;
}

const ProviderAccountUsageV2ResponseSchema = z.object({
  sealed: SealedProviderAccountUsageSnapshotV1Schema,
  metadata: z.object({
    fetchedAt: z.number().int().nonnegative(),
    staleAfterMs: z.number().int().nonnegative(),
    status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
    refreshRequestedAt: z.number().int().nonnegative().optional(),
  }),
});

export async function getProviderAccountUsageSnapshotSealed(
  credentials: AuthCredentials,
  params: Readonly<{ recordId: ProviderAccountUsageRecordId | string }>,
  opts?: Readonly<{ signal?: AbortSignal }>,
): Promise<Readonly<{
  sealed: SealedProviderAccountUsageSnapshotV1;
  metadata: {
    fetchedAt: number;
    staleAfterMs: number;
    status: 'ok' | 'unavailable' | 'estimated' | 'error';
    refreshRequestedAt?: number;
  };
} | null>> {
  const recordId = ProviderAccountUsageRecordIdSchema.parse(params.recordId);
  return await backoff(async () => {
    const response = await serverFetch(
      `/v2/connect/provider-account-usage/${encodeURIComponent(recordId)}`,
      {
        method: 'GET',
        signal: opts?.signal,
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
          Accept: PROVIDER_ACCOUNT_SUBSCRIPTION_ACCEPT,
        },
      },
      { includeAuth: false },
    );

    if (response.status === 404) return null;

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        let message = 'Failed to load provider account usage';
        try {
          const json = await response.json();
          message = extractErrorCode(json) ?? message;
        } catch {
          // ignore
        }
        throw new HappyError(message, false, { status: response.status, kind: 'server' });
      }
      throw new Error(`Failed to load provider account usage: ${response.status}`);
    }

    const json: unknown = await response.json();
    const parsed = ProviderAccountUsageV2ResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('Invalid provider account usage response');
    }
    return parsed.data;
  });
}

export async function requestProviderAccountUsageRefreshSealed(
  credentials: AuthCredentials,
  params: Readonly<{ recordId: ProviderAccountUsageRecordId | string }>,
): Promise<boolean> {
  const recordId = ProviderAccountUsageRecordIdSchema.parse(params.recordId);
  return await backoff(async () => {
    const response = await serverFetch(
      `/v2/connect/provider-account-usage/${encodeURIComponent(recordId)}/refresh`,
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
        let message = 'Failed to request provider account usage refresh';
        try {
          const json = await response.json();
          message = extractErrorCode(json) ?? message;
        } catch {
          // ignore
        }
        throw new HappyError(message, false, { status: response.status, kind: 'server' });
      }
      throw new Error(`Failed to request provider account usage refresh: ${response.status}`);
    }
    return true;
  });
}
