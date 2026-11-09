import { describe, expect, it } from 'vitest';
import { decodeBase64 } from '@/encryption/base64';
import { CRYPTO_GOLDEN_VECTORS } from '@happier-dev/protocol/crypto/cryptoGoldenVectors';
import * as webAes from '@/encryption/aes.web';
import { AES256Encryption } from './encryptor';
import { createFakeCryptoWorker } from './nativeCryptoWorker/fakeCryptoWorker';

describe('session data-key ciphertext compatibility', () => {
    it('opens the captured pre-extraction ciphertext through web, native string and native worker adapters', async () => {
        const key = Uint8Array.from({ length: 32 }, (_, index) => index);
        const fixture = CRYPTO_GOLDEN_VECTORS.sessionDataKeyBundleV0;
        const webReader = new AES256Encryption(key, {
            encryptString: webAes.encryptAESGCMString,
            decryptString: webAes.decryptAESGCMString,
        });
        // The package testkit substitutes the native OS cipher boundary, while
        // retaining the real native string adapter and worker batching path.
        const nativeReader = new AES256Encryption(key);
        const worker = createFakeCryptoWorker();
        const workerReader = new AES256Encryption(key, {
            nativeCryptoWorker: {
                getWorker: () => worker,
                getRouting: () => ({ mode: 'require', minPayloadBytes: 0 }),
                getScope: () => ({ accountId: 'account', serverId: 'server', generation: 1 }),
                isScopeCurrent: () => true,
            },
        });
        for (const reader of [webReader, nativeReader, workerReader]) {
            expect(await reader.decrypt([decodeBase64(fixture.ciphertextBase64)])).toEqual([fixture.value]);
            expect(await reader.decryptBase64!([fixture.ciphertextBase64])).toEqual([fixture.value]);
        }
    });
});
