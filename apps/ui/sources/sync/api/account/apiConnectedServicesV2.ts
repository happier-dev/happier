import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';

import type { ConnectedServiceId, SealedConnectedServiceCredentialV1 } from '@happier-dev/protocol';

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

export async function registerConnectedServiceCredentialSealed(
  credentials: AuthCredentials,
  params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    sealed: SealedConnectedServiceCredentialV1;
    metadata?: ConnectedServiceCredentialMetadataInput;
  }>,
): Promise<void> {
  await backoff(async () => {
    const response = await serverFetch(
      `/v2/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/credential`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sealed: params.sealed,
          metadata: params.metadata,
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
    if (!json || typeof (json as any).success !== 'boolean') {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
  });
}

export async function deleteConnectedServiceCredential(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
): Promise<void> {
  await backoff(async () => {
    const response = await serverFetch(
      `/v2/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/credential`,
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

export async function exchangeConnectedServiceOauthViaProxy(
  credentials: AuthCredentials,
  params: Readonly<{
    serviceId: ConnectedServiceId;
    publicKey: string;
    code: string;
    verifier: string;
    redirectUri: string;
    state?: string | null;
  }>,
): Promise<Readonly<{ bundle: string }>> {
  return await backoff(async () => {
    const response = await serverFetch(
      `/v2/connect/${encodeURIComponent(params.serviceId)}/oauth/exchange`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publicKey: params.publicKey,
          code: params.code,
          verifier: params.verifier,
          redirectUri: params.redirectUri,
          ...(params.state ? { state: params.state } : {}),
        }),
      },
      { includeAuth: false },
    );

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        let message = `Failed to exchange ${params.serviceId} OAuth code`;
        try {
          const json = await response.json();
          message = extractErrorCode(json) ?? message;
        } catch {
          // ignore
        }
        throw new HappyError(message, false, { status: response.status, kind: 'server' });
      }
      throw new Error(`Failed to exchange ${params.serviceId}: ${response.status}`);
    }

    const json = await response.json().catch(() => null);
    const bundle = json && typeof (json as any).bundle === 'string' ? String((json as any).bundle) : '';
    if (!bundle) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }

    return { bundle };
  });
}
