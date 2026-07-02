/**
 * Connected service credential resolver (client-side)
 *
 * Fetches sealed ciphertext from Happier Cloud and decrypts it locally using account-scoped crypto
 * material. The server never decrypts these payloads.
 */

import {
  ConnectedServiceCredentialRecordV1Schema,
  openConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { resolveConnectedServiceAccountMode } from './resolveConnectedServiceAccountMode';

type ConnectedServiceCredentialBinding = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
}>;

function parseCredentialRecord(params: Readonly<{
  value: unknown;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): ConnectedServiceCredentialRecordV1 {
  const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(params.value);
  if (!parsed.success) {
    throw new Error(`Invalid connected service credential payload (${params.serviceId}/${params.profileId})`);
  }
  return parsed.data;
}

async function resolvePlainConnectedServiceCredential(params: Readonly<{
  api: ApiClient;
  binding: ConnectedServiceCredentialBinding;
}>): Promise<ConnectedServiceCredentialRecordV1 | null> {
  if (typeof params.api.getConnectedServiceCredentialPlain !== 'function') return null;
  const plain = await params.api.getConnectedServiceCredentialPlain({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  });
  if (!plain || plain.content.t !== 'plain') return null;
  return parseCredentialRecord({
    value: plain.content.v,
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  });
}

async function resolveSealedConnectedServiceCredential(params: Readonly<{
  credentials: Credentials;
  api: ApiClient;
  binding: ConnectedServiceCredentialBinding;
}>): Promise<ConnectedServiceCredentialRecordV1 | null> {
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

  return parseCredentialRecord({
    value: opened.value,
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  });
}

export async function resolveConnectedServiceCredentials(params: Readonly<{
  credentials: Credentials;
  api: ApiClient;
  bindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
}>): Promise<Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>> {
  const out = new Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>();
  const accountMode = await resolveConnectedServiceAccountMode(params.api);

  for (const binding of params.bindings) {
    if (accountMode !== 'e2ee') {
      let plainRecord: ConnectedServiceCredentialRecordV1 | null = null;
      try {
        plainRecord = await resolvePlainConnectedServiceCredential({
          api: params.api,
          binding,
        });
      } catch (error) {
        if (accountMode !== 'unknown') throw error;
      }
      if (plainRecord) {
        out.set(binding.serviceId, plainRecord);
        continue;
      }
      if (accountMode === 'plain') {
        throw new Error(`Missing connected service credential (${binding.serviceId}/${binding.profileId})`);
      }
    }

    const record = await resolveSealedConnectedServiceCredential({
        credentials: params.credentials,
        api: params.api,
        binding,
      });
    if (!record) {
      throw new Error(`Missing connected service credential (${binding.serviceId}/${binding.profileId})`);
    }

    out.set(binding.serviceId, record);
  }

  return out;
}
