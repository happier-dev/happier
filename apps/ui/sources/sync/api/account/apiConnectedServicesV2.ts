import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';
import { createConnectedServiceApiError } from './connectedServiceApiError';
import { z } from 'zod';

import {
  ConnectedServiceCredentialCompatibleMutationSuccessV1Schema,
  SealedConnectedServiceCredentialV1Schema,
  readConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceId,
  type SealedConnectedServiceCredentialV1,
} from '@happier-dev/protocol';

const ConnectedServiceCredentialMetadataResponseSchema = z.object({
  kind: z.enum(['oauth', 'token']),
  providerEmail: z.string().nullable().optional(),
  providerAccountId: z.string().nullable().optional(),
  expiresAt: z.number().finite().nullable().optional(),
});

const ConnectedServiceCredentialSealedResponseSchema = z.object({
  sealed: SealedConnectedServiceCredentialV1Schema,
  metadata: ConnectedServiceCredentialMetadataResponseSchema,
});

type ConnectedServiceCredentialMetadataInput = Readonly<{
  kind: 'oauth' | 'token';
  providerEmail?: string | null;
  providerAccountId?: string | null;
  expiresAt?: number | null;
}>;

/**
 * Compatible response parsing here supports exact server-v0.2.1 at
 * 4913c1e533c872a0712ba1c25b3104fd470aacc2, which omitted credential revisions.
 * Remove the legacy response branch when exact 0.2.1 leaves the supported
 * predecessor window.
 */
export async function registerConnectedServiceCredentialSealed(
  credentials: AuthCredentials,
  params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    sealed: SealedConnectedServiceCredentialV1;
    metadata?: ConnectedServiceCredentialMetadataInput;
    reconnect?: Readonly<{ allowProviderIdentityChange?: boolean }>;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null;
  }>,
): Promise<ConnectedServiceCredentialRevisionBoundaryV1> {
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
          expectedCredentialRevision: params.expectedCredentialRevision,
          ...(params.reconnect ? { reconnect: params.reconnect } : {}),
        }),
      },
      { includeAuth: false, retry: 'none' },
    );

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw createConnectedServiceApiError(json, {
        status: response.status,
        fallbackCode: 'connect_credential_request_failed',
      });
    }
    const parsed = ConnectedServiceCredentialCompatibleMutationSuccessV1Schema.safeParse(json);
    if (!parsed.success) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
    const revision = readConnectedServiceCredentialRevisionBoundaryV1(parsed.data);
    if (!revision) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
    return revision;
}

export async function deleteConnectedServiceCredential(
  credentials: AuthCredentials,
  params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    cleanupGroupReferences?: boolean;
  }>,
): Promise<void> {
  await backoff(async () => {
    const query = new URLSearchParams();
    if (params.cleanupGroupReferences) query.set('cleanupGroupReferences', 'true');
    query.set('expectedCredentialRevision', params.expectedCredentialRevision);
    const path = `/v2/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/credential?${query.toString()}`;
    const response = await serverFetch(
      path,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
        },
      },
      { includeAuth: false },
    );

    // Disconnect should be idempotent: if the credential is already gone, treat it as disconnected.
    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        const json = await response.json().catch(() => null);
        throw createConnectedServiceApiError(json, {
          status: response.status,
          fallbackCode: 'connect_credential_not_found',
        });
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
        throw createConnectedServiceApiError(json, {
          status: response.status,
          fallbackCode: 'connect_credential_not_found',
        });
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

export async function exchangeConnectedServiceOauthViaProxy(
  credentials: AuthCredentials,
  params: Readonly<{
    serviceId: ConnectedServiceId;
    publicKey: string;
    code: string;
    verifier: string;
    redirectUri: string;
    state?: string | null;
    projectId?: string;
  }>,
): Promise<Readonly<{ bundle: string }>> {
  // An authorization code is single-use. Neither HTTP nor outer backoff may replay it.
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
        ...(params.projectId ? { projectId: params.projectId } : {}),
      }),
    },
    { includeAuth: false, retry: 'none' },
  );

  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      const json = await response.json().catch(() => null);
      throw createConnectedServiceApiError(json, {
        status: response.status,
        fallbackCode: response.status === 400
          && json?.statusCode === 400
          && typeof json?.message === 'string'
          && json.message.includes('serviceId')
          ? 'connect_oauth_service_unsupported'
          : 'connect_oauth_exchange_failed',
      });
    }
    throw new Error(`Failed to exchange ${params.serviceId}: ${response.status}`);
  }

  const json = await response.json().catch(() => null);
  const bundle = json && typeof (json as any).bundle === 'string' ? String((json as any).bundle) : '';
  if (!bundle) {
    throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
  }

  return { bundle };
}

type OpenAiCodexDeviceAuthStartCommon = Readonly<{
  userCode: string;
  intervalMs: number;
  verificationUrl: string;
}>;

/**
 * The `released_v0_2_1` start/poll shape comes from exact server-v0.2.1 at
 * 4913c1e533c872a0712ba1c25b3104fd470aacc2. Remove it when exact 0.2.1 leaves
 * the supported predecessor window.
 */
export type OpenAiCodexDeviceAuthStartResponse =
  | (OpenAiCodexDeviceAuthStartCommon & Readonly<{
      kind: 'transaction';
      transactionId: string;
    }>)
  | (OpenAiCodexDeviceAuthStartCommon & Readonly<{
      kind: 'released_v0_2_1';
      deviceAuthId: string;
    }>);

const OpenAiCodexDeviceAuthStartResponseSchema = z.union([
  z.object({
    transactionId: z.string().min(1),
    userCode: z.string().min(1),
    intervalMs: z.number().finite().positive(),
    verificationUrl: z.string().min(1),
  }),
  z.object({
    deviceAuthId: z.string().min(1),
    userCode: z.string().min(1),
    intervalMs: z.number().finite().positive(),
    verificationUrl: z.string().min(1),
  }),
]);

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
        throw createConnectedServiceApiError(json, {
          status: response.status,
          fallbackCode: 'connect_oauth_exchange_failed',
        });
      }
      throw new Error(`Failed to start device auth: ${response.status}`);
    }

    const parsed = OpenAiCodexDeviceAuthStartResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }

    return 'transactionId' in parsed.data
      ? { kind: 'transaction', ...parsed.data }
      : { kind: 'released_v0_2_1', ...parsed.data };
  });
}

export type OpenAiCodexDeviceAuthPollResponse =
  | Readonly<{ status: 'pending'; retryAfterMs: number }>
  | Readonly<{ status: 'success'; bundle: string }>;

const OpenAiCodexDeviceAuthPollResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('pending'),
    retryAfterMs: z.number().finite().positive(),
  }),
  z.object({
    status: z.literal('success'),
    bundle: z.string().min(1),
  }),
]);

export async function pollOpenAiCodexDeviceAuthViaProxy(
  credentials: AuthCredentials,
  params: Readonly<{
    auth: OpenAiCodexDeviceAuthStartResponse;
    publicKey: string;
  }>,
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
        body: JSON.stringify(params.auth.kind === 'transaction'
          ? { transactionId: params.auth.transactionId }
          : {
              publicKey: params.publicKey,
              deviceAuthId: params.auth.deviceAuthId,
              userCode: params.auth.userCode,
              intervalMs: params.auth.intervalMs,
            }),
      },
      { includeAuth: false },
    );

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        throw createConnectedServiceApiError(json, {
          status: response.status,
          fallbackCode: 'connect_oauth_exchange_failed',
        });
      }
      throw new Error(`Failed to poll device auth: ${response.status}`);
    }

    const parsed = OpenAiCodexDeviceAuthPollResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
    return parsed.data;
  });
}
