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
import type { Credentials } from '@/persistence';
import { resolveConnectedServiceAccountMode } from './resolveConnectedServiceAccountMode';

type ConnectedServiceCredentialBinding = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
}>;

type ConnectedServiceCredentialResolutionApi = Pick<
  ConnectedServiceCredentialApi,
  'getAccountEncryptionMode' | 'getConnectedServiceCredentialPlain' | 'getConnectedServiceCredentialSealed'
>;

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
    throw new Error(`Invalid connected service credential payload (${params.serviceId}/${params.profileId})`);
  }
  return assertConnectedServiceCredentialRecordBinding({
    binding: { serviceId: params.serviceId, profileId: params.profileId },
    record,
  });
}

async function resolvePlainConnectedServiceCredential(params: Readonly<{
  api: ConnectedServiceCredentialResolutionApi;
  binding: ConnectedServiceCredentialBinding;
}>): Promise<ConnectedServiceCredentialResolution | null> {
  if (typeof params.api.getConnectedServiceCredentialPlain !== 'function') return null;
  const plain = await params.api.getConnectedServiceCredentialPlain({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  });
  if (!plain || plain.content.t !== 'plain') return null;
  const record = parseCredentialRecord({
      value: plain.content.v,
      serviceId: params.binding.serviceId,
      profileId: params.binding.profileId,
    });
  return plain.revisionSemantics === 'revisioned'
    ? { record, revisionSemantics: 'revisioned', credentialRevision: plain.credentialRevision }
    : { record, revisionSemantics: 'legacy_unfenced', credentialRevision: null };
}

async function resolveSealedConnectedServiceCredential(params: Readonly<{
  credentials: Credentials;
  api: ConnectedServiceCredentialResolutionApi;
  binding: ConnectedServiceCredentialBinding;
}>): Promise<ConnectedServiceCredentialResolution | null> {
  const sealed = await params.api.getConnectedServiceCredentialSealed({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  });
  if (!sealed) return null;

  const opened = openConnectedServiceCredentialCiphertext({
    material:
      params.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: params.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
    ciphertext: sealed.sealed.ciphertext,
  });
  if (!opened || !opened.value) {
    throw new Error(`Failed to decrypt connected service credential (${params.binding.serviceId}/${params.binding.profileId})`);
  }

  const record = parseCredentialRecord({
      value: opened.value,
      serviceId: params.binding.serviceId,
      profileId: params.binding.profileId,
    });
  return sealed.revisionSemantics === 'revisioned'
    ? { record, revisionSemantics: 'revisioned', credentialRevision: sealed.credentialRevision }
    : { record, revisionSemantics: 'legacy_unfenced', credentialRevision: null };
}

export async function resolveConnectedServiceCredentialResolutions(params: Readonly<{
  credentials: Credentials;
  api: ConnectedServiceCredentialResolutionApi;
  bindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
}>): Promise<Map<ConnectedServiceId, ConnectedServiceCredentialResolution>> {
  const out = new Map<ConnectedServiceId, ConnectedServiceCredentialResolution>();
  const accountMode = await resolveConnectedServiceAccountMode(params.api);

  for (const binding of params.bindings) {
    if (accountMode !== 'e2ee') {
      let plainResolution: ConnectedServiceCredentialResolution | null = null;
      try {
        plainResolution = await resolvePlainConnectedServiceCredential({
          api: params.api,
          binding,
        });
      } catch (error) {
        if (error instanceof ConnectedServiceCredentialBindingMismatchError) throw error;
        if (accountMode !== 'unknown') throw error;
      }
      if (plainResolution) {
        out.set(binding.serviceId, plainResolution);
        continue;
      }
      if (accountMode === 'plain') {
        throw new ConnectedServiceCredentialResolutionError(binding);
      }
    }

    const resolution = await resolveSealedConnectedServiceCredential({
        credentials: params.credentials,
        api: params.api,
        binding,
      });
    if (!resolution) {
      throw new ConnectedServiceCredentialResolutionError(binding);
    }

    out.set(binding.serviceId, resolution);
  }

  return out;
}

export async function resolveConnectedServiceCredentials(params: Readonly<{
  credentials: Credentials;
  api: ConnectedServiceCredentialResolutionApi;
  bindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
}>): Promise<Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>> {
  const resolutions = await resolveConnectedServiceCredentialResolutions(params);
  return new Map([...resolutions].map(([serviceId, resolution]) => [serviceId, resolution.record]));
}
