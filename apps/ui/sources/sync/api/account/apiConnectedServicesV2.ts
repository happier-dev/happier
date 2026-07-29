import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';
import { z } from 'zod';

import {
  SealedConnectedServiceCredentialV1Schema,
  readConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceId,
  type SealedConnectedServiceCredentialV1,
} from '@happier-dev/protocol';

const ConnectedServiceCredentialSealedResponseSchema = z.object({
  sealed: SealedConnectedServiceCredentialV1Schema,
  metadata: z.object({
    kind: z.enum(['oauth', 'token']),
    providerEmail: z.string().nullable().optional(),
    providerAccountId: z.string().nullable().optional(),
    expiresAt: z.number().finite().nullable().optional(),
  }),
});

type ConnectedServiceCredentialMetadataInput = Readonly<{
  kind: 'oauth' | 'token';
  providerEmail?: string | null;
  providerAccountId?: string | null;
  expiresAt?: number | null;
}>;

function extractErrorCode(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const maybe = json as any;
  return typeof maybe.error === 'string' ? maybe.error : null;
}

export async function getConnectedServiceCredentialSealed(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
): Promise<Readonly<{
  sealed: SealedConnectedServiceCredentialV1;
  metadata: ConnectedServiceCredentialMetadataInput;
}> & ConnectedServiceCredentialRevisionBoundaryV1> {
  return await backoff(async () => {
    const response = await serverFetch(
      `/v2/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/credential`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
      },
      { includeAuth: false },
    );

    const json = await response.json().catch(() => null);

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        let message = 'connect_credential_not_found';
        message = extractErrorCode(json) ?? message;
        throw new HappyError(message, false, { status: response.status, kind: 'server' });
      }
      throw new Error(`Failed to fetch connected service credential: ${response.status}`);
    }

    const parsed = ConnectedServiceCredentialSealedResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
    const revision = readConnectedServiceCredentialRevisionBoundaryV1(
      json && typeof json === 'object' ? json as { credentialRevision?: unknown } : {},
    );
    if (!revision) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
    return {
      ...revision,
      sealed: parsed.data.sealed,
      metadata: parsed.data.metadata,
    };
  });
}
