import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';

import type { Credentials, StoredCredentials } from '@/persistence';
import { decodeBase64, encodeBase64, getRandomBytes, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { deriveKey } from '@/utils/deriveKey';

export type ResourceDataKey =
  | Readonly<{ mode: 'plain'; dataKey: null; dataEncryptionKey: null }>
  | Readonly<{ mode: 'e2ee'; dataKey: Uint8Array; dataEncryptionKey: string }>;

export class ResourceDataKeyUnavailableError extends Error {
  readonly code = 'resource_encryption_material_unavailable';
  constructor() {
    super('Resource encryption material is unavailable');
    this.name = 'ResourceDataKeyUnavailableError';
  }
}

function requireEncryption(credentials: ContentEncryption): Pick<Credentials, 'encryption'> {
  if (!credentials.encryption) throw new ResourceDataKeyUnavailableError();
  return { encryption: credentials.encryption };
}

async function recipientSecret(credentials: Pick<Credentials, 'encryption'>): Promise<Uint8Array> {
  return credentials.encryption.type === 'dataKey'
    ? credentials.encryption.machineKey
    : deriveKey(credentials.encryption.secret, 'Happy EnCoder', ['content']);
}

/** A new resource owns a fresh DEK; plain resources require no Account key. */
export async function createResourceDataKey(params: Readonly<{
  credentials: ContentEncryption;
  mode: 'plain' | 'e2ee';
  expectedContentPublicKeyFingerprint?: string;
}>): Promise<ResourceDataKey> {
  if (params.mode === 'plain') return { mode: 'plain', dataKey: null, dataEncryptionKey: null };
  const credentials = requireEncryption(params.credentials);
  const publicKey = credentials.encryption.type === 'dataKey'
    ? credentials.encryption.publicKey
    : libsodiumPublicKeyFromSecretKey(await recipientSecret(credentials));
  if (params.expectedContentPublicKeyFingerprint !== undefined
    && computeContentPublicKeyFingerprint(publicKey) !== params.expectedContentPublicKeyFingerprint) {
    throw new ResourceDataKeyUnavailableError();
  }
  const dataKey = getRandomBytes(32);
  return { mode: 'e2ee', dataKey,
    dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey, recipientPublicKey: publicKey, randomBytes: getRandomBytes,
    }), 'base64') };
}

/** Open only the exact recipient envelope supplied by the admitted resource. */
export async function openResourceDataKey(params: Readonly<{
  credentials: ContentEncryption;
  mode: 'plain' | 'e2ee';
  dataEncryptionKey: string | null;
}>): Promise<ResourceDataKey> {
  if (params.mode === 'plain') {
    if (params.dataEncryptionKey !== null) throw new ResourceDataKeyUnavailableError();
    return { mode: 'plain', dataKey: null, dataEncryptionKey: null };
  }
  if (!params.dataEncryptionKey) throw new ResourceDataKeyUnavailableError();
  const credentials = requireEncryption(params.credentials);
  const dataKey = openEncryptedDataKeyEnvelopeV1({
    envelope: decodeBase64(params.dataEncryptionKey),
    recipientSecretKeyOrSeed: await recipientSecret(credentials),
  });
  if (!dataKey) throw new ResourceDataKeyUnavailableError();
  return { mode: 'e2ee', dataKey, dataEncryptionKey: params.dataEncryptionKey };
}

type ContentEncryption = Pick<StoredCredentials, 'encryption'>;
