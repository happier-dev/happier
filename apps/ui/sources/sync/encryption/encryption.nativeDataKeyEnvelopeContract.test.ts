import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as envelopes from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';

import { encodeBase64 } from '@/encryption/base64';

import { Encryption } from './encryption';
import { DataKeyOpeningCancelledError } from './dataKeyOpenings';
import { createFakeCryptoWorker } from './nativeCryptoWorker/fakeCryptoWorker';
import { resetNativeCryptoWorkerCapabilityCacheForTests } from './nativeCryptoWorker/nativeCryptoWorkerRouting';
import { resetNativeCryptoWorkerQueueLifecycleForTests } from './nativeCryptoWorker/nativeCryptoWorkerQueue';
import { resetDefaultNativeCryptoWorkerRoutingForTests } from './nativeCryptoWorker/nativeCryptoWorkerRoutingConfig';
import type {
    CryptoWorkerBatchRequest,
    NativeCryptoWorker,
    NativeCryptoWorkerDataKeyEnvelopeItem,
} from './nativeCryptoWorker/types';

/**
 * Wraps the canonical fake worker and replaces one opened item with a
 * cryptographically plausible but wrong-sized result, which is what a broken or
 * outdated native module would hand back across the bridge.
 */
function createWrongSizedResultWorker(replacements: ReadonlyMap<number, Uint8Array>): NativeCryptoWorker {
    const inner = createFakeCryptoWorker();
    return {
        probe: () => inner.probe(),
        decryptDataKeyEnvelopeV1: async (request: CryptoWorkerBatchRequest<NativeCryptoWorkerDataKeyEnvelopeItem>) => {
            const result = await inner.decryptDataKeyEnvelopeV1(request);
            if (result.status !== 'ok') return result;
            return {
                ...result,
                items: result.items.map((item, index) => {
                    const replacement = replacements.get(index);
                    return replacement ? encodeBase64(replacement, 'base64') : item;
                }),
            };
        },
        decryptSecretboxJson: (request) => inner.decryptSecretboxJson(request),
        decryptAesGcmJson: (request) => inner.decryptAesGcmJson(request),
    };
}

async function sealDataKeys(encryption: Encryption, dataKeys: readonly Uint8Array[]): Promise<string[]> {
    const envelopes: string[] = [];
    for (const dataKey of dataKeys) {
        envelopes.push(encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64'));
    }
    return envelopes;
}

describe('Encryption fixed data-key envelope contract', () => {
    it('opens identical ciphertext once across sequential consumers and isolates returned keys and cancellation', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const dataKey = new Uint8Array(32).fill(29);
        const [envelope] = await sealDataKeys(encryption, [dataKey]);
        const open = vi.spyOn(envelopes, 'openEncryptedDataKeyEnvelopeV1');
        try {
            const first = await encryption.decryptEncryptionKeys([envelope!, envelope!]);
            expect(first).toEqual([dataKey, dataKey]);
            first[0]!.fill(0);
            const signal = new AbortController();
            expect(await encryption.decryptEncryptionKeys([envelope!], { signal: signal.signal })).toEqual([dataKey]);
            expect(await encryption.decryptEncryptionKeys([envelope!])).toEqual([dataKey]);
            expect(open).toHaveBeenCalledTimes(1);
            signal.abort();
            // A stopped opening is cancellation, never a refusal (null).
            await expect(encryption.decryptEncryptionKeys([envelope!], { signal: signal.signal })).rejects.toBeInstanceOf(DataKeyOpeningCancelledError);
            await expect(encryption.decryptEncryptionKeys([envelope!], { shouldContinue: () => false })).rejects.toBeInstanceOf(DataKeyOpeningCancelledError);
            const other = await Encryption.create(new Uint8Array(32).fill(18));
            other.configureNativeCryptoWorker({ routing: { mode: 'off' } });
            expect(await other.decryptEncryptionKeys([envelope!])).toEqual([null]);
            expect(await encryption.decryptEncryptionKeys([envelope!], { serverId: 'another-home' })).toEqual([dataKey]);
            expect(open).toHaveBeenCalledTimes(3);
        } finally { open.mockRestore(); }
    });
    beforeEach(() => {
        resetDefaultNativeCryptoWorkerRoutingForTests();
        resetNativeCryptoWorkerCapabilityCacheForTests();
        resetNativeCryptoWorkerQueueLifecycleForTests();
    });

    it('reuses signal-owned successful opens but retires them on generation and recipient changes', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(19));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const dataKey = new Uint8Array(32).fill(30);
        const [envelope] = await sealDataKeys(encryption, [dataKey]);
        const open = vi.spyOn(envelopes, 'openEncryptedDataKeyEnvelopeV1');
        const signal = new AbortController().signal;
        try {
            expect(await encryption.decryptEncryptionKeys([envelope!, envelope!], { signal })).toEqual([dataKey, dataKey]);
            expect(await encryption.decryptEncryptionKeys([envelope!], { signal })).toEqual([dataKey]);
            expect(open).toHaveBeenCalledTimes(1);
            encryption.configureNativeCryptoWorker({ scope: { accountId: 'local', serverId: null, generation: 1 } });
            expect(await encryption.decryptEncryptionKeys([envelope!])).toEqual([dataKey]);
            expect(open).toHaveBeenCalledTimes(2);
            const privateKey = encryption.getContentPrivateKey();
            const original = privateKey.slice();
            privateKey.fill(0);
            expect(await encryption.decryptEncryptionKeys([envelope!])).toEqual([null]);
            privateKey.set(original);
            expect(await encryption.decryptEncryptionKeys([envelope!])).toEqual([dataKey]);
            expect(open).toHaveBeenCalledTimes(4);
        } finally { open.mockRestore(); }
    });

    it('rejects a native result that is not exactly one data key without losing the valid items', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(11));
        encryption.configureNativeCryptoWorker({
            worker: createWrongSizedResultWorker(new Map([
                [0, new Uint8Array(31).fill(5)],
                [2, new Uint8Array(33).fill(6)],
            ])),
        });

        const dataKeys = [
            new Uint8Array(32).fill(21),
            new Uint8Array(32).fill(22),
            new Uint8Array(32).fill(23),
        ];
        const envelopes = await sealDataKeys(encryption, dataKeys);

        expect(await encryption.decryptEncryptionKeys(envelopes)).toEqual([null, dataKeys[1], null]);
    });

    it('refuses to seal an envelope around a key that is not exactly 32 bytes', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(12));

        await expect(encryption.encryptEncryptionKey(new Uint8Array(31).fill(7))).rejects.toThrow(/data key length/i);
        await expect(encryption.encryptEncryptionKey(new Uint8Array(33).fill(8))).rejects.toThrow(/data key length/i);
    });
});
