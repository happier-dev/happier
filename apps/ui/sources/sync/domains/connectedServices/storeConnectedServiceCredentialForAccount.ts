import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { registerConnectedServiceCredentialSealed, deleteConnectedServiceCredential as deleteConnectedServiceCredentialV2 } from '@/sync/api/account/apiConnectedServicesV2';
import { registerConnectedServiceCredentialPlain, deleteConnectedServiceCredentialV3 } from '@/sync/api/account/apiConnectedServicesV3';

import type { ConnectedServiceCredentialRecordV1, ConnectedServiceId } from '@happier-dev/protocol';

import { sealConnectedServiceCredential } from './sealConnectedServiceCredential';

export async function storeConnectedServiceCredentialForAccount(
  credentials: AuthCredentials,
  params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    record: ConnectedServiceCredentialRecordV1;
  }>,
  opts?: Readonly<{ randomBytes?: (length: number) => Uint8Array }>,
): Promise<void> {
  const mode = await fetchAccountEncryptionMode(credentials);

  if (mode.mode === 'plain') {
    await registerConnectedServiceCredentialPlain(credentials, {
      serviceId: params.serviceId,
      profileId: params.profileId,
      record: params.record,
    });
    return;
  }

  const ciphertext = sealConnectedServiceCredential({ credentials, record: params.record, randomBytes: opts?.randomBytes });
  await registerConnectedServiceCredentialSealed(credentials, {
    serviceId: params.serviceId,
    profileId: params.profileId,
    sealed: { format: 'account_scoped_v1', ciphertext },
    metadata: {
      kind: params.record.kind,
      providerEmail: params.record.kind === 'oauth' ? params.record.oauth?.providerEmail : params.record.token?.providerEmail,
      providerAccountId: params.record.kind === 'oauth' ? params.record.oauth?.providerAccountId : params.record.token?.providerAccountId,
      expiresAt: params.record.expiresAt ?? null,
    },
  });
}

export async function deleteConnectedServiceCredentialForAccount(
  credentials: AuthCredentials,
  params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
): Promise<void> {
  const mode = await fetchAccountEncryptionMode(credentials);
  if (mode.mode === 'plain') {
    await deleteConnectedServiceCredentialV3(credentials, params);
    return;
  }
  await deleteConnectedServiceCredentialV2(credentials, params);
}

