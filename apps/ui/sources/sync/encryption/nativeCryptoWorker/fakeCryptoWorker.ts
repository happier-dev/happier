import { encodeBase64 } from '@/encryption/base64';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

import { AES256Encryption, SecretBoxEncryption } from '../encryptor';
import {
    cryptoWorkerBase64ToBytes,
} from './nativeCryptoWorkerBridgePayload';
import {
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    type CryptoWorkerBatchRequest,
    type NativeCryptoWorker,
    type NativeCryptoWorkerAesGcmJsonItem,
    type NativeCryptoWorkerBatchResult,
    type NativeCryptoWorkerDataKeyEnvelopeItem,
    type NativeCryptoWorkerSecretboxJsonItem,
} from './types';

function cancelled<T>(request: CryptoWorkerBatchRequest<unknown>): NativeCryptoWorkerBatchResult<T> | null {
    return request.signal?.aborted === true
        ? { status: 'cancelled', source: 'cancelled', items: [] }
        : null;
}

export function createFakeCryptoWorker(): NativeCryptoWorker {
    return {
        async probe() {
            return {
                available: true,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                nativeVersion: 0,
                supportedOperations: [
                    NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
                    NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson,
                    NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson,
                ],
            };
        },

        async decryptDataKeyEnvelopeV1(request: CryptoWorkerBatchRequest<NativeCryptoWorkerDataKeyEnvelopeItem>) {
            const cancelledResult = cancelled<string | null>(request);
            if (cancelledResult) return cancelledResult;

            return {
                status: 'ok',
                source: 'reference',
                items: request.items.map((item) => {
                    const envelope = cryptoWorkerBase64ToBytes(item.envelopeBase64);
                    const recipientSecretKeyOrSeed = cryptoWorkerBase64ToBytes(item.recipientSecretKeyOrSeedBase64);
                    if (!envelope || !recipientSecretKeyOrSeed) return null;
                    const opened = openEncryptedDataKeyEnvelopeV1({
                        envelope,
                        recipientSecretKeyOrSeed,
                    });
                    return opened ? encodeBase64(opened, 'base64') : null;
                }),
            };
        },

        async decryptSecretboxJson(request: CryptoWorkerBatchRequest<NativeCryptoWorkerSecretboxJsonItem>) {
            const cancelledResult = cancelled<unknown | null>(request);
            if (cancelledResult) return cancelledResult;

            const items: Array<unknown | null> = [];
            for (const item of request.items) {
                const ciphertext = cryptoWorkerBase64ToBytes(item.ciphertextBase64);
                const key = cryptoWorkerBase64ToBytes(item.keyBase64);
                if (!ciphertext || !key) {
                    items.push(null);
                    continue;
                }
                const decrypted = await new SecretBoxEncryption(key).decrypt([ciphertext]);
                items.push(decrypted[0]);
            }
            return { status: 'ok', source: 'reference', items };
        },

        async decryptAesGcmJson(request: CryptoWorkerBatchRequest<NativeCryptoWorkerAesGcmJsonItem>) {
            const cancelledResult = cancelled<unknown | null>(request);
            if (cancelledResult) return cancelledResult;

            const items: Array<unknown | null> = [];
            for (const item of request.items) {
                const encryptedPayload = cryptoWorkerBase64ToBytes(item.encryptedPayloadBase64);
                const key = cryptoWorkerBase64ToBytes(item.keyBase64);
                if (!encryptedPayload || !key) {
                    items.push(null);
                    continue;
                }
                const decrypted = await new AES256Encryption(key).decrypt([encryptedPayload]);
                items.push(decrypted[0]);
            }
            return { status: 'ok', source: 'reference', items };
        },
    };
}
