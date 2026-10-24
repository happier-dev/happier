import {
  ConnectedServiceCredentialRecordV1Schema,
  buildConnectedServiceCredentialMetadata,
  sealConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionBoundaryV1,
} from '@happier-dev/protocol';
import { randomBytes } from 'node:crypto';

import type { ApiClient } from '@/api/api';
import { requireEncryptionCredentials, type Credentials } from '@/persistence';
import { resolveConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { assertConnectedServiceCredentialRecordBinding } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import {
  openConnectedServiceRecord,
} from './oauthCredentialRecords';
import type {
  BoundProfile,
  ConnectedServiceCredentialSource,
} from './refreshTypes';

function credentialRevisionBoundary(
  value: ConnectedServiceCredentialRevisionBoundaryV1,
): ConnectedServiceCredentialRevisionBoundaryV1 {
  return value.revisionSemantics === 'revisioned'
    ? { revisionSemantics: 'revisioned', credentialRevision: value.credentialRevision }
    : { revisionSemantics: 'legacy_unfenced', credentialRevision: null };
}

export async function readCredentialForRefresh(input: Readonly<{
  api: ApiClient;
  credentials: Credentials;
  binding: BoundProfile;
}>): Promise<ConnectedServiceCredentialSource | null> {
  const accountMode = await resolveConnectedServiceAccountMode(input.api);
  if (accountMode !== 'e2ee' && typeof input.api.getConnectedServiceCredentialPlain === 'function') {
    const plain = accountMode === 'unknown'
      ? await input.api.getConnectedServiceCredentialPlain({
          serviceId: input.binding.serviceId,
          profileId: input.binding.profileId,
        }).catch(() => null)
      : await input.api.getConnectedServiceCredentialPlain({
          serviceId: input.binding.serviceId,
          profileId: input.binding.profileId,
        });
    if (plain) {
      return {
        mode: 'plain',
        record: assertConnectedServiceCredentialRecordBinding({
          binding: input.binding,
          record: ConnectedServiceCredentialRecordV1Schema.parse(plain.content.v),
        }),
        ...credentialRevisionBoundary(plain),
      };
    }
    if (accountMode === 'plain') return null;
  }

  const sealed = await input.api.getConnectedServiceCredentialSealed({
    serviceId: input.binding.serviceId,
    profileId: input.binding.profileId,
  });
  if (!sealed) return null;
  const record = openConnectedServiceRecord({
    credentials: input.credentials,
    ciphertext: sealed.sealed.ciphertext,
  });
  return {
    mode: 'sealed',
    record: assertConnectedServiceCredentialRecordBinding({ binding: input.binding, record }),
    metadata: sealed.metadata,
    ...credentialRevisionBoundary(sealed),
  };
}

export async function persistRefreshedCredential(input: Readonly<{
  api: ApiClient;
  credentials: Credentials;
  binding: BoundProfile;
  source: Extract<ConnectedServiceCredentialSource, { revisionSemantics: 'revisioned' }>;
  updated: ConnectedServiceCredentialRecordV1;
  refreshLeaseOwnerId: string;
}>): Promise<{ success: true; credentialRevision: string } | { error: 'connect_credential_mutation_superseded'; reason: 'revision_mismatch' | 'refresh_lease_lost'; credentialRevision: string | null }> {
  if (input.source.mode === 'plain') {
    const result = await input.api.registerConnectedServiceCredentialPlain({
      serviceId: input.binding.serviceId,
      profileId: input.binding.profileId,
      content: { t: 'plain', v: input.updated },
      expectedCredentialRevision: input.source.credentialRevision,
      refreshLeaseOwnerId: input.refreshLeaseOwnerId,
    });
    if (!('error' in result) && !('credentialRevision' in result)) {
      throw new Error('Revisioned credential refresh received an unfenced mutation response');
    }
    return result;
  }

  requireEncryptionCredentials(input.credentials);
  const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
    material:
      input.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: input.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: input.credentials.encryption.machineKey },
    payload: input.updated,
    randomBytes: (length) => randomBytes(length),
  });

  const result = await input.api.registerConnectedServiceCredentialSealed({
    serviceId: input.binding.serviceId,
    profileId: input.binding.profileId,
    sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
    metadata: buildConnectedServiceCredentialMetadata(input.updated),
    expectedCredentialRevision: input.source.credentialRevision,
    refreshLeaseOwnerId: input.refreshLeaseOwnerId,
  });
  if (!('error' in result) && !('credentialRevision' in result)) {
    throw new Error('Revisioned credential refresh received an unfenced mutation response');
  }
  return result;
}
