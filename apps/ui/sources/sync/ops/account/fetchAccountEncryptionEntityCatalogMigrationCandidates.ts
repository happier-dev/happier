import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { CapturedAccountSettingsRequest } from '@/sync/api/account/accountSettingsRequest';
import { readRemoteHostCatalogRow } from '@/sync/api/account/apiRemoteHostCatalog';
import { readNotificationChannelCatalogRowInContext } from '@/sync/api/account/apiNotificationChannelCatalog';
import { apiReadConnectedPresentationRow, apiReadConnectedAcknowledgementsRow } from '@/sync/api/account/apiConnectedMetadataCatalog';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { openRemoteHostCatalogContentV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { openNotificationChannelCatalogContentV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { openConnectedPresentationContentV1, openConnectedAcknowledgementsContentV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import type { AccountEncryptionEntityCatalogMigrationCandidates } from './buildAccountEncryptionEntityCatalogDirectives';

/** Raw conversion reads borrow the initiating Home lifetime and never admit a source transfer. */
export async function fetchAccountEncryptionEntityCatalogMigrationCandidates(input: Readonly<{
  credentials: AuthCredentials;
  mode: 'plain' | 'e2ee';
  capturedRequest: Pick<CapturedAccountSettingsRequest, 'request' | 'isCurrent'>;
}>): Promise<AccountEncryptionEntityCatalogMigrationCandidates> {
  if (!input.capturedRequest.isCurrent()) throw new Error('Account catalog migration scope is retired');
  const material = input.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(input.credentials);
  const [remoteHosts, notificationChannels, connectedPresentation, connectedAcknowledgements] = await Promise.all([
    readRemoteHostCatalogRow(input.capturedRequest),
    readNotificationChannelCatalogRowInContext(input.capturedRequest),
    apiReadConnectedPresentationRow(input.capturedRequest),
    apiReadConnectedAcknowledgementsRow(input.capturedRequest),
  ]);
  if (!input.capturedRequest.isCurrent()) throw new Error('Account catalog migration scope is retired');
  if (remoteHosts.status !== 'present' && remoteHosts.status !== 'deleted' && remoteHosts.status !== 'absent') {
    throw new Error('Remote host migration census is unavailable');
  }
  if (notificationChannels.status !== 'present' && notificationChannels.status !== 'deleted' && notificationChannels.status !== 'absent') {
    throw new Error('Notification channel migration census is unavailable');
  }
  if (connectedPresentation.status !== 'present' && connectedPresentation.status !== 'deleted' && connectedPresentation.status !== 'absent') {
    throw new Error('Connected presentation migration census is unavailable');
  }
  if (connectedAcknowledgements.status !== 'present' && connectedAcknowledgements.status !== 'deleted' && connectedAcknowledgements.status !== 'absent') {
    throw new Error('Connected acknowledgement migration census is unavailable');
  }
  const source = { mode: input.mode, material };
  return {
    ...(remoteHosts.status === 'absent' ? {} : { remoteHosts: { revision: remoteHosts.revision,
      opened: remoteHosts.status === 'deleted' ? null : openRemoteHostCatalogContentV1({ ...source, content: remoteHosts.content }) } }),
    ...(notificationChannels.status === 'absent' ? {} : { notificationChannels: { revision: notificationChannels.revision,
      opened: notificationChannels.status === 'deleted' ? null : openNotificationChannelCatalogContentV1({ ...source, content: notificationChannels.content }) } }),
    ...(connectedPresentation.status === 'absent' ? {} : { connectedPresentation: { revision: connectedPresentation.revision,
      opened: connectedPresentation.status === 'deleted' ? null : openConnectedPresentationContentV1({ ...source, content: connectedPresentation.content }) } }),
    ...(connectedAcknowledgements.status === 'absent' ? {} : { connectedAcknowledgements: { revision: connectedAcknowledgements.revision,
      opened: connectedAcknowledgements.status === 'deleted' ? null : openConnectedAcknowledgementsContentV1({ ...source, content: connectedAcknowledgements.content }) } }),
  };
}
