/**
 * Current connected credential resolution uses the qualified V4 owner.
 * Retained 0.2 payloads are decoded there; scalar native records are outputs,
 * never permission to select a historical HTTP transport.
 */
import type { ConnectedServiceCredentialRecordV1, ConnectedServiceCredentialRevisionBoundaryV1, ConnectedServiceId } from '@happier-dev/protocol';
export { ConnectedServiceCredentialBindingMismatchError, assertConnectedServiceCredentialRecordBinding } from '@happier-dev/protocol/connect/connectedServiceCredentialBinding';

import type { ConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { QualifiedConnectedAccountCredentialReadError, type readQualifiedConnectedAccountCredentialV4 } from '@/api/client/qualifiedConnectedAccountApi';
import type { StoredCredentials } from '@/persistence';
import { resolveQualifiedConnectedServiceCredentialSource } from './resolveQualifiedConnectedServiceCredentials';
import { ConnectedServiceStoredContentUnavailableError } from './connectedServiceStoredContentUnavailable';
import { resolveConnectedServiceAccountMode, type ConnectedServiceAccountMode } from './resolveConnectedServiceAccountMode';

import { ConnectedServiceCredentialResolutionError } from './connectedServiceCredentialResolutionErrors';
import type { ConnectedServiceCredentialBinding } from './connectedServiceCredentialResolutionErrors';
export { ConnectedServiceCredentialResolutionError } from './connectedServiceCredentialResolutionErrors';
type ConnectedServiceCredentialResolutionApi = Partial<Pick<ConnectedServiceCredentialApi, 'getAccountEncryptionMode'>>;

export type ConnectedServiceCredentialResolution = Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  providerOrganizationId?: string | null;
}> & ConnectedServiceCredentialRevisionBoundaryV1;

export class ConnectedServiceCredentialEncryptionMaterialUnavailableError extends ConnectedServiceStoredContentUnavailableError {
  readonly name = 'ConnectedServiceCredentialEncryptionMaterialUnavailableError';
  readonly kind = 'encryption_material_unavailable' as const;

  constructor(binding: ConnectedServiceCredentialBinding) {
    super('credential', 'encryption_material_unavailable', binding);
  }
}

export type ConnectedServiceCredentialSourceResolution =
  ConnectedServiceCredentialResolution & Readonly<{ storageMode: 'plain' | 'e2ee' }>;

export const resolveConnectedServiceCredentialSource = resolveQualifiedConnectedServiceCredentialSource;

export async function resolveConnectedServiceCredentialResolutions(params: Readonly<{
  credentials: StoredCredentials;
  api: ConnectedServiceCredentialResolutionApi;
  bindings: readonly ConnectedServiceCredentialBinding[];
  accountMode?: ConnectedServiceAccountMode;
  signal?: AbortSignal;
  readCredential?: typeof readQualifiedConnectedAccountCredentialV4;
}>): Promise<Map<ConnectedServiceId, ConnectedServiceCredentialResolution>> {
  params.signal?.throwIfAborted();
  const result = new Map<ConnectedServiceId, ConnectedServiceCredentialResolution>();
  const accountMode = params.accountMode ?? await resolveConnectedServiceAccountMode(params.api, { signal: params.signal });
  for (const binding of params.bindings) {
    params.signal?.throwIfAborted();
    const source = await resolveConnectedServiceCredentialSource({ ...params, binding, accountMode }).catch((error: unknown) => {
      if (error instanceof QualifiedConnectedAccountCredentialReadError) {
        throw new ConnectedServiceCredentialResolutionError(binding, error.kind);
      }
      throw error;
    });
    params.signal?.throwIfAborted();
    if (!source) throw new ConnectedServiceCredentialResolutionError(binding, 'confirmed_missing');
    result.set(binding.serviceId, {
      record: source.record,
      providerOrganizationId: source.providerOrganizationId ?? null,
      revisionSemantics: 'revisioned',
      credentialRevision: source.credentialRevision,
    });
  }
  return result;
}

export async function resolveConnectedServiceCredentials(params: Parameters<typeof resolveConnectedServiceCredentialResolutions>[0]): Promise<Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>> {
  const resolutions = await resolveConnectedServiceCredentialResolutions(params);
  return new Map([...resolutions].map(([serviceId, resolution]) => [serviceId, resolution.record]));
}
