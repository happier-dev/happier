import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { connectedServiceFetch } from './connectedServiceNetworkError';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';
import { createConnectedServiceApiError } from './connectedServiceApiError';
import { assertConnectedServiceOperationSupported } from './connectedServiceOperationSupport';

import {
  assertConnectedServiceCredentialRecordBinding,
  ConnectedServiceCredentialRecordV1Schema,
  ConnectedServiceCredentialCompatibleMutationSuccessV1Schema,
  StoredJsonContentEnvelopeSchema,
  readConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

type ConnectedServiceCredentialPlainWriteRevisionBoundary =
  | Readonly<{
      revisionSemantics: 'revisioned';
      expectedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null;
    }>
  | Readonly<{
      revisionSemantics: 'legacy_unfenced';
    }>;

/**
 * Exact server-v0.2.1 compatibility for
 * 4913c1e533c872a0712ba1c25b3104fd470aacc2: its strict V3 body accepts only
 * `content`. Remove the legacy branch when exact 0.2.1 leaves the supported
 * predecessor window.
 */
export async function registerConnectedServiceCredentialPlain(
  credentials: AuthCredentials,
  params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    record: ConnectedServiceCredentialRecordV1;
    reconnect?: Readonly<{ allowProviderIdentityChange?: boolean }>;
  } & ConnectedServiceCredentialPlainWriteRevisionBoundary>,
): Promise<ConnectedServiceCredentialRevisionBoundaryV1> {
    await assertConnectedServiceOperationSupported(params.serviceId);
    const response = await connectedServiceFetch(
      'registerConnectedServiceCredentialPlain',
      `/v3/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/credential`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: { t: 'plain', v: params.record },
          ...(params.revisionSemantics === 'revisioned'
            ? { expectedCredentialRevision: params.expectedCredentialRevision }
            : {}),
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

export async function deleteConnectedServiceCredentialV3(
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
    const path = `/v3/connect/${encodeURIComponent(params.serviceId)}/profiles/${encodeURIComponent(params.profileId)}/credential?${query.toString()}`;
    const response = await connectedServiceFetch(
      'deleteConnectedServiceCredentialV3',
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

export async function getConnectedServiceCredentialPlain(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
): Promise<Readonly<{
  content: Readonly<{ t: 'plain'; v: ConnectedServiceCredentialRecordV1 }>;
}> & ConnectedServiceCredentialRevisionBoundaryV1> {
  return await backoff(async () => {
    const response = await connectedServiceFetch(
      'getConnectedServiceCredentialPlain',
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
        const json = await response.json().catch(() => null);
        throw createConnectedServiceApiError(json, {
          status: response.status,
          fallbackCode: 'connect_credential_not_found',
        });
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
    const revision = readConnectedServiceCredentialRevisionBoundaryV1(
      json as { credentialRevision?: unknown },
    );
    if (!record.success || !revision) {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }

    let boundRecord: ConnectedServiceCredentialRecordV1;
    try {
      boundRecord = assertConnectedServiceCredentialRecordBinding({
        binding: { serviceId: params.serviceId, profileId: params.profileId },
        record: record.data,
      });
    } catch {
      throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }

    return { ...revision, content: { t: 'plain', v: boundRecord } };
  });
}
