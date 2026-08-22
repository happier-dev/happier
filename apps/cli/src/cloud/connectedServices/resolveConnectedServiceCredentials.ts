/**
 * Connected service credential resolver (client-side)
 *
 * Fetches sealed ciphertext from Happier Cloud and decrypts it locally using account-scoped crypto
 * material. The server never decrypts these payloads.
 */

import {
  ConnectedServiceCredentialBindingMismatchError,
  assertConnectedServiceCredentialRecordBinding,
  openConnectedServiceCredentialCiphertext,
  parseBuiltInLegacyConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export {
  ConnectedServiceCredentialBindingMismatchError,
  assertConnectedServiceCredentialRecordBinding,
} from '@happier-dev/protocol';

import type { ConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import type { StoredCredentials } from '@/persistence';
import { ConnectedServiceStoredContentUnavailableError } from './connectedServiceStoredContentUnavailable';
import {
  resolveConnectedServiceAccountMode,
  type ConnectedServiceAccountMode,
} from './resolveConnectedServiceAccountMode';

type ConnectedServiceCredentialBinding = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
}>;

type ConnectedServiceCredentialResolutionApi = Readonly<{
  getAccountEncryptionMode?: ConnectedServiceCredentialApi['getAccountEncryptionMode'];
  getConnectedServiceCredentialPlain?: ConnectedServiceCredentialApi['getConnectedServiceCredentialPlain'];
  getConnectedServiceCredentialSealed: ConnectedServiceCredentialApi['getConnectedServiceCredentialSealed'];
}>;

export type ConnectedServiceCredentialResolution = Readonly<{
  record: ConnectedServiceCredentialRecordV1;
}> & ConnectedServiceCredentialRevisionBoundaryV1;

export class ConnectedServiceCredentialResolutionError extends Error {
  readonly name = 'ConnectedServiceCredentialResolutionError';
  readonly kind = 'missing_credential' as const;
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;

  constructor(binding: ConnectedServiceCredentialBinding & Readonly<{ kind?: 'missing_credential' }>) {
    super(`Missing connected service credential (${binding.serviceId}/${binding.profileId})`);
    this.serviceId = binding.serviceId;
    this.profileId = binding.profileId;
  }
}

export class ConnectedServiceCredentialEncryptionMaterialUnavailableError
  extends ConnectedServiceStoredContentUnavailableError {
  readonly name = 'ConnectedServiceCredentialEncryptionMaterialUnavailableError';
  readonly kind = 'encryption_material_unavailable' as const;

  constructor(binding: ConnectedServiceCredentialBinding) {
    super('credential', 'encryption_material_unavailable', binding);
  }
}

function parseCredentialRecord(params: Readonly<{
  value: unknown;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): ConnectedServiceCredentialRecordV1 {
  let record: ConnectedServiceCredentialRecordV1;
  try {
    record =
      parseBuiltInLegacyConnectedServiceCredentialRecordV1(params.value);
  } catch {
    throw new ConnectedServiceStoredContentUnavailableError(
      'credential',
      'stored_content_corrupt',
      params,
    );
  }
  return assertConnectedServiceCredentialRecordBinding({
    binding: { serviceId: params.serviceId, profileId: params.profileId },
    record,
  });
}

async function resolvePlainConnectedServiceCredential(params: Readonly<{
  api: ConnectedServiceCredentialResolutionApi;
  binding: ConnectedServiceCredentialBinding;
  signal?: AbortSignal;
}>): Promise<ConnectedServiceCredentialSourceResolution | null> {
  if (typeof params.api.getConnectedServiceCredentialPlain !== 'function') return null;
  const plain = await params.api.getConnectedServiceCredentialPlain({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!plain) return null;
  if (plain.content.t !== 'plain') {
    throw new ConnectedServiceStoredContentUnavailableError(
      'credential',
      'stored_content_corrupt',
      params.binding,
    );
  }
  const record = parseCredentialRecord({
      value: plain.content.v,
      serviceId: params.binding.serviceId,
      profileId: params.binding.profileId,
    });
  return plain.revisionSemantics === 'revisioned'
    ? { record, storageMode: 'plain', revisionSemantics: 'revisioned', credentialRevision: plain.credentialRevision }
    : { record, storageMode: 'plain', revisionSemantics: 'legacy_unfenced', credentialRevision: null };
}

async function resolveSealedConnectedServiceCredential(params: Readonly<{
  credentials: StoredCredentials;
  api: ConnectedServiceCredentialResolutionApi;
  binding: ConnectedServiceCredentialBinding;
  signal?: AbortSignal;
}>): Promise<ConnectedServiceCredentialSourceResolution | null> {
  if (!params.credentials.encryption) {
    throw new ConnectedServiceCredentialEncryptionMaterialUnavailableError(
      params.binding,
    );
  }
  const sealed = await params.api.getConnectedServiceCredentialSealed({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!sealed) return null;
  if (!sealed.sealed?.ciphertext) {
    throw new ConnectedServiceStoredContentUnavailableError(
      'credential',
      'stored_content_corrupt',
      params.binding,
    );
  }

  const opened = openConnectedServiceCredentialCiphertext({
    material:
      params.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: params.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
    ciphertext: sealed.sealed.ciphertext,
  });
  if (!opened || !opened.value) {
    throw new ConnectedServiceStoredContentUnavailableError(
      'credential',
      'stored_content_corrupt',
      params.binding,
    );
  }

  const record = parseCredentialRecord({
      value: opened.value,
      serviceId: params.binding.serviceId,
      profileId: params.binding.profileId,
  });
  return sealed.revisionSemantics === 'revisioned'
    ? { record, storageMode: 'e2ee', revisionSemantics: 'revisioned', credentialRevision: sealed.credentialRevision }
    : { record, storageMode: 'e2ee', revisionSemantics: 'legacy_unfenced', credentialRevision: null };
}

export type ConnectedServiceCredentialSourceResolution =
  ConnectedServiceCredentialResolution
  & Readonly<{ storageMode: 'plain' | 'e2ee' }>;

export async function resolveConnectedServiceCredentialSource(params: Readonly<{
  credentials: StoredCredentials;
  api: ConnectedServiceCredentialResolutionApi;
  binding: ConnectedServiceCredentialBinding;
  accountMode?: ConnectedServiceAccountMode;
  signal?: AbortSignal;
}>): Promise<ConnectedServiceCredentialSourceResolution | null> {
  const accountMode =
    params.accountMode ?? await resolveConnectedServiceAccountMode(params.api, { signal: params.signal });

  if (accountMode === 'unknown') {
    throw new ConnectedServiceStoredContentUnavailableError(
      'credential',
      'account_mode_unavailable',
      params.binding,
    );
  }

  return accountMode === 'plain'
    ? await resolvePlainConnectedServiceCredential(params)
    : await resolveSealedConnectedServiceCredential(params);
}

export async function resolveConnectedServiceCredentialResolutions(params: Readonly<{
  credentials: StoredCredentials;
  api: ConnectedServiceCredentialResolutionApi;
  bindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
  accountMode?: ConnectedServiceAccountMode;
  signal?: AbortSignal;
}>): Promise<Map<ConnectedServiceId, ConnectedServiceCredentialResolution>> {
  params.signal?.throwIfAborted();
  const out = new Map<ConnectedServiceId, ConnectedServiceCredentialResolution>();
  const accountMode =
    params.accountMode ?? await resolveConnectedServiceAccountMode(params.api, {
      ...(params.signal ? { signal: params.signal } : {}),
    });

  for (const binding of params.bindings) {
    params.signal?.throwIfAborted();
    const resolution = await resolveConnectedServiceCredentialSource({
      credentials: params.credentials,
      api: params.api,
      binding,
      accountMode,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    params.signal?.throwIfAborted();
    if (!resolution) {
      throw new ConnectedServiceCredentialResolutionError(binding);
    }

    out.set(
      binding.serviceId,
      resolution.revisionSemantics === 'revisioned'
        ? {
            record: resolution.record,
            revisionSemantics: 'revisioned',
            credentialRevision: resolution.credentialRevision,
          }
        : {
            record: resolution.record,
            revisionSemantics: 'legacy_unfenced',
            credentialRevision: null,
          },
    );
  }

  return out;
}

export async function resolveConnectedServiceCredentials(params: Readonly<{
  credentials: StoredCredentials;
  api: ConnectedServiceCredentialResolutionApi;
  bindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
  signal?: AbortSignal;
}>): Promise<Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>> {
  const resolutions = await resolveConnectedServiceCredentialResolutions(params);
  return new Map([...resolutions].map(([serviceId, resolution]) => [serviceId, resolution.record]));
}
