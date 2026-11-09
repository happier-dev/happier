import { ConnectedServiceCredentialRecordV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import type { ConnectedServiceId, ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';

import type { ConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import type { readQualifiedConnectedAccountCredentialV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { readQualifiedConnectedAccountCredentialMaterial, readQualifiedConnectedAccountCredentialIdentity } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import type { StoredCredentials } from '@/persistence';
import { resolveConnectedServiceAccountMode, type ConnectedServiceAccountMode } from './resolveConnectedServiceAccountMode';
import { ConnectedServiceCredentialResolutionError } from './connectedServiceCredentialResolutionErrors';
import type { ConnectedServiceCredentialSourceResolution } from './resolveConnectedServiceCredentials';

type Input = Readonly<{
  credentials: StoredCredentials;
  api: Partial<Pick<ConnectedServiceCredentialApi, 'getAccountEncryptionMode'>>;
  binding: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;
  accountMode?: ConnectedServiceAccountMode;
  signal?: AbortSignal;
  readCredential?: typeof readQualifiedConnectedAccountCredentialV4;
}>;

/** Current credential transport. Scalar ids here describe a host-native consumer,
 * never a reason to select the legacy HTTP credential reader. */
export async function resolveQualifiedConnectedServiceCredentialSource(input: Input): Promise<(ConnectedServiceCredentialSourceResolution & Readonly<{ revisionSemantics: 'revisioned'; credentialRevision: ConnectedServiceCredentialRevisionV1 }>) | null> {
  const service = resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId(input.binding.serviceId);
  if (!service) throw new ConnectedServiceCredentialResolutionError(input.binding);
  const material = await readQualifiedConnectedAccountCredentialMaterial({
    credentials: input.credentials,
    account: { service, accountId: input.binding.profileId },
    requestPurpose: 'connected-accounts:purpose-binding',
    getAccountEncryptionMode: async (signal) => input.accountMode ?? await resolveConnectedServiceAccountMode(input.api, { signal }),
    signal: input.signal,
    readCredential: input.readCredential,
  });
  if (!material) return null;
  const { snapshot, credential } = material;
  const projection = projectQualifiedConnectedAccountCredentialPlaintextV1({
    ref: snapshot.ref,
    authenticationModeId: snapshot.authenticationModeId,
    payload: credential,
    metadata: snapshot.metadata,
    // Qualified revision, not projection wall-clock time, owns currentness.
    now: 0,
  });
  const projected = ConnectedServiceCredentialRecordV1Schema.safeParse(projection);
  // The historical writer's mode map is not native-adapter admission. OAuth
  // material acquired by device login or native import has the same native shape;
  // validate that shape below and retain the original qualified identity/mode.
  // This projection is in-process only, never persisted or sent as V2 content.
  const values = credential.values;
  const record = projected.success ? projected.data : ConnectedServiceCredentialRecordV1Schema.parse({
    v: 1,
    serviceId: input.binding.serviceId,
    profileId: snapshot.ref.accountId,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: values.expiresAtMs === undefined ? null : Number(values.expiresAtMs),
    kind: 'oauth',
    token: null,
    oauth: {
      accessToken: values.accessToken,
      refreshToken: values.refreshToken,
      idToken: values.idToken ?? null,
      tokenType: values.tokenType ?? null,
      scope: values.scopes ?? (snapshot.metadata.scopes?.join(' ') || null),
      providerAccountId: values.providerAccountId ?? snapshot.metadata.providerIdentity?.accountId ?? null,
      providerEmail: values.providerEmail ?? snapshot.metadata.providerIdentity?.email ?? null,
      raw: { happierQualifiedConnectedAccountCredentialV1: { v: 1, ref: snapshot.ref, authenticationModeId: snapshot.authenticationModeId, payload: credential } },
    },
  });
  return { record, providerOrganizationId: readQualifiedConnectedAccountCredentialIdentity(material).providerOrganizationId, storageMode: material.storageMode, revisionSemantics: 'revisioned', credentialRevision: snapshot.credentialRevision };
}
