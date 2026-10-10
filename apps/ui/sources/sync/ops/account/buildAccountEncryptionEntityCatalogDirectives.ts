import type { AccountEncryptionMigrateRequest } from '@happier-dev/protocol/account/encryptionMigrate';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openRemoteHostCatalogContentV1, sealRemoteHostCatalogContentV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { openNotificationChannelCatalogContentV1, sealNotificationChannelCatalogContentV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { openConnectedPresentationContentV1, openConnectedAcknowledgementsContentV1,
  sealConnectedPresentationContentV1, sealConnectedAcknowledgementsContentV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';

type Candidate<Opened> = Readonly<{ revision: number; opened: Opened | null }>;

/** Null denotes an admitted retained tombstone, never a failed or partial opening. */
export type AccountEncryptionEntityCatalogMigrationCandidates = Readonly<{
  remoteHosts?: Candidate<ReturnType<typeof openRemoteHostCatalogContentV1>>;
  notificationChannels?: Candidate<ReturnType<typeof openNotificationChannelCatalogContentV1>>;
  connectedPresentation?: Candidate<ReturnType<typeof openConnectedPresentationContentV1>>;
  connectedAcknowledgements?: Candidate<ReturnType<typeof openConnectedAcknowledgementsContentV1>>;
}>;

type Target = Readonly<{ mode: 'plain' }> | Readonly<{
  mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array;
}>;
type Directives = Pick<AccountEncryptionMigrateRequest,
  'remoteHosts' | 'notificationChannels' | 'connectedPresentation' | 'connectedAcknowledgements'>;

export function buildAccountEncryptionEntityCatalogDirectives(
  candidates: AccountEncryptionEntityCatalogMigrationCandidates,
  target: Target,
): Directives {
  const sealTarget = { mode: target.mode, material: target.mode === 'plain' ? null : target.material,
    ...(target.mode === 'e2ee' ? { randomBytes: target.randomBytes } : {}) };
  const directives: Directives = {};
  if (candidates.remoteHosts) {
    const { revision, opened } = candidates.remoteHosts;
    if (opened !== null && opened.status !== 'ready') throw new Error('Remote host migration census is incomplete');
    directives.remoteHosts = { expectedRevision: revision, content: opened === null ? null
      : sealRemoteHostCatalogContentV1({ ...sealTarget, record: { v: 1, hosts: [...opened.hosts] } }) };
  }
  if (candidates.notificationChannels) {
    const { revision, opened } = candidates.notificationChannels;
    if (opened !== null && opened.status !== 'opened') throw new Error('Notification channel migration census is incomplete');
    directives.notificationChannels = { expectedRevision: revision, content: opened === null ? null
      : sealNotificationChannelCatalogContentV1({ ...sealTarget, record: opened.record }) };
  }
  if (candidates.connectedPresentation) {
    const { revision, opened } = candidates.connectedPresentation;
    if (opened !== null && opened.status !== 'opened') throw new Error('Connected presentation migration census is incomplete');
    directives.connectedPresentation = { expectedRevision: revision, content: opened === null ? null
      : sealConnectedPresentationContentV1({ ...sealTarget, record: opened.record }) };
  }
  if (candidates.connectedAcknowledgements) {
    const { revision, opened } = candidates.connectedAcknowledgements;
    if (opened !== null && opened.status !== 'opened') throw new Error('Connected acknowledgement migration census is incomplete');
    directives.connectedAcknowledgements = { expectedRevision: revision, content: opened === null ? null
      : sealConnectedAcknowledgementsContentV1({ ...sealTarget, record: opened.record }) };
  }
  return directives;
}
