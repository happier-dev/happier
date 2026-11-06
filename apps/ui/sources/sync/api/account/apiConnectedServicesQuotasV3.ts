import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
  createServerFetchForActiveServer,
  type ExpectedActiveServerFetchBasis,
} from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';

import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { parseBuiltInLegacyConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import { z } from 'zod/mini';

function extractErrorCode(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  return typeof obj.error === 'string' ? obj.error : null;
}

const ConnectedServiceQuotasV3ResponseSchema = z.object({
  content: StoredJsonContentEnvelopeSchema,
  metadata: z.object({
    fetchedAt: z.number().check(z.int(), z.nonnegative()),
    staleAfterMs: z.number().check(z.int(), z.nonnegative()),
    status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
    refreshRequestedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  }),
});

export async function getConnectedServiceQuotaSnapshotPlain(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
  opts?: Readonly<{
    signal?: AbortSignal;
    expectedActiveServer?: ExpectedActiveServerFetchBasis;
  }>,
): Promise<Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1;
  metadata: z.infer<typeof ConnectedServiceQuotasV3ResponseSchema>['metadata'];
}> | null> {
  const request = createServerFetchForActiveServer(opts?.expectedActiveServer);
  return await backoff(async () => {
    const response = await request(
      `/v3/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/quotas`,
      {
        method: 'GET',
        signal: opts?.signal,
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
      },
      {
        includeAuth: false,
        ...(opts?.expectedActiveServer
          ? { expectedActiveServer: opts.expectedActiveServer }
          : {}),
      },
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
    const parsed = ConnectedServiceQuotasV3ResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Invalid quota snapshot response for ${params.serviceId}`);
    }

    if (parsed.data.content.t !== 'plain') return null;

    try {
      return {
        snapshot: parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(parsed.data.content.v),
        metadata: parsed.data.metadata,
      };
    } catch {
      throw new Error(`Invalid quota snapshot response for ${params.serviceId}`);
    }
  }, { signal: opts?.signal });
}

export async function requestConnectedServiceQuotaSnapshotRefreshV3(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
  opts?: Readonly<{
    signal?: AbortSignal;
    expectedActiveServer?: ExpectedActiveServerFetchBasis;
  }>,
): Promise<boolean> {
  const request = createServerFetchForActiveServer(opts?.expectedActiveServer);
  return await backoff(async () => {
    const response = await request(
      `/v3/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/quotas/refresh`,
      {
        method: 'POST',
        signal: opts?.signal,
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      {
        includeAuth: false,
        ...(opts?.expectedActiveServer
          ? { expectedActiveServer: opts.expectedActiveServer }
          : {}),
      },
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
  }, { signal: opts?.signal });
}
