import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { readSessionKeyBoundSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { decodeBase64 } from '@/encryption/base64';
import type { ScopedRpcSessionEncryptionContext } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { AES256Encryption } from './encryptor';

/**
 * Opens only the caller's standalone Session envelope, and only when the key opens the served
 * Session's strict layout-1 shared metadata: the Home names the key, so that is what proves it
 * is this Session's rather than another resource's. Account fallback material is never
 * transferable to another Account or a public link.
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
    let decryptedMetadata: unknown;
    try {
        [decryptedMetadata] = await new AES256Encryption(key).decrypt([decodeBase64(metadata, 'base64')]);
    } catch {
        return null;
    }
    return readSessionKeyBoundSharedMetadataV1({
        metadataLayoutVersion: params.session?.metadataLayoutVersion,
        decryptedMetadata,
    }) ? key : null;
}
