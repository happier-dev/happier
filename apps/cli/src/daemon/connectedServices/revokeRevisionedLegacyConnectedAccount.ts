import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  type BuiltInLegacyConnectedServiceId,
  type ConnectedAccountPeerOperationTransport,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import type {
  ConnectedServiceCredentialApi,
} from '@/api/client/connectedServiceCredentialApi';
import {
  QualifiedConnectedAccountCompatibilityError,
} from '@/api/client/qualifiedConnectedAccountApi';

function sameService(
  left: QualifiedConnectedAccountRef['service'],
  right: QualifiedConnectedAccountRef['service'],
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function assertRevisionedLegacyTransport(
  transport: ConnectedAccountPeerOperationTransport,
  serviceId: BuiltInLegacyConnectedServiceId,
): void {
  if (
    transport.kind !== 'legacy'
    || transport.peerClass !== 'revisioned_v2_v3'
    || transport.serviceId !== serviceId
  ) {
    throw new QualifiedConnectedAccountCompatibilityError(
      'connected_account_legacy_operation_unsupported',
    );
  }
}

export async function revokeRevisionedLegacyConnectedAccount(input: Readonly<{
  account: QualifiedConnectedAccountRef;
  serviceId: BuiltInLegacyConnectedServiceId;
  cleanupGroupReferences: boolean;
  api: Pick<
    ConnectedServiceCredentialApi,
    | 'getAccountEncryptionMode'
    | 'getConnectedServiceCredentialPlain'
    | 'getConnectedServiceCredentialSealed'
    | 'deleteConnectedServiceCredentialRevisioned'
  >;
  resolvePeerOperationTransport(): ConnectedAccountPeerOperationTransport;
}>): Promise<Readonly<{
  status: 'deleted';
  remoteStatus: 'remoteUnsupported';
}>> {
  const compatibility =
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
      input.serviceId
    ];
  if (!sameService(compatibility.service, input.account.service)) {
    throw new QualifiedConnectedAccountCompatibilityError(
      'connected_account_legacy_operation_unsupported',
    );
  }
  const storageMode = await input.api.getAccountEncryptionMode({
    refresh: true,
  });
  if (storageMode === 'unknown') {
    throw new QualifiedConnectedAccountCompatibilityError(
      'connected_account_capability_indeterminate',
    );
  }
  assertRevisionedLegacyTransport(
    input.resolvePeerOperationTransport(),
    input.serviceId,
  );
  const snapshot = storageMode === 'plain'
    ? await input.api.getConnectedServiceCredentialPlain({
        serviceId: input.serviceId,
        profileId: input.account.accountId,
      })
    : await input.api.getConnectedServiceCredentialSealed({
        serviceId: input.serviceId,
        profileId: input.account.accountId,
      });
  assertRevisionedLegacyTransport(
    input.resolvePeerOperationTransport(),
    input.serviceId,
  );
  if (!snapshot) {
    return Object.freeze({
      status: 'deleted' as const,
      remoteStatus: 'remoteUnsupported' as const,
    });
  }
  if (
    snapshot.revisionSemantics !== 'revisioned'
    || !snapshot.credentialRevision
  ) {
    throw new QualifiedConnectedAccountCompatibilityError(
      'connected_account_legacy_operation_unsupported',
    );
  }
  await input.api.deleteConnectedServiceCredentialRevisioned({
    storageMode,
    serviceId: input.serviceId,
    profileId: input.account.accountId,
    expectedCredentialRevision: snapshot.credentialRevision,
    cleanupGroupReferences: input.cleanupGroupReferences,
  });
  return Object.freeze({
    status: 'deleted' as const,
    remoteStatus: 'remoteUnsupported' as const,
  });
}
