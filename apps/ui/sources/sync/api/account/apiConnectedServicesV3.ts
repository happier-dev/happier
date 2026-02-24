import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';

import {
  ConnectedServiceCredentialRecordV1Schema,
  StoredJsonContentEnvelopeSchema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

function extractErrorCode(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const maybe = json as any;
  return typeof maybe.error === 'string' ? maybe.error : null;
}

export async function registerConnectedServiceCredentialPlain(
  credentials: AuthCredentials,
  params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    record: ConnectedServiceCredentialRecordV1;
  }>,
): Promise<void> {
  await backoff(async () => {
    const response = await serverFetch(
      `/v3/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/credential`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: { t: 'plain', v: params.record },
        }),
      },
      { includeAuth: false },
    );

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        let message = `Failed to connect ${params.serviceId}`;
        try {
          const json = await response.json();
          message = extractErrorCode(json) ?? message;
        } catch {
          // ignore
        }
        throw new HappyError(message, false, { status: response.status, kind: 'server' });
      }
      throw new Error(`Failed to connect ${params.serviceId}: ${response.status}`);
    }

    const json = await response.json().catch(() => null);
    if (!json || (json as any).success !== true) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
  });
}

export async function deleteConnectedServiceCredentialV3(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
): Promise<void> {
  await backoff(async () => {
    const response = await serverFetch(
      `/v3/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/credential`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
      },
      { includeAuth: false },
    );

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        let message = 'connect_credential_not_found';
        try {
          const json = await response.json();
          message = extractErrorCode(json) ?? message;
        } catch {
          // ignore
        }
        throw new HappyError(message, false, { status: response.status, kind: 'server' });
      }
      throw new Error(`Failed to disconnect ${params.serviceId}: ${response.status}`);
    }

    const json = await response.json().catch(() => null);
    if (!json || (json as any).success !== true) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
  });
}

export async function getConnectedServiceCredentialPlain(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
): Promise<Readonly<{ content: Readonly<{ t: 'plain'; v: ConnectedServiceCredentialRecordV1 }> }>> {
  return await backoff(async () => {
    const response = await serverFetch(
      `/v3/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/credential`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
      },
      { includeAuth: false },
    );

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        let message = `Failed to load ${params.serviceId}`;
        try {
          const json = await response.json();
          message = extractErrorCode(json) ?? message;
        } catch {
          // ignore
        }
        throw new HappyError(message, false, { status: response.status, kind: 'server' });
      }
      throw new Error(`Failed to load ${params.serviceId}: ${response.status}`);
    }

    const json = await response.json().catch(() => null);
    if (!json || typeof json !== 'object') {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }

    const content = (json as { content?: unknown }).content;
    const parsed = StoredJsonContentEnvelopeSchema.safeParse(content);
    if (!parsed.success || parsed.data.t !== 'plain') {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }

    const record = ConnectedServiceCredentialRecordV1Schema.safeParse(parsed.data.v);
    if (!record.success) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }

    return { content: { t: 'plain', v: record.data } };
  });
}
