import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import type { ScopedRpcSessionEncryptionContext } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

/**
 * Opens only the caller's standalone Session envelope. Account fallback material is
 * never transferable to another Account or a public link.
 */
export async function readTransferableSessionDataKey(params: Readonly<{
    callerDataKeyEnvelope: string | null;
    encryption: Pick<ScopedRpcSessionEncryptionContext, 'decryptEncryptionKey'> | null;
}>): Promise<Uint8Array | null> {
    if (!params.callerDataKeyEnvelope || !params.encryption) return null;
    const key = await params.encryption.decryptEncryptionKey(params.callerDataKeyEnvelope);
    return key?.byteLength === ENCRYPTED_DATA_KEY_V1_BYTES ? key : null;
}
