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

export async function getConnectedServiceCredentialSealed(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
): Promise<Readonly<{ sealed: SealedConnectedServiceCredentialV1; metadata: ConnectedServiceCredentialMetadataInput }>> {
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

    if (!json || typeof json !== 'object') {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
    const sealed = (json as any).sealed;
    const metadata = (json as any).metadata;
    if (!sealed || typeof sealed !== 'object') {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
    if (typeof (sealed as any).format !== 'string' || typeof (sealed as any).ciphertext !== 'string') {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
    if (!metadata || typeof metadata !== 'object') {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
    return {
      sealed: { format: (sealed as any).format, ciphertext: (sealed as any).ciphertext } as SealedConnectedServiceCredentialV1,
      metadata: {
        kind: (metadata as any).kind === 'token' ? 'token' : 'oauth',
        providerEmail: typeof (metadata as any).providerEmail === 'string' ? (metadata as any).providerEmail : null,
        providerAccountId: typeof (metadata as any).providerAccountId === 'string' ? (metadata as any).providerAccountId : null,
        expiresAt: typeof (metadata as any).expiresAt === 'number' ? (metadata as any).expiresAt : null,
      },
    };
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

export type OpenAiCodexDeviceAuthStartResponse = Readonly<{
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  verificationUrl: string;
}>;

export async function startOpenAiCodexDeviceAuthViaProxy(
  credentials: AuthCredentials,
  params: Readonly<{ publicKey: string }>,
): Promise<OpenAiCodexDeviceAuthStartResponse> {
  return await backoff(async () => {
    const response = await serverFetch(
      `/v2/connect/openai-codex/oauth/device/start`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ publicKey: params.publicKey }),
      },
      { includeAuth: false },
    );

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        let message = 'connect_oauth_exchange_failed';
        message = extractErrorCode(json) ?? message;
        throw new HappyError(message, false, { status: response.status, kind: 'server' });
      }
      throw new Error(`Failed to start device auth: ${response.status}`);
    }

    const deviceAuthId = json && typeof (json as any).deviceAuthId === 'string' ? String((json as any).deviceAuthId) : '';
    const userCode = json && typeof (json as any).userCode === 'string' ? String((json as any).userCode) : '';
    const intervalMs = json && typeof (json as any).intervalMs === 'number' ? Number((json as any).intervalMs) : NaN;
    const verificationUrl =
      json && typeof (json as any).verificationUrl === 'string' ? String((json as any).verificationUrl) : '';

    if (!deviceAuthId || !userCode || !Number.isFinite(intervalMs) || intervalMs <= 0 || !verificationUrl) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }

    return { deviceAuthId, userCode, intervalMs, verificationUrl };
  });
}

export type OpenAiCodexDeviceAuthPollResponse =
  | Readonly<{ status: 'pending'; retryAfterMs: number }>
  | Readonly<{ status: 'success'; bundle: string }>;

export async function pollOpenAiCodexDeviceAuthViaProxy(
  credentials: AuthCredentials,
  params: Readonly<{ publicKey: string; deviceAuthId: string; userCode: string; intervalMs: number }>,
): Promise<OpenAiCodexDeviceAuthPollResponse> {
  return await backoff(async () => {
    const response = await serverFetch(
      `/v2/connect/openai-codex/oauth/device/poll`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publicKey: params.publicKey,
          deviceAuthId: params.deviceAuthId,
          userCode: params.userCode,
          intervalMs: params.intervalMs,
        }),
      },
      { includeAuth: false },
    );

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        let message = 'connect_oauth_exchange_failed';
        message = extractErrorCode(json) ?? message;
        throw new HappyError(message, false, { status: response.status, kind: 'server' });
      }
      throw new Error(`Failed to poll device auth: ${response.status}`);
    }

    const status = json && typeof (json as any).status === 'string' ? String((json as any).status) : '';
    if (status === 'pending') {
      const retryAfterMs = typeof (json as any).retryAfterMs === 'number' ? Number((json as any).retryAfterMs) : NaN;
      if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
        throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
      }
      return { status: 'pending', retryAfterMs };
    }
    if (status === 'success') {
      const bundle = typeof (json as any).bundle === 'string' ? String((json as any).bundle) : '';
      if (!bundle) throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
      return { status: 'success', bundle };
    }

    throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
  });
}
