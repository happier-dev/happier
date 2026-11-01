import axios from 'axios';
import { readServerEnabledBit, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { encodeBase64 } from '@/api/encryption';
import { resolveMachineEncryptionContext } from '@/api/client/encryptionKey';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { getAccountEncryptionMode } from '@/api/connectedServices/connectedServiceCredentialApi';
import { fetchAccountMachine } from './fetchAccountMachine';
import { resolvePublishedMachineEncryptionContext, type MachineEncryptionContext } from './resolveMachineRpcEncryption';
import { decodeMachineStoredContent, encodeMachineStoredContent } from './machineStoredContent';

export type MachineRegistrationContent = Readonly<{
  context: MachineEncryptionContext;
  dataEncryptionKey: string | null;
  accountMode: 'plain' | 'e2ee' | 'unknown';
}>;

/** Published storage mode and key govern reads, even after account opt-out. */
export function resolvePublishedMachineContent(credentials: Credentials, publishedKey: unknown, accountMode: MachineRegistrationContent['accountMode']): MachineRegistrationContent {
  return { context: resolvePublishedMachineEncryptionContext(credentials, publishedKey, accountMode), accountMode,
    dataEncryptionKey: typeof publishedKey === 'string' ? publishedKey : null };
}

export async function resolveMachineRegistrationContent(params: Readonly<{
  credentials: Credentials; machineId: string; timeoutMs?: number;
}>): Promise<MachineRegistrationContent> {
  const serverBaseUrl = resolveServerHttpBaseUrl();
  const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: serverBaseUrl, timeoutMs: params.timeoutMs });
  const supportsPlain = snapshot.status === 'ready' && readServerEnabledBit(snapshot.features, 'encryption.plaintextMachine') === true;
  if (!supportsPlain) {
    const context = resolveMachineEncryptionContext(params.credentials);
    return { context, dataEncryptionKey: context.dataEncryptionKey ? encodeBase64(context.dataEncryptionKey) : null, accountMode: 'e2ee' };
  }
  const row = await fetchAccountMachine(params);
  const accountMode = await getAccountEncryptionMode({ token: params.credentials.token, timeoutMs: params.timeoutMs });
  if (accountMode === 'unknown') throw new Error('Cannot determine account encryption mode for machine registration');
  if (!row) {
    if (accountMode === 'plain') return { context: { encryptionKey: null, encryptionVariant: 'plain' }, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, accountMode };
    const context = resolveMachineEncryptionContext(params.credentials);
    return { context, dataEncryptionKey: context.dataEncryptionKey ? encodeBase64(context.dataEncryptionKey) : null, accountMode };
  }
  const published = resolvePublishedMachineContent(params.credentials, row.dataEncryptionKey, accountMode);
  if (accountMode !== 'plain' || published.context.encryptionVariant === 'plain') return published;
  if (!row.metadata || typeof row.metadataVersion !== 'number' || typeof row.daemonStateVersion !== 'number') {
    throw new Error('Machine transition requires a complete stored machine snapshot');
  }
  // Preserve the entire historical documents, including fields this CLI does not know.
  const metadata = decodeMachineStoredContent(published.context, row.metadata);
  const daemonState = row.daemonState == null ? null : decodeMachineStoredContent(published.context, row.daemonState);
  const plain = { encryptionKey: null, encryptionVariant: 'plain' } as const;
  const response = await axios.post(`${serverBaseUrl}/v1/machines/${encodeURIComponent(params.machineId)}/content-key/transition`, {
    machineId: params.machineId,
    expected: { dataEncryptionKey: row.dataEncryptionKey ?? null, metadataVersion: row.metadataVersion, daemonStateVersion: row.daemonStateVersion },
    next: { dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadata: encodeMachineStoredContent(plain, metadata),
      daemonState: daemonState === null ? null : encodeMachineStoredContent(plain, daemonState) },
  }, { headers: { Authorization: `Bearer ${params.credentials.token}` }, ...(params.timeoutMs ? { timeout: params.timeoutMs } : {}) });
  if (response.data?.kind !== 'committed') {
    throw Object.assign(new Error('Machine content transition could not commit; retry after refreshing the machine'), {
      code: response.data?.kind === 'conflict' ? 'MACHINE_CONTENT_TRANSITION_CONFLICT' : 'MACHINE_CONTENT_TRANSITION_REFUSED',
    });
  }
  return { context: plain, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, accountMode };
}
