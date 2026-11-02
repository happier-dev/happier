import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { readSessionKeyBoundSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { decodeBase64 } from '@/encryption/base64';
import type { ScopedRpcSessionEncryptionContext } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { AES256Encryption } from './encryptor';

/**
 * Whether an opened key is the served Session's: it must open that Session's strict layout-1
 * shared metadata. The Home names the key, so this is what proves it is this Session's rather
 * than another resource's (Saved Secret, Workflow, Machine). Every app path that reseals a
 * Home-served Session key to someone else asks this first.
 */
export async function isSessionKeyBoundToServedMetadata(params: Readonly<{
    key: Uint8Array;
    /** The served Session's encrypted shared metadata and its layout. */
    metadata: unknown;
    metadataLayoutVersion: unknown;
}>): Promise<boolean> {
    if (typeof params.metadata !== 'string') return false;
    let decryptedMetadata: unknown;
    try {
        [decryptedMetadata] = await new AES256Encryption(params.key).decrypt([decodeBase64(params.metadata, 'base64')]);
    } catch {
        return false;
    }
    return readSessionKeyBoundSharedMetadataV1({
        metadataLayoutVersion: params.metadataLayoutVersion,
        decryptedMetadata,
    }) !== null;
}

/**
 * Opens only the caller's standalone Session envelope, and only when the key is bound to the
 * served Session's metadata. Account fallback material is never transferable to another Account
 * or a public link.
 */
export async function readTransferableSessionDataKey(params: Readonly<{
    /** The served Session row: the caller's key envelope, encrypted shared metadata and layout. */
    session: Readonly<{ dataEncryptionKey?: unknown; metadata?: unknown; metadataLayoutVersion?: unknown }> | null;
    encryption: Pick<ScopedRpcSessionEncryptionContext, 'decryptEncryptionKey'> | null;
}>): Promise<Uint8Array | null> {
    const envelope = params.session?.dataEncryptionKey;
    const metadata = params.session?.metadata;
    if (typeof envelope !== 'string' || !envelope || typeof metadata !== 'string' || !params.encryption) return null;
    const key = await params.encryption.decryptEncryptionKey(envelope);
    if (key?.byteLength !== ENCRYPTED_DATA_KEY_V1_BYTES) return null;
    return await isSessionKeyBoundToServedMetadata({
        key,
        metadata,
        metadataLayoutVersion: params.session?.metadataLayoutVersion,
    }) ? key : null;
}
