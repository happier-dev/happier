import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { decodeHex } from '@/encryption/hex';
import { CRYPTO_GOLDEN_VECTORS } from '@happier-dev/protocol/crypto/cryptoGoldenVectors';
import * as dataKeyEnvelope from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { Encryption } from '../encryption';
import { createNativeCryptoWorker } from './nativeCryptoWorker.web';
import { runNativeCryptoWorkerQueuedBatch } from './nativeCryptoWorkerQueue';
import { NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON } from './types';
import { TestWebCryptoWorker as TestWorker } from '@/dev/testkit/harness/webCryptoWorkerBoundary';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const scope = { accountId: 'test-account', serverId: null, generation: 0 };

describe('web crypto worker through Encryption', () => {
    beforeEach(() => {
        TestWorker.instances = [];
        TestWorker.failure = null;
        TestWorker.constructorFailure = null;
        TestWorker.transportFault = null;
        TestWorker.failNextDispatch = false;
        TestWorker.holdStartup = false;
        TestWorker.hold = false;
        TestWorker.responseDelayMs = 0;
        vi.stubGlobal('Worker', TestWorker);
        vi.stubGlobal('window', { location: { href: 'https://happier.test/' } });
    });
    afterEach(() => {
        for (const worker of TestWorker.instances) {
            worker.onerror?.({ error: new Error('Test Worker retired'), preventDefault() {} } as ErrorEvent);
            worker.terminate();
        }
        syncPerformanceTelemetry.configure({ enabled: false });
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('opens even one envelope through the default adapter and transfers owned buffers both ways', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        const key = new Uint8Array(32).fill(11);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(key));
        await expect(encryption.decryptEncryptionKey(envelope)).resolves.toEqual(key);
        expect(TestWorker.instances).toHaveLength(1);
        const transport = TestWorker.instances[0]!;
        expect(transport.url).toBe('/happier-crypto-worker.js');
        expect(transport.requestBuffers).toHaveLength(2);
        expect(transport.requestBuffers.every(buffer => buffer.byteLength === 0)).toBe(true);
        expect(transport.replyBuffers).toHaveLength(1);
        expect(transport.replyBuffers[0]!.byteLength).toBe(0);
        expect(transport.terminated).toBe(false);
        // Transferring a request must not detach the Account's own key.
        const nextKey = new Uint8Array(32).fill(12);
        const nextEnvelope = encodeBase64(await encryption.encryptEncryptionKey(nextKey));
        await expect(encryption.decryptEncryptionKey(nextEnvelope)).resolves.toEqual(nextKey);
        expect(TestWorker.instances).toHaveLength(1);
    });

    it('preserves nulls and ordering for malformed, tampered and wrong-recipient envelopes', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(5));
        const other = await Encryption.create(new Uint8Array(32).fill(6));
        const key = new Uint8Array(32).fill(13);
        const good = await encryption.encryptEncryptionKey(key);
        const tampered = good.slice();
        tampered[tampered.length - 1]! ^= 1;
        const wrongRecipient = await other.encryptEncryptionKey(key);
        await expect(encryption.decryptEncryptionKeys([
            encodeBase64(tampered), encodeBase64(good), 'invalid', encodeBase64(wrongRecipient),
        ])).resolves.toEqual([null, key, null, null]);
        expect(TestWorker.instances).toHaveLength(1);
        expect(TestWorker.instances[0]!.terminated).toBe(false);
    });

    it('accepts a valid first Worker response delayed beyond the native bridge deadline', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(19));
        const key = new Uint8Array(32).fill(20);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(key));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'auto', timeoutMs: 5000 } });
        TestWorker.responseDelayMs = 6000;
        vi.useFakeTimers();
        const pending = encryption.decryptEncryptionKey(envelope);
        await vi.advanceTimersByTimeAsync(6000);
        await expect(pending).resolves.toEqual(key);
        expect(TestWorker.instances[0]!.terminated).toBe(false);
    });

    it('falls back when a cold Worker script never reaches its startup handshake', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(49));
        const key = new Uint8Array(32).fill(50);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(key));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'auto', minPayloadBytes: 0, timeoutMs: 100 } });
        TestWorker.holdStartup = true;
        TestWorker.hold = true;
        vi.useFakeTimers();
        const controller = new AbortController();
        let opened: Uint8Array | null | undefined;
        const pending = encryption.decryptEncryptionKey(envelope, { signal: controller.signal })
            .then((value) => { opened = value; return value; });
        try {
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(100);
            expect(opened).toEqual(key);
            expect(TestWorker.instances[0]!.terminated).toBe(true);
        } finally {
            controller.abort();
            await pending;
            TestWorker.holdStartup = false;
            TestWorker.hold = false;
        }
    });

    it('uses the reference opener only when Workers are unavailable', async () => {
        vi.stubGlobal('Worker', undefined);
        const worker = createNativeCryptoWorker();
        expect(await worker.probe()).toEqual({
            available: false,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unsupportedPlatform,
        });
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const key = new Uint8Array(32).fill(14);
        await expect(encryption.decryptEncryptionKey(encodeBase64(await encryption.encryptEncryptionKey(key)))).resolves.toEqual(key);
        expect(TestWorker.instances).toHaveLength(0);
    });

    it('preserves the canonical direct-key and seed vectors and rejects non-32-byte data keys', async () => {
        const vectors = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1;
        const selected = [vectors.directSecretKey, vectors.compatibilitySeed, vectors.undersizedDataKeyEnvelope, vectors.oversizedDataKeyEnvelope];
        const result = await createNativeCryptoWorker().decryptDataKeyEnvelopeV1({
            scope,
            items: selected.map(vector => ({
                envelopeBase64: encodeBase64(decodeHex(vector.envelope.hex)),
                recipientSecretKeyOrSeedBase64: encodeBase64(decodeHex(vector.recipientSecretKeyOrSeed.hex)),
            })),
        });
        expect(result.status).toBe('ok');
        expect(result.items).toEqual([
            encodeBase64(decodeHex(vectors.directSecretKey.dataKey.hex)),
            encodeBase64(decodeHex(vectors.compatibilitySeed.dataKey.hex)), null, null,
        ]);
        expect(TestWorker.instances[0]!.terminated).toBe(false);
    });

    it('opens the same call with canonical JS after a transport failure and recovers its Worker for the next call', async () => {
        TestWorker.failure = new Error('worker transport failed');
        const encryption = await Encryption.create(new Uint8Array(32).fill(8));
        const key = new Uint8Array(32).fill(15);
        const encrypted = encodeBase64(await encryption.encryptEncryptionKey(key));
        await expect(encryption.decryptEncryptionKey(encrypted)).resolves.toEqual(key);
        expect(TestWorker.instances[0]!.terminated).toBe(true);
        TestWorker.failure = null;
        const nextKey = new Uint8Array(32).fill(21);
        await expect(encryption.decryptEncryptionKey(encodeBase64(await encryption.encryptEncryptionKey(nextKey))))
            .resolves.toEqual(nextKey);
        expect(TestWorker.instances).toHaveLength(2);
        expect(TestWorker.instances[1]!.terminated).toBe(false);
    });


    it('opens the same call with canonical JS when browser policy refuses Worker construction, then recovers', async () => {
        TestWorker.constructorFailure = new Error('Worker blocked by policy');
        const encryption = await Encryption.create(new Uint8Array(32).fill(22));
        const key = new Uint8Array(32).fill(23);
        await expect(encryption.decryptEncryptionKey(encodeBase64(await encryption.encryptEncryptionKey(key))))
            .resolves.toEqual(key);
        TestWorker.constructorFailure = null;
        const nextKey = new Uint8Array(32).fill(24);
        await expect(encryption.decryptEncryptionKey(encodeBase64(await encryption.encryptEncryptionKey(nextKey))))
            .resolves.toEqual(nextKey);
        expect(TestWorker.instances).toHaveLength(1);
    });

    it.each(['post', 'message', 'response', 'runtime'] as const)('falls back and recovers after a %s boundary failure', async (fault) => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(34));
        const key = new Uint8Array(32).fill(35);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(key));
        TestWorker.transportFault = fault;
        await expect(encryption.decryptEncryptionKeys([envelope, 'invalid'])).resolves.toEqual([key, null]);
        expect(TestWorker.instances[0]!.terminated).toBe(true);
        TestWorker.transportFault = null;
        const nextKey = new Uint8Array(32).fill(36);
        await expect(encryption.decryptEncryptionKey(encodeBase64(await encryption.encryptEncryptionKey(nextKey))))
            .resolves.toEqual(nextKey);
        expect(TestWorker.instances).toHaveLength(2);
        expect(TestWorker.instances[1]!.terminated).toBe(false);
    });

    it('reuses one Worker for concurrent Account scopes without crossing their results', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(25));
        const firstKey = new Uint8Array(32).fill(26);
        const secondKey = new Uint8Array(32).fill(27);
        const firstEnvelope = encodeBase64(await encryption.encryptEncryptionKey(firstKey));
        const secondEnvelope = encodeBase64(await encryption.encryptEncryptionKey(secondKey));
        await expect(Promise.all([
            encryption.decryptEncryptionKey(firstEnvelope, { accountId: 'first' }),
            encryption.decryptEncryptionKey(secondEnvelope, { accountId: 'second' }),
        ])).resolves.toEqual([firstKey, secondKey]);
        expect(TestWorker.instances).toHaveLength(1);
        expect(TestWorker.instances[0]!.terminated).toBe(false);
    });

    it('reuses one Worker across different Encryption instances without retaining either Account key', async () => {
        const first = await Encryption.create(new Uint8Array(32).fill(42));
        const second = await Encryption.create(new Uint8Array(32).fill(43));
        const firstKey = new Uint8Array(32).fill(44);
        const secondKey = new Uint8Array(32).fill(45);
        const firstEnvelope = encodeBase64(await first.encryptEncryptionKey(firstKey));
        const secondEnvelope = encodeBase64(await second.encryptEncryptionKey(secondKey));
        await expect(Promise.all([
            first.decryptEncryptionKey(firstEnvelope),
            second.decryptEncryptionKey(secondEnvelope),
        ])).resolves.toEqual([firstKey, secondKey]);
        // A later adapter must still use its own recipient, including failed opens.
        await expect(second.decryptEncryptionKey(firstEnvelope)).resolves.toBeNull();
        expect(TestWorker.instances).toHaveLength(1);
        expect(TestWorker.instances[0]!.terminated).toBe(false);
    });

    it.each(['same', 'different'] as const)('opens an interactive %s envelope through Encryption before held bulk inventory', async (envelopeSelection) => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(51));
        const bulkKeys = Array.from({ length: 500 }, (_, index) => new Uint8Array(32).fill(index % 256));
        const bulkEnvelopes = await Promise.all(bulkKeys.map(async key => encodeBase64(await encryption.encryptEncryptionKey(key))));
        const exactKey = envelopeSelection === 'same' ? bulkKeys[0]! : new Uint8Array(32).fill(52);
        const exactEnvelope = envelopeSelection === 'same'
            ? bulkEnvelopes[0]!
            : encodeBase64(await encryption.encryptEncryptionKey(exactKey));
        const open = vi.spyOn(dataKeyEnvelope, 'openEncryptedDataKeyEnvelopeV1');
        const exactBytes = Buffer.from(exactEnvelope, 'base64');
        const exactOpenCount = () => open.mock.calls.filter(([request]) => request.envelope.length === exactBytes.length
            && request.envelope.every((byte, index) => byte === exactBytes[index])).length;
        TestWorker.hold = true;
        vi.useFakeTimers();
        let bulkSettled = false;
        const bulk = encryption.decryptEncryptionKeys(bulkEnvelopes)
            .then(items => { bulkSettled = true; return items; });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(TestWorker.instances).toHaveLength(1);
            const bulkWorker = TestWorker.instances[0]!;
            TestWorker.hold = false;
            const interactive = encryption.decryptEncryptionKey(exactEnvelope, { workClass: 'interactive' });
            await vi.advanceTimersByTimeAsync(0);
            expect(TestWorker.instances).toHaveLength(2);
            await expect(interactive).resolves.toEqual(exactKey);
            expect(exactOpenCount()).toBe(1);
            expect(bulkSettled).toBe(false);
            expect(bulkWorker.pendingReplies).toHaveLength(1);
            await bulkWorker.pendingReplies.shift()!();
            await expect(bulk).resolves.toEqual(bulkKeys);
            const expectedOpens = envelopeSelection === 'same' ? 2 : 1;
            expect(exactOpenCount()).toBe(expectedOpens);
            // Completed pure opens remain shared across demand classes.
            TestWorker.hold = true;
            await expect(encryption.decryptEncryptionKey(exactEnvelope, { workClass: 'interactive' })).resolves.toEqual(exactKey);
            await expect(encryption.decryptEncryptionKey(exactEnvelope)).resolves.toEqual(exactKey);
            expect(exactOpenCount()).toBe(expectedOpens);
            expect(TestWorker.instances.every(worker => worker.pendingReplies.length === 0)).toBe(true);
        } finally {
            TestWorker.hold = false;
            for (const worker of TestWorker.instances) {
                for (const reply of worker.pendingReplies.splice(0)) await reply();
            }
            await bulk;
            open.mockRestore();
        }
    });

    it('opens interactive work while the same owner has a held bulk batch and queued inventory', async () => {
        const vector = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.directSecretKey;
        const item = {
            envelopeBase64: encodeBase64(decodeHex(vector.envelope.hex)),
            recipientSecretKeyOrSeedBase64: encodeBase64(decodeHex(vector.recipientSecretKeyOrSeed.hex)),
        };
        const owner = {};
        const worker = createNativeCryptoWorker();
        const controller = new AbortController();
        const run = (workClass: 'bulk' | 'interactive', items: readonly typeof item[]) =>
            runNativeCryptoWorkerQueuedBatch({
                owner, scope, operation: 'decryptDataKeyEnvelopeV1', maxBatchSize: 64,
                workClass, items, signal: controller.signal,
                dispatch: async (batch, context) => {
                    const result = await worker.decryptDataKeyEnvelopeV1({
                        scope, workClass, items: batch, signal: context.signal,
                    });
                    if (result.status !== 'ok') throw new Error('Worker request cancelled');
                    return result.items;
                },
            });
        TestWorker.hold = true;
        vi.useFakeTimers();
        let bulkSettled = false;
        const bulk = run('bulk', Array.from({ length: 500 }, () => item))
            .then(items => { bulkSettled = true; return { items }; }, error => { bulkSettled = true; return { error }; });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(TestWorker.instances).toHaveLength(1);
            const bulkWorker = TestWorker.instances[0]!;
            expect(bulkWorker.requestBuffers).toHaveLength(128);
            TestWorker.hold = false;
            const interactive = run('interactive', [item]).then(items => ({ items }), error => ({ error }));
            await vi.advanceTimersByTimeAsync(0);
            // A different work class must reach the Worker boundary before any
            // held bulk reply; this also catches sharing its owner-level queue.
            expect(TestWorker.instances).toHaveLength(2);
            await expect(interactive).resolves.toEqual({ items: [encodeBase64(decodeHex(vector.dataKey.hex))] });
            expect(bulkSettled).toBe(false);
            expect(bulkWorker.pendingReplies).toHaveLength(1);
            await bulkWorker.pendingReplies.shift()!();
            await expect(bulk).resolves.toEqual({
                items: Array.from({ length: 500 }, () => encodeBase64(decodeHex(vector.dataKey.hex))),
            });
        } finally {
            controller.abort();
            await bulk;
        }
    });

    it.each(['abort', 'error'] as const)('retires only the interactive transport after its %s', async (failure) => {
        const vector = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.directSecretKey;
        const items = [{
            envelopeBase64: encodeBase64(decodeHex(vector.envelope.hex)),
            recipientSecretKeyOrSeedBase64: encodeBase64(decodeHex(vector.recipientSecretKeyOrSeed.hex)),
        }];
        const expected = { status: 'ok', source: 'native', items: [encodeBase64(decodeHex(vector.dataKey.hex))] };
        const bulkController = new AbortController();
        const interactiveController = new AbortController();
        TestWorker.hold = true;
        vi.useFakeTimers();
        const bulk = createNativeCryptoWorker().decryptDataKeyEnvelopeV1({ scope, items, signal: bulkController.signal });
        const interactive = createNativeCryptoWorker().decryptDataKeyEnvelopeV1({
            scope, items, workClass: 'interactive', signal: interactiveController.signal,
        }).then(result => ({ result }), error => ({ error }));
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(TestWorker.instances).toHaveLength(2);
            const [bulkWorker, interactiveWorker] = TestWorker.instances;
            if (failure === 'abort') {
                interactiveController.abort();
                await expect(interactive).resolves.toEqual({ result: { status: 'cancelled', source: 'cancelled', items: [] } });
            } else {
                interactiveWorker!.onerror?.({ error: new Error('Interactive Worker failed'), preventDefault() {} } as ErrorEvent);
                await expect(interactive).resolves.toEqual({ error: new Error('Interactive Worker failed') });
            }
            expect(interactiveWorker!.terminated).toBe(true);
            expect(bulkWorker!.terminated).toBe(false);
            TestWorker.hold = false;
            await expect(createNativeCryptoWorker().decryptDataKeyEnvelopeV1({
                scope: { ...scope, accountId: 'other-account' }, items, workClass: 'interactive',
            })).resolves.toEqual(expected);
            expect(TestWorker.instances).toHaveLength(3);
            await bulkWorker!.pendingReplies.shift()!();
            await expect(bulk).resolves.toEqual(expected);
            await expect(createNativeCryptoWorker().decryptDataKeyEnvelopeV1({ scope, items, workClass: 'interactive' }))
                .resolves.toEqual(expected);
            expect(TestWorker.instances).toHaveLength(3);
        } finally {
            bulkController.abort();
            interactiveController.abort();
            await bulk;
            await interactive;
        }
    });

    it('measures class-local transport waiting separately from dispatch service', async () => {
        const vector = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.directSecretKey;
        const items = [{
            envelopeBase64: encodeBase64(decodeHex(vector.envelope.hex)),
            recipientSecretKeyOrSeedBase64: encodeBase64(decodeHex(vector.recipientSecretKeyOrSeed.hex)),
        }];
        const expected = { result: { status: 'ok', source: 'native', items: [encodeBase64(decodeHex(vector.dataKey.hex))] } };
        const controller = new AbortController();
        const worker = createNativeCryptoWorker();
        vi.useFakeTimers();
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        syncPerformanceTelemetry.configure({ enabled: true });
        syncPerformanceTelemetry.reset();
        TestWorker.hold = true;
        const run = (workClass: 'bulk' | 'interactive') => worker.decryptDataKeyEnvelopeV1({
            scope, items, workClass, signal: controller.signal,
        }).then(result => ({ result }), error => ({ error }));
        const first = run('bulk');
        const pending = [first];
        try {
            await vi.advanceTimersByTimeAsync(0);
            now = 20;
            const second = run('bulk');
            const interactive = run('interactive');
            pending.push(second, interactive);
            await vi.advanceTimersByTimeAsync(0);
            const [bulkWorker, interactiveWorker] = TestWorker.instances;
            now = 50;
            await interactiveWorker!.pendingReplies.shift()!();
            await expect(interactive).resolves.toEqual(expected);
            await bulkWorker!.pendingReplies.shift()!();
            await expect(first).resolves.toEqual(expected);
            await vi.advanceTimersByTimeAsync(0);
            now = 60;
            await bulkWorker!.pendingReplies.shift()!();
            await expect(second).resolves.toEqual(expected);
            const events = syncPerformanceTelemetry.snapshot().events;
            expect(events.find(event => event.name === 'sync.crypto.worker.web.queueWaitMs')).toMatchObject({
                count: 3, totalMs: 30, fields: { items: 3, interactive: 1 },
            });
            expect(events.find(event => event.name === 'sync.crypto.worker.web.serviceMs')).toMatchObject({
                count: 3, totalMs: 90, fields: { items: 3, interactive: 1 },
            });
            expect(events.find(event => event.name === 'sync.crypto.worker.web.transportDepth')).toMatchObject({
                fieldStats: { queued: { max: 1, last: 0 }, inFlight: { max: 1, last: 0 } },
            });
        } finally {
            controller.abort();
            await Promise.all(pending);
            syncPerformanceTelemetry.configure({ enabled: false });
            clock.mockRestore();
        }
    });

    it.each(['error', 'messageerror'] as const)('replaces a Worker that reports %s while idle and ignores retired Worker events', async (eventKind) => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(37));
        const firstKey = new Uint8Array(32).fill(38);
        await expect(encryption.decryptEncryptionKey(encodeBase64(await encryption.encryptEncryptionKey(firstKey))))
            .resolves.toEqual(firstKey);
        const idleWorker = TestWorker.instances[0]!;
        const event = { error: new Error('Idle Worker failed'), preventDefault() {} } as ErrorEvent;
        const oldError = idleWorker.onerror;
        const oldMessageError = idleWorker.onmessageerror;
        if (eventKind === 'error') oldError?.(event);
        else oldMessageError?.();
        expect(idleWorker.terminated).toBe(true);
        const nextKey = new Uint8Array(32).fill(39);
        await expect(encryption.decryptEncryptionKey(encodeBase64(await encryption.encryptEncryptionKey(nextKey))))
            .resolves.toEqual(nextKey);
        expect(TestWorker.instances).toHaveLength(2);
        oldError?.(event);
        oldMessageError?.();
        expect(TestWorker.instances[1]!.terminated).toBe(false);
    });

    it.each([false, true])('drops a retired generation even when Worker failure triggers fallback: %s', async (failWorker) => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(40));
        const key = new Uint8Array(32).fill(41);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(key));
        TestWorker.hold = true;
        vi.useFakeTimers();
        const pending = encryption.decryptEncryptionKey(envelope);
        await vi.advanceTimersByTimeAsync(0);
        encryption.configureNativeCryptoWorker({ scope: { accountId: 'local', serverId: null, generation: 1 } });
        if (failWorker) TestWorker.failure = new Error('Retired scope Worker failed');
        await TestWorker.instances[0]!.pendingReplies.shift()!();
        await expect(pending).resolves.toBeNull();
        TestWorker.failure = null;
        TestWorker.hold = false;
        await expect(encryption.decryptEncryptionKey(envelope)).resolves.toEqual(key);
    });

    it('cancels a pending batch and terminates its Worker', async () => {
        TestWorker.hold = true;
        const controller = new AbortController();
        const pending = createNativeCryptoWorker().decryptDataKeyEnvelopeV1({
            scope, signal: controller.signal,
            items: [{ envelopeBase64: 'AA==', recipientSecretKeyOrSeedBase64: 'AA==' }],
        });
        await Promise.resolve();
        controller.abort();
        await expect(pending).resolves.toEqual({ status: 'cancelled', source: 'cancelled', items: [] });
        expect(TestWorker.instances[0]!.terminated).toBe(true);
    });

    it('does not let a cancelled queued caller terminate another scope or consume its response', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(28));
        const firstKey = new Uint8Array(32).fill(29);
        const cancelledKey = new Uint8Array(32).fill(30);
        const firstEnvelope = encodeBase64(await encryption.encryptEncryptionKey(firstKey));
        const cancelledEnvelope = encodeBase64(await encryption.encryptEncryptionKey(cancelledKey));
        TestWorker.hold = true;
        vi.useFakeTimers();
        const first = encryption.decryptEncryptionKey(firstEnvelope, { accountId: 'first' });
        await vi.advanceTimersByTimeAsync(0);
        const controller = new AbortController();
        const cancelled = encryption.decryptEncryptionKey(cancelledEnvelope, { accountId: 'second', signal: controller.signal });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await expect(cancelled).resolves.toBeNull();
        expect(TestWorker.instances).toHaveLength(1);
        expect(TestWorker.instances[0]!.terminated).toBe(false);
        await TestWorker.instances[0]!.pendingReplies.shift()!();
        await expect(first).resolves.toEqual(firstKey);
    });

    it('replaces an actively cancelled Worker while preserving another scope and ignoring the old response', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(31));
        const cancelledKey = new Uint8Array(32).fill(32);
        const nextKey = new Uint8Array(32).fill(33);
        const cancelledEnvelope = encodeBase64(await encryption.encryptEncryptionKey(cancelledKey));
        const nextEnvelope = encodeBase64(await encryption.encryptEncryptionKey(nextKey));
        const controller = new AbortController();
        TestWorker.hold = true;
        vi.useFakeTimers();
        const cancelled = encryption.decryptEncryptionKey(cancelledEnvelope, { accountId: 'first', signal: controller.signal });
        await vi.advanceTimersByTimeAsync(0);
        const oldWorker = TestWorker.instances[0]!;
        const oldResponse = oldWorker.onmessage!;
        const next = encryption.decryptEncryptionKey(nextEnvelope, { accountId: 'second' });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await expect(cancelled).resolves.toBeNull();
        await vi.advanceTimersByTimeAsync(0);
        expect(oldWorker.terminated).toBe(true);
        oldResponse({ data: { status: 'ok', items: [cancelledKey] } } as MessageEvent);
        const nextWorker = TestWorker.instances[1]!;
        expect(nextWorker.terminated).toBe(false);
        await nextWorker.pendingReplies.shift()!();
        await expect(next).resolves.toEqual(nextKey);
        expect(TestWorker.instances).toHaveLength(2);
    });

    it('keeps web work pending beyond the native deadline and terminates it on caller cancellation', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        const encrypted = encodeBase64(await encryption.encryptEncryptionKey(new Uint8Array(32).fill(16)));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'auto', timeoutMs: 100 } });
        TestWorker.hold = true;
        vi.useFakeTimers();
        const controller = new AbortController();
        const pending = encryption.decryptEncryptionKey(encrypted, { signal: controller.signal });
        let settled = false;
        void pending.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(TestWorker.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(settled).toBe(false);
        expect(TestWorker.instances[0]!.terminated).toBe(false);
        controller.abort();
        await expect(pending).resolves.toBeNull();
        expect(TestWorker.instances[0]!.terminated).toBe(true);
    });

    it('opens the first 500 Artifact headers when healthy queued dispatches together exceed five seconds', async () => {
        const { ArtifactEncryption } = await import('../artifactEncryption');
        const { decryptArtifactListItems } = await import('@/sync/engine/artifacts/syncArtifacts');
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        const dataKey = new Uint8Array(32).fill(18);
        const header = await new ArtifactEncryption(dataKey).encryptHeader({ v: 1, kind: 'artifact.legacy' });
        const artifacts = await Promise.all(Array.from({ length: 500 }, async (_, index) => ({
            id: `artifact-${index}`, ownerAccountId: 'test-account', access: 'owner' as const,
            encryptionMode: 'e2ee' as const, header, headerVersion: 1,
            dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(dataKey)),
            seq: index, createdAt: 0, updatedAt: 0,
        })));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'auto', maxBatchSize: 64, timeoutMs: 5000 } });
        // Each real worker-handler dispatch is healthy; only its OS transport is delayed.
        TestWorker.responseDelayMs = 750;
        vi.useFakeTimers();
        const pending = decryptArtifactListItems({ artifacts, encryption, artifactDataKeys: new Map(), includeBody: false });
        await vi.advanceTimersByTimeAsync(6000);
        const opened = await pending;
        expect(opened.filter(row => row?.isDecrypted).length).toBe(500);
        expect(TestWorker.instances).toHaveLength(1);
        expect(TestWorker.instances[0]!.terminated).toBe(false);
    });

    it('cancels abandoned bulk queue work before JS fallback without cancelling another scope', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(46));
        const key = new Uint8Array(32).fill(47);
        const envelopes = await Promise.all(Array.from({ length: 500 }, async () =>
            encodeBase64(await encryption.encryptEncryptionKey(key))));
        const otherKey = new Uint8Array(32).fill(48);
        const otherEnvelope = encodeBase64(await encryption.encryptEncryptionKey(otherKey));
        TestWorker.hold = true;
        TestWorker.failNextDispatch = true;
        vi.useFakeTimers();
        const first = encryption.decryptEncryptionKeys(envelopes);
        await vi.advanceTimersByTimeAsync(0);
        const other = encryption.decryptEncryptionKey(otherEnvelope, { accountId: 'other' });
        await vi.advanceTimersByTimeAsync(0);
        await TestWorker.instances[0]!.pendingReplies.shift()!();
        await vi.runAllTimersAsync();
        await expect(first).resolves.toEqual(envelopes.map(() => key));
        const activeWorker = TestWorker.instances.at(-1)!;
        // The surviving Worker belongs to the one-envelope other scope. The
        // failed inventory must not leave another 64-item request running.
        expect(activeWorker.requestBuffers).toHaveLength(2);
        await activeWorker.pendingReplies.shift()!();
        await expect(other).resolves.toEqual(otherKey);
        await vi.advanceTimersByTimeAsync(0);
        expect(activeWorker.requestBuffers).toHaveLength(2);
        expect(activeWorker.pendingReplies).toHaveLength(0);
    });

    it('retains the canonical JSON cipher when the web adapter does not contribute that operation', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(10));
        const value = { text: 'real JSON content '.repeat(100) };
        await expect(encryption.decryptRaw(await encryption.encryptRaw(value))).resolves.toEqual(value);
        expect(TestWorker.instances).toHaveLength(0);
    });

    it('does not start a Worker for a cancelled batch', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(createNativeCryptoWorker().decryptDataKeyEnvelopeV1({ scope, signal: controller.signal, items: [] }))
            .resolves.toEqual({ status: 'cancelled', source: 'cancelled', items: [] });
        expect(TestWorker.instances).toHaveLength(0);
    });
});
