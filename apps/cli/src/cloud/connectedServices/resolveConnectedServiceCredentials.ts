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

export async function resolveConnectedServiceCredentials(params: Readonly<{
  credentials: Credentials;
  api: ApiClient;
  bindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
}>): Promise<Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>> {
  const out = new Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>();

  for (const binding of params.bindings) {
    const sealed = await params.api.getConnectedServiceCredentialSealed({
      serviceId: binding.serviceId,
      profileId: binding.profileId,
    });
    if (!sealed) {
      throw new Error(`Missing connected service credential (${binding.serviceId}/${binding.profileId})`);
    }

    const opened = openConnectedServiceCredentialCiphertext({
      material:
        params.credentials.encryption.type === 'legacy'
          ? { type: 'legacy', secret: params.credentials.encryption.secret }
          : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
      ciphertext: sealed.sealed.ciphertext,
    });
    if (!opened || !opened.value) {
      throw new Error(`Failed to decrypt connected service credential (${binding.serviceId}/${binding.profileId})`);
    }

    const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(opened.value);
    if (!parsed.success) {
      throw new Error(`Invalid connected service credential payload (${binding.serviceId}/${binding.profileId})`);
    }

    out.set(binding.serviceId, parsed.data);
  }

  return out;
}
