import { expect, it } from 'vitest';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { uploadInChunks } from './uploadInChunks';
import { createEncryptedTransferChunkEnvelope, createTransferRecipientKeyPair } from './node/transferChunkEncryption';

it('retains the native encryption preparation cause for the transfer caller', async () => {
    const payload = Buffer.from([0, 255, 42]);
    const upload = (recipientPublicKeyBase64: string) => uploadInChunks({ totalBytes: payload.length,
        init: async () => ({ success: true, uploadId: 'cause-probe', chunkSizeBytes: payload.length }),
        readBytes: async () => payload,
        prepareChunk: async ({ uploadId, index, bytes }) => createEncryptedTransferChunkEnvelope({
            transferId: uploadId, sequence: index, payload: Buffer.from(bytes), recipientPublicKeyBase64 }),
        // The network receiver boundary accepts the real encrypted chunk.
        sendChunk: async () => ({ success: true }), finalize: async () => ({ success: true }),
        abort: async () => ({ success: true }) });
    expect(await upload(createTransferRecipientKeyPair().recipientPublicKeyBase64)).toMatchObject({ success: true });
    const failed = await upload(Buffer.from([1]).toString('base64'));
    // Fails closed with fixed public prose; no key or cause text becomes an enumerable field.
    expect(failed).toEqual({ success: false, error: 'Upload chunk encryption failed' });
    expect(readActionOutputDiagnostic(failed)?.failureCause).toMatchObject({ errorClass: 'Error' });
});
