import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  decodePlainMachineStoredContent,
  encodePlainMachineStoredContent,
  isPlainMachineDataKeyMarker,
  type AccountEncryptionMigrateMachinesDirective,
} from '@happier-dev/protocol';
import { EncryptionMaterialUnavailableError, type Encryption } from '@/sync/encryption/encryption';
import { MachineEncryption } from '@/sync/encryption/machineEncryption';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';

export type AccountEncryptionMachineMigrationCandidate = Readonly<{
  id: string;
  metadata: string;
  metadataVersion: number;
  daemonState: string | null;
  daemonStateVersion: number;
  dataEncryptionKey: string | null;
}>;

/** Decodes complete stored documents; display projections must never become migration input. */
export async function buildAccountEncryptionMachinesDirective(params: Readonly<{
  candidates: readonly AccountEncryptionMachineMigrationCandidate[];
  sourceEncryption: Encryption;
  target: Readonly<{ mode: 'plain' }> | Readonly<{ mode: 'e2ee'; encryption: Encryption }>;
}>): Promise<AccountEncryptionMigrateMachinesDirective> {
  const encryptedKeyRows = params.candidates.filter((row) => row.dataEncryptionKey !== null && !isPlainMachineDataKeyMarker(row.dataEncryptionKey));
  const openedKeys = encryptedKeyRows.length === 0 ? [] : await params.sourceEncryption.decryptEncryptionKeys(
    encryptedKeyRows.map((row) => row.dataEncryptionKey!),
  );
  const keysByMachineId = new Map(encryptedKeyRows.map((row, index) => [row.id, openedKeys[index] ?? null]));
  const items: Extract<AccountEncryptionMigrateMachinesDirective, { action: 'migrate' }>['items'] = [];
  for (const row of params.candidates) {
    let metadata: unknown;
    let daemonState: unknown = null;
    if (isPlainMachineDataKeyMarker(row.dataEncryptionKey)) {
      metadata = decodePlainMachineStoredContent(row.metadata);
      if (row.daemonState !== null) daemonState = decodePlainMachineStoredContent(row.daemonState);
    } else {
      const key = row.dataEncryptionKey === null ? null : keysByMachineId.get(row.id) ?? null;
      if (row.dataEncryptionKey !== null && !key) throw new EncryptionMaterialUnavailableError();
      if (!key && !params.sourceEncryption.hasEncryptionMaterial()) throw new EncryptionMaterialUnavailableError();
      const codec = new MachineEncryption(row.id, await params.sourceEncryption.openEncryption(key), new EncryptionCache());
      metadata = await codec.decryptRaw(row.metadata);
      if (row.daemonState !== null) daemonState = await codec.decryptRaw(row.daemonState);
      if (metadata === null || (row.daemonState !== null && daemonState === null)) {
        throw new EncryptionMaterialUnavailableError();
      }
    }
    let next: Extract<AccountEncryptionMigrateMachinesDirective, { action: 'migrate' }>['items'][number]['next'];
    if (params.target.mode === 'plain') {
      next = {
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: encodePlainMachineStoredContent(metadata),
        daemonState: row.daemonState === null ? null : encodePlainMachineStoredContent(daemonState),
      };
    } else {
      const key = getRandomBytes(32);
      const targetCodec = new MachineEncryption(row.id, await params.target.encryption.openEncryption(key), new EncryptionCache());
      next = {
        dataEncryptionKey: encodeBase64(await params.target.encryption.encryptEncryptionKey(key)),
        metadata: await targetCodec.encryptRaw(metadata),
        daemonState: row.daemonState === null ? null : await targetCodec.encryptRaw(daemonState),
      };
    }
    items.push({ machineId: row.id, expected: {
      dataEncryptionKey: row.dataEncryptionKey,
      metadataVersion: row.metadataVersion,
      daemonStateVersion: row.daemonStateVersion,
    }, next });
  }
  return { action: 'migrate', items };
}
