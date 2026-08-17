import { beforeEach, describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';

import { Encryption } from './encryption';
import { createFakeCryptoWorker } from './nativeCryptoWorker/fakeCryptoWorker';
import { resetNativeCryptoWorkerCapabilityCacheForTests } from './nativeCryptoWorker/nativeCryptoWorkerRouting';
import { resetNativeCryptoWorkerQueueLifecycleForTests } from './nativeCryptoWorker/nativeCryptoWorkerQueue';
import { resetDefaultNativeCryptoWorkerRoutingForTests } from './nativeCryptoWorker/nativeCryptoWorkerRoutingConfig';
import type {
    CryptoWorkerBatchRequest,
    NativeCryptoWorker,
    NativeCryptoWorkerDataKeyEnvelopeItem,
} from './nativeCryptoWorker/types';

type RecordedBatch = Readonly<{
    accountId: string;
    serverId: string | null;
    items: readonly NativeCryptoWorkerDataKeyEnvelopeItem[];
}>;

/**
 * Wraps the canonical fake worker so the real per-item decrypt still runs while the
 * batches that actually crossed the (fake) bridge are observable.
 */
function createRecordingCryptoWorker(): { worker: NativeCryptoWorker; batches: RecordedBatch[] } {
    const inner = createFakeCryptoWorker();
    const batches: RecordedBatch[] = [];
    return {
        batches,
        worker: {
            probe: () => inner.probe(),
            decryptDataKeyEnvelopeV1: (request: CryptoWorkerBatchRequest<NativeCryptoWorkerDataKeyEnvelopeItem>) => {
                batches.push({
                    accountId: request.scope.accountId,
                    serverId: request.scope.serverId,
                    items: request.items,
                });
                return inner.decryptDataKeyEnvelopeV1(request);
            },
            decryptSecretboxJson: (request) => inner.decryptSecretboxJson(request),
            decryptAesGcmJson: (request) => inner.decryptAesGcmJson(request),
        },
    };
}

async function sealDataKeys(encryption: Encryption, dataKeys: readonly Uint8Array[]): Promise<string[]> {
    const envelopes: string[] = [];
    for (const dataKey of dataKeys) {
        envelopes.push(encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64'));
    }
    return envelopes;
}

describe('Encryption native crypto worker routing default', () => {
    beforeEach(() => {
        resetDefaultNativeCryptoWorkerRoutingForTests();
        resetNativeCryptoWorkerCapabilityCacheForTests();
        resetNativeCryptoWorkerQueueLifecycleForTests();
    });

    it('routes a batch through the worker on an instance nobody configured routing on', async () => {
        // This is exactly the state every scoped/concurrent-server Encryption is in:
        // constructed outside sync.ts#configureEncryptionRuntime and therefore never
        // handed a routing. Only the worker is injected here — the routing must come
        // from construction.
        const encryption = await Encryption.create(new Uint8Array(32).fill(11));
        const { worker, batches } = createRecordingCryptoWorker();
        encryption.configureNativeCryptoWorker({ worker });

        const dataKeys = [
            new Uint8Array(32).fill(21),
            new Uint8Array(32).fill(22),
            new Uint8Array(32).fill(23),
        ];
        const envelopes = await sealDataKeys(encryption, dataKeys);

        const decrypted = await encryption.decryptEncryptionKeys(envelopes);

        expect(decrypted).toEqual(dataKeys);
        expect(batches).toHaveLength(1);
        expect(batches[0]!.items).toHaveLength(3);
    });

    it('keeps a single data-key envelope on the JS thread: one open is cheaper than one bridge crossing', async () => {
        // A v1 envelope is 105 bytes (1 version + 32 ephemeral pk + 24 nonce + 32 key
        // + 16 mac) and the recipient secret is 32 bytes, so a one-item batch estimates
        // to 505 bridge bytes — under the 512-byte minPayloadBytes floor. The default
        // must not drag a lone scalar multiplication across the bridge.
        const encryption = await Encryption.create(new Uint8Array(32).fill(12));
        const { worker, batches } = createRecordingCryptoWorker();
        encryption.configureNativeCryptoWorker({ worker });

        const dataKey = new Uint8Array(32).fill(24);
        const envelopes = await sealDataKeys(encryption, [dataKey]);

        expect(await encryption.decryptEncryptionKeys(envelopes)).toEqual([dataKey]);
        expect(batches).toHaveLength(0);
    });

    it('never merges two instances into one batch, so account A key material cannot reach account B', async () => {
        // The cross-account fence is structural: each Encryption owns its own worker
        // object, and the queue registry is keyed by that object. Two accounts running
        // concurrently must therefore produce two disjoint batches, each carrying only
        // its own recipient secret.
        const accountA = await Encryption.create(new Uint8Array(32).fill(41));
        const accountB = await Encryption.create(new Uint8Array(32).fill(42));
        const recorderA = createRecordingCryptoWorker();
        const recorderB = createRecordingCryptoWorker();
        accountA.configureNativeCryptoWorker({
            worker: recorderA.worker,
            scope: { accountId: 'account-a', serverId: 'server-a', generation: 0 },
        });
        accountB.configureNativeCryptoWorker({
            worker: recorderB.worker,
            scope: { accountId: 'account-b', serverId: 'server-b', generation: 0 },
        });

        const keysA = [new Uint8Array(32).fill(51), new Uint8Array(32).fill(52)];
        const keysB = [new Uint8Array(32).fill(61), new Uint8Array(32).fill(62)];
        const envelopesA = await sealDataKeys(accountA, keysA);
        const envelopesB = await sealDataKeys(accountB, keysB);

        const [decryptedA, decryptedB] = await Promise.all([
            accountA.decryptEncryptionKeys(envelopesA),
            accountB.decryptEncryptionKeys(envelopesB),
        ]);

        expect(decryptedA).toEqual(keysA);
        expect(decryptedB).toEqual(keysB);

        const secretA = encodeBase64(accountA.getContentPrivateKey(), 'base64');
        const secretB = encodeBase64(accountB.getContentPrivateKey(), 'base64');
        expect(secretA).not.toEqual(secretB);

        expect(recorderA.batches).toHaveLength(1);
        expect(recorderB.batches).toHaveLength(1);
        expect(recorderA.batches[0]!.accountId).toBe('account-a');
        expect(recorderB.batches[0]!.accountId).toBe('account-b');
        // No item of A's batch carries B's secret, and neither batch carries the other's
        // ciphertext: a merged queue would show up here as a 4-item batch or a mixed key.
        expect(recorderA.batches[0]!.items.map((item) => item.recipientSecretKeyOrSeedBase64))
            .toEqual([secretA, secretA]);
        expect(recorderB.batches[0]!.items.map((item) => item.recipientSecretKeyOrSeedBase64))
            .toEqual([secretB, secretB]);
        expect(recorderA.batches[0]!.items.map((item) => item.envelopeBase64)).toEqual(envelopesA);
        expect(recorderB.batches[0]!.items.map((item) => item.envelopeBase64)).toEqual(envelopesB);
    });

    it('lets an explicit routing configuration still win over the construction default', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(13));
        const { worker, batches } = createRecordingCryptoWorker();
        encryption.configureNativeCryptoWorker({ worker, routing: { mode: 'off' } });

        const dataKeys = [new Uint8Array(32).fill(31), new Uint8Array(32).fill(32)];
        const envelopes = await sealDataKeys(encryption, dataKeys);

        expect(await encryption.decryptEncryptionKeys(envelopes)).toEqual(dataKeys);
        expect(batches).toHaveLength(0);
    });
});
