import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { createConnectedAccountAttemptTransactionAdapters } from '@happier-dev/cli-common/connectedAccounts';
import { StoredJsonContentEnvelopeSchema, isStoredJsonContentEnvelopeModeCompatible } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { createConnectedAccountAttemptTransactionApi, type ConnectedAccountAttemptTransactionStoreApi } from '@/api/client/connectedAccountAttemptTransactionApi';
import type { AccountEncryptionModeReadOptions, ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';
import { generatePkceCodes } from '@/cloud/pkce';
import type { StoredCredentials } from '@/persistence';
import { requireConnectedAccountCryptoMaterial, resolveConnectedAccountCryptoMaterial } from './accountScopedCryptoMaterial';

/** Native crypto and authenticated transport adapt the shared durable transaction owner. */
export function createQualifiedConnectedAccountAttemptTransactionAdapters(params: Readonly<{
  credentials: StoredCredentials;
  getAccountEncryptionMode: (options?: AccountEncryptionModeReadOptions) => Promise<ConnectedServiceAccountEncryptionMode>;
  getMachineId?: () => string | undefined;
  api?: ConnectedAccountAttemptTransactionStoreApi;
  randomBytes?: (length: number) => Uint8Array;
  now?: () => number;
}>) {
  const material = resolveConnectedAccountCryptoMaterial(params.credentials);
  const randomBytes = params.randomBytes ?? ((length: number) => new Uint8Array(nodeRandomBytes(length)));
  const resolveAccountMode = async (options?: AccountEncryptionModeReadOptions) => {
    const mode = await params.getAccountEncryptionMode(options);
    if (mode === 'unknown') throw new Error('Connected-account attempt transaction account encryption mode is unavailable');
    return mode;
  };
  return createConnectedAccountAttemptTransactionAdapters({
    ...params,
    api: params.api ?? createConnectedAccountAttemptTransactionApi({ token: params.credentials.token }),
    randomBytes,
    generatePkceCodes,
    async seal(payload) {
      const accountMode = await resolveAccountMode({ usage: 'fresh-authority' });
      return accountMode === 'plain'
        ? sealQualifiedConnectedAccountContentEnvelope({ kind: 'attempt', accountMode: 'plain', payload, randomBytes })
        : sealQualifiedConnectedAccountContentEnvelope({
          kind: 'attempt', accountMode: 'e2ee', payload, randomBytes,
          material: requireConnectedAccountCryptoMaterial(params.credentials, material),
        });
    },
    async open(record) {
      const accountMode = await resolveAccountMode();
      const envelope = createStoredReadSchema(StoredJsonContentEnvelopeSchema).parse(record.content);
      if (!isStoredJsonContentEnvelopeModeCompatible(accountMode, envelope)) {
        throw new Error('Connected-account attempt transaction content does not match the persisted Account encryption mode');
      }
      const opened = accountMode === 'plain'
        ? openQualifiedConnectedAccountContentEnvelope({ kind: 'attempt', accountMode: 'plain', envelope })
        : openQualifiedConnectedAccountContentEnvelope({
          kind: 'attempt', accountMode: 'e2ee', envelope,
          material: requireConnectedAccountCryptoMaterial(params.credentials, material),
        });
      if (opened === null) throw new Error('Connected-account attempt transaction content is unavailable for the current account mode');
      return opened;
    },
  });
}
