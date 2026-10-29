import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import { encodeBase64 } from '@/encryption/base64';
import { createDeferred } from '@/dev/testkit';

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
    it('joins signal-owned interactive openings and lets one borrower cancel without retiring its peer', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(81));
        const { worker, batches } = createRecordingCryptoWorker();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        encryption.configureNativeCryptoWorker({ worker: { ...worker,
            decryptDataKeyEnvelopeV1: async request => {
                entered.resolve();
                await release.promise;
                return worker.decryptDataKeyEnvelopeV1(request);
            },
        }, routing: { mode: 'require', minPayloadBytes: 0 } });
        const key = new Uint8Array(32).fill(82);
        const [envelope] = await sealDataKeys(encryption, [key]);
        const first = new AbortController(), second = new AbortController();
        const abandoned = encryption.decryptEncryptionKey(envelope!, { signal: first.signal, workClass: 'interactive' });
        await entered.promise;
        const survivor = encryption.decryptEncryptionKey(envelope!, { signal: second.signal, workClass: 'interactive' });
        try {
            first.abort();
            expect(await abandoned).toBeNull();
            release.resolve();
            expect((await survivor)?.every((byte, index) => byte === key[index])).toBe(true);
            expect(batches.flatMap(batch => batch.items)).toHaveLength(1);
        } finally {
            release.resolve(); first.abort(); second.abort();
            await Promise.allSettled([abandoned, survivor]);
            encryption.retireAccountMaterial();
        }
    });
    beforeEach(() => {
        resetDefaultNativeCryptoWorkerRoutingForTests();
        resetNativeCryptoWorkerCapabilityCacheForTests();
        resetNativeCryptoWorkerQueueLifecycleForTests();
    });

    it('keeps later callers live after the first shared-owner dispatch is cancelled', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(54));
        const { worker, batches } = createRecordingCryptoWorker();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let firstDispatch = true;
        encryption.configureNativeCryptoWorker({ worker: { ...worker,
            decryptDataKeyEnvelopeV1: async request => {
                const result = await worker.decryptDataKeyEnvelopeV1(request);
                if (firstDispatch) { firstDispatch = false; entered.resolve(); await release.promise; }
                return result;
            },
        }, routing: { mode: 'auto', minBatchSize: 1, minPayloadBytes: 0, telemetryEnabled: true } });
        const keys = [new Uint8Array(32).fill(61), new Uint8Array(32).fill(62), new Uint8Array(32).fill(63)];
        const envelopes = await sealDataKeys(encryption, keys);
        const first = new AbortController(), next = new AbortController();
        syncPerformanceTelemetry.configure({ enabled: true });
        syncPerformanceTelemetry.reset();
        const abandoned = encryption.decryptEncryptionKey(envelopes[0]!, { signal: first.signal, workClass: 'interactive' });
        const pending: Array<Promise<Uint8Array | null>> = [abandoned];
        try {
            await entered.promise;
            const second = encryption.decryptEncryptionKey(envelopes[1]!, { signal: next.signal, workClass: 'interactive' });
            const third = encryption.decryptEncryptionKey(envelopes[2]!, { signal: next.signal, workClass: 'interactive' });
            pending.push(second, third);
            await vi.waitFor(() => expect(syncPerformanceTelemetry.snapshot().events.find(event =>
                event.name === 'sync.crypto.worker.queueDepth')?.fieldStats?.queueDepth?.max).toBe(2));
            first.abort();
            expect(await abandoned).toBeNull();
            release.resolve();
            expect(await Promise.all([second, third])).toEqual(keys.slice(1));
            expect(batches.flatMap(batch => batch.items)).toHaveLength(3);
        } finally {
            release.resolve();
            first.abort(); next.abort();
            await Promise.allSettled(pending);
            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        }
    });

    it('cancels physical key work only after its final joined reader leaves and permits a fresh attempt', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(83));
        const { worker, batches } = createRecordingCryptoWorker();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let physicalSignal: AbortSignal | undefined;
        let hold = true;
        encryption.configureNativeCryptoWorker({ worker: { ...worker,
            decryptDataKeyEnvelopeV1: async request => {
                physicalSignal = request.signal;
                if (hold) { entered.resolve(); await release.promise; }
                return worker.decryptDataKeyEnvelopeV1(request);
            },
        }, routing: { mode: 'require', minPayloadBytes: 0 } });
        const key = new Uint8Array(32).fill(84);
        const [envelope] = await sealDataKeys(encryption, [key]);
        const first = new AbortController(), second = new AbortController();
        const abandoned = encryption.decryptEncryptionKey(envelope!, { signal: first.signal });
        await entered.promise;
        const peer = encryption.decryptEncryptionKey(envelope!, { signal: second.signal });
        try {
            first.abort();
            expect(await abandoned).toBeNull();
            expect(physicalSignal?.aborted).toBe(false);
            second.abort();
            expect(await peer).toBeNull();
            expect(physicalSignal?.aborted).toBe(true);
            hold = false;
            release.resolve();
            const fresh = await encryption.decryptEncryptionKey(envelope!);
            expect(fresh?.every((byte, index) => byte === key[index])).toBe(true);
            // The cancelled bridge never opens an item; only the new attempt does.
            expect(batches.flatMap(batch => batch.items)).toHaveLength(2);
        } finally {
            release.resolve(); first.abort(); second.abort();
            await Promise.allSettled([abandoned, peer]);
            encryption.retireAccountMaterial();
        }
    });

    it('shares overlapping envelope opens while preserving ordering and independent key bytes', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(14));
        const { worker, batches } = createRecordingCryptoWorker();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        encryption.configureNativeCryptoWorker({
            worker: { ...worker, decryptDataKeyEnvelopeV1: async request => {
                const result = await worker.decryptDataKeyEnvelopeV1(request);
                entered.resolve();
                await release.promise;
                return result;
            } },
            routing: { mode: 'auto', minBatchSize: 1, minPayloadBytes: 0 },
        });
        const keys = [new Uint8Array(32).fill(25), new Uint8Array(32).fill(26)];
        const [a, b] = await sealDataKeys(encryption, keys);
        const first = encryption.decryptEncryptionKeys([a!, b!, a!]);
        await entered.promise;
        const second = encryption.decryptEncryptionKeys([b!, a!]);
        release.resolve();
        const [firstKeys, secondKeys] = await Promise.all([first, second]);
        expect(firstKeys).toEqual([keys[0], keys[1], keys[0]]);
        expect(secondKeys).toEqual([keys[1], keys[0]]);
        expect(batches.flatMap(batch => batch.items.map(item => item.envelopeBase64))).toEqual([a, b]);
        firstKeys[0]!.fill(0);
        expect(firstKeys[2]).toEqual(keys[0]);
        expect(secondKeys[1]).toEqual(keys[0]);
    });

    it('does not retain failed opens or reuse a flight across Home generations', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(15));
        const { worker, batches } = createRecordingCryptoWorker();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let refuse = true;
        encryption.configureNativeCryptoWorker({ worker: { ...worker,
            decryptDataKeyEnvelopeV1: async request => {
                const result = await worker.decryptDataKeyEnvelopeV1(request);
                entered.resolve();
                await release.promise;
                return result.status === 'ok' && refuse ? { ...result, items: result.items.map(() => null) } : result;
            },
        }, routing: { mode: 'auto', minPayloadBytes: 0 },
        scope: { accountId: 'account', serverId: 'home-a', generation: 0 } });
        const key = new Uint8Array(32).fill(27);
        const [envelope] = await sealDataKeys(encryption, [key]);
        const first = encryption.decryptEncryptionKey(envelope!);
        await entered.promise;
        encryption.configureNativeCryptoWorker({ scope: { accountId: 'account', serverId: 'home-a', generation: 1 } });
        const next = encryption.decryptEncryptionKey(envelope!);
        release.resolve();
        expect(await first).toBeNull();
        expect(await next).toBeNull();
        refuse = false;
        expect(await encryption.decryptEncryptionKey(envelope!)).toEqual(key);
        expect(batches).toHaveLength(3);
    });

    it('shares currentness-qualified opens without admitting a retired caller', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(16));
        const { worker, batches } = createRecordingCryptoWorker();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        encryption.configureNativeCryptoWorker({ worker: { ...worker,
            decryptDataKeyEnvelopeV1: async request => {
                const result = await worker.decryptDataKeyEnvelopeV1(request);
                entered.resolve();
                await release.promise;
                return result;
            },
        }, routing: { mode: 'auto', minPayloadBytes: 0 } });
        const key = new Uint8Array(32).fill(28);
        const [envelope] = await sealDataKeys(encryption, [key]);
        const first = encryption.decryptEncryptionKey(envelope!);
        await entered.promise;
        const qualified = encryption.decryptEncryptionKey(envelope!, { shouldContinue: () => true });
        let current = true;
        const retired = encryption.decryptEncryptionKey(envelope!, { shouldContinue: () => current });
        current = false;
        release.resolve();
        expect(await first).toEqual(key);
        expect(await qualified).toEqual(key);
        expect(await retired).toBeNull();
        expect(batches.flatMap(batch => batch.items)).toHaveLength(1);
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
