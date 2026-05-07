import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';
import { stringifySerializedJsonValue } from '@happier-dev/protocol';
import { createDeferred } from '@/dev/testkit';

import { AES256Encryption, SecretBoxEncryption } from './encryptor';
import {
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    type NativeCryptoWorkerBatchResult,
    type CryptoWorkerScope,
    type NativeCryptoWorker,
} from './nativeCryptoWorker/types';

class MapCountingArray<T> extends Array<T> {
    mapCalls = 0;

    override map<U>(
        callbackfn: (value: T, index: number, array: T[]) => U,
        thisArg?: unknown,
    ): U[] {
        this.mapCalls += 1;
        return super.map(callbackfn, thisArg);
    }
}

function findEvent(name: string) {
    return syncPerformanceTelemetry.snapshot().events.find((event) => event.name === name);
}

describe('encryptor telemetry', () => {
    beforeEach(() => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 1_000_000,
        });
        syncPerformanceTelemetry.reset();
    });

    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('records batched secretbox encrypt and decrypt operations', async () => {
        const encryption = new SecretBoxEncryption(new Uint8Array(32).fill(7));

        const encrypted = await encryption.encrypt([{ value: 'one' }, { value: 'two' }]);
        const decrypted = await encryption.decrypt(encrypted);

        expect(decrypted).toEqual([{ value: 'one' }, { value: 'two' }]);
        expect(findEvent('sync.encryption.crypto.secretbox.encrypt')).toMatchObject({
            count: 1,
            fields: { items: 2 },
        });
        expect(findEvent('sync.encryption.crypto.secretbox.decrypt')).toMatchObject({
            count: 1,
            fields: { items: 2 },
        });
    });

    it('records batched AES encrypt and decrypt operations', async () => {
        const encryption = new AES256Encryption(new Uint8Array(32).fill(9));

        const encrypted = await encryption.encrypt([{ value: 'one' }, { value: 'two' }]);
        const decrypted = await encryption.decrypt(encrypted);

        expect(decrypted).toEqual([{ value: 'one' }, { value: 'two' }]);
        expect(findEvent('sync.encryption.crypto.aes.encrypt')).toMatchObject({
            count: 1,
            fields: { items: 2 },
        });
        expect(findEvent('sync.encryption.crypto.aes.decrypt')).toMatchObject({
            count: 1,
            fields: { items: 2 },
        });
    });

    it('routes secretbox decrypt batches through the configured native worker', async () => {
        const key = new Uint8Array(32).fill(12);
        const scope: CryptoWorkerScope = { accountId: 'account', serverId: 'server', generation: 1 };
        const decryptSecretboxJson = vi.fn(async () => ({
            status: 'ok' as const,
            source: 'native' as const,
            items: [{ value: 'native-secretbox' }, null],
        }));
        const worker: NativeCryptoWorker = {
            async probe() {
                return {
                    available: true,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                    nativeVersion: 1,
                };
            },
            async decryptDataKeyEnvelopeV1() {
                throw new Error('decryptDataKeyEnvelopeV1 should not be called');
            },
            decryptSecretboxJson,
            async decryptAesGcmJson() {
                throw new Error('decryptAesGcmJson should not be called');
            },
        };
        const encryption = Reflect.construct(SecretBoxEncryption, [
            key,
            {
                nativeCryptoWorker: {
                    getWorker: () => worker,
                    getRouting: () => ({ mode: 'require', minPayloadBytes: 0, telemetryEnabled: true }),
                    getScope: () => scope,
                    isScopeCurrent: () => true,
                },
            },
        ]) as SecretBoxEncryption;

        const decrypted = await encryption.decrypt([new Uint8Array([1]), new Uint8Array([2])]);

        expect(decrypted).toEqual([{ value: 'native-secretbox' }, null]);
        expect(decryptSecretboxJson).toHaveBeenCalledWith({
            scope,
            items: [
                { ciphertextBase64: encodeBase64(new Uint8Array([1])), keyBase64: encodeBase64(key) },
                { ciphertextBase64: encodeBase64(new Uint8Array([2])), keyBase64: encodeBase64(key) },
            ],
        });
        expect(findEvent('sync.crypto.worker.bridgeSerialize')).toMatchObject({
            fields: expect.objectContaining({
                operation: 2,
                items: 2,
            }),
        });
        expect(findEvent('sync.crypto.worker.queueDepth')).toMatchObject({
            fieldStats: expect.objectContaining({
                operation: expect.objectContaining({ max: 2 }),
                queueDepth: expect.objectContaining({ max: 2 }),
            }),
        });
        expect(findEvent('sync.crypto.worker.queueWaitMs')).toMatchObject({
            fields: expect.objectContaining({
                operation: 2,
                items: 2,
            }),
        });
    });

    it('does not prepare native secretbox payloads when worker mode is off', async () => {
        const key = new Uint8Array(32).fill(12);
        const encryptedItems = new MapCountingArray<Uint8Array>(new Uint8Array([1]));
        const getWorker = vi.fn((): NativeCryptoWorker => ({
            async probe() {
                return {
                    available: true,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                    nativeVersion: 1,
                };
            },
            async decryptDataKeyEnvelopeV1() {
                throw new Error('decryptDataKeyEnvelopeV1 should not be called');
            },
            async decryptSecretboxJson() {
                throw new Error('decryptSecretboxJson should not be called');
            },
            async decryptAesGcmJson() {
                throw new Error('decryptAesGcmJson should not be called');
            },
        }));
        const encryption = Reflect.construct(SecretBoxEncryption, [
            key,
            {
                nativeCryptoWorker: {
                    getWorker,
                    getRouting: () => ({ mode: 'off', minPayloadBytes: 0, telemetryEnabled: true }),
                    getScope: () => ({ accountId: 'account', serverId: 'server', generation: 1 }),
                    isScopeCurrent: () => true,
                },
            },
        ]) as SecretBoxEncryption;

        await expect(encryption.decrypt(encryptedItems)).resolves.toEqual([null]);

        expect(encryptedItems.mapCalls).toBe(0);
        expect(getWorker).not.toHaveBeenCalled();
        expect(findEvent('sync.crypto.worker.bridgeSerialize')).toBeUndefined();
        expect(findEvent('sync.crypto.worker.queueDepth')).toBeUndefined();
    });

    it('passes secretbox decrypt signals and returns nulls when queued native work is aborted before dispatch', async () => {
        const key = new Uint8Array(32).fill(21);
        const scope: CryptoWorkerScope = { accountId: 'account', serverId: 'server', generation: 1 };
        const firstDispatch = createDeferred<NativeCryptoWorkerBatchResult<unknown | null>>();
        const secretboxRequests: Array<Parameters<NativeCryptoWorker['decryptSecretboxJson']>[0]> = [];
        const decryptSecretboxJson = vi.fn(async (request: Parameters<NativeCryptoWorker['decryptSecretboxJson']>[0]) => {
            secretboxRequests.push(request);
            return await firstDispatch.promise;
        });
        const worker: NativeCryptoWorker = {
            async probe() {
                return {
                    available: true,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                    nativeVersion: 1,
                };
            },
            async decryptDataKeyEnvelopeV1() {
                throw new Error('decryptDataKeyEnvelopeV1 should not be called');
            },
            decryptSecretboxJson,
            async decryptAesGcmJson() {
                throw new Error('decryptAesGcmJson should not be called');
            },
        };
        const encryption = new SecretBoxEncryption(key, {
            nativeCryptoWorker: {
                getWorker: () => worker,
                getRouting: () => ({ mode: 'require', minPayloadBytes: 0, maxBatchSize: 1 }),
                getScope: () => scope,
                isScopeCurrent: () => true,
            },
        });
        const firstController = new AbortController();
        const secondController = new AbortController();

        const first = encryption.decrypt([new Uint8Array([1])], { signal: firstController.signal });
        await expect.poll(() => decryptSecretboxJson.mock.calls.length).toBe(1);
        const firstRequestSignal = secretboxRequests[0]?.signal;

        const second = encryption.decrypt([new Uint8Array([2])], { signal: secondController.signal });
        await Promise.resolve();
        secondController.abort();
        firstDispatch.resolve({
            status: 'ok',
            source: 'native',
            items: [{ value: 'first-secretbox' }],
        });

        await expect(first).resolves.toEqual([{ value: 'first-secretbox' }]);
        await expect(second).resolves.toEqual([null]);
        expect(firstRequestSignal).toBe(firstController.signal);
        expect(decryptSecretboxJson).toHaveBeenCalledTimes(1);
    });

    it('routes AES decrypt batches through the configured native worker', async () => {
        const key = new Uint8Array(32).fill(13);
        const scope: CryptoWorkerScope = { accountId: 'account', serverId: 'server', generation: 1 };
        const decryptAesGcmJson = vi.fn(async () => ({
            status: 'ok' as const,
            source: 'native' as const,
            items: [{ value: 'native-aes' }, null],
        }));
        const worker: NativeCryptoWorker = {
            async probe() {
                return {
                    available: true,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                    nativeVersion: 1,
                };
            },
            async decryptDataKeyEnvelopeV1() {
                throw new Error('decryptDataKeyEnvelopeV1 should not be called');
            },
            async decryptSecretboxJson() {
                throw new Error('decryptSecretboxJson should not be called');
            },
            decryptAesGcmJson,
        };
        const encryptedItems = [new Uint8Array([0, 1]), new Uint8Array([0, 2])];
        const encryption = Reflect.construct(AES256Encryption, [
            key,
            {
                nativeCryptoWorker: {
                    getWorker: () => worker,
                    getRouting: () => ({ mode: 'require', minPayloadBytes: 0, telemetryEnabled: true }),
                    getScope: () => scope,
                    isScopeCurrent: () => true,
                },
                decryptString: async () => {
                    throw new Error('decryptString should not be called when native worker handles the batch');
                },
                encryptString: async () => {
                    throw new Error('encryptString should not be called');
                },
            },
        ]) as AES256Encryption;

        const decrypted = await encryption.decrypt(encryptedItems);

        expect(decrypted).toEqual([{ value: 'native-aes' }, null]);
        expect(decryptAesGcmJson).toHaveBeenCalledWith({
            scope,
            items: [
                { encryptedPayloadBase64: encodeBase64(encryptedItems[0]), keyBase64: encodeBase64(key) },
                { encryptedPayloadBase64: encodeBase64(encryptedItems[1]), keyBase64: encodeBase64(key) },
            ],
        });
        expect(findEvent('sync.crypto.worker.bridgeSerialize')).toMatchObject({
            fields: expect.objectContaining({
                operation: 3,
                items: 2,
            }),
        });
    });

    it('passes AES decrypt signals and returns nulls when queued native work is aborted before dispatch', async () => {
        const key = new Uint8Array(32).fill(22);
        const scope: CryptoWorkerScope = { accountId: 'account', serverId: 'server', generation: 1 };
        const firstDispatch = createDeferred<NativeCryptoWorkerBatchResult<unknown | null>>();
        const aesRequests: Array<Parameters<NativeCryptoWorker['decryptAesGcmJson']>[0]> = [];
        const decryptAesGcmJson = vi.fn(async (request: Parameters<NativeCryptoWorker['decryptAesGcmJson']>[0]) => {
            aesRequests.push(request);
            return await firstDispatch.promise;
        });
        const worker: NativeCryptoWorker = {
            async probe() {
                return {
                    available: true,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                    nativeVersion: 1,
                };
            },
            async decryptDataKeyEnvelopeV1() {
                throw new Error('decryptDataKeyEnvelopeV1 should not be called');
            },
            async decryptSecretboxJson() {
                throw new Error('decryptSecretboxJson should not be called');
            },
            decryptAesGcmJson,
        };
        const encryption = new AES256Encryption(key, {
            nativeCryptoWorker: {
                getWorker: () => worker,
                getRouting: () => ({ mode: 'require', minPayloadBytes: 0, maxBatchSize: 1 }),
                getScope: () => scope,
                isScopeCurrent: () => true,
            },
            decryptString: async () => {
                throw new Error('decryptString should not be called when native worker handles the batch');
            },
            encryptString: async () => {
                throw new Error('encryptString should not be called');
            },
        });
        const firstController = new AbortController();
        const secondController = new AbortController();

        const first = encryption.decrypt([new Uint8Array([0, 1])], { signal: firstController.signal });
        await expect.poll(() => decryptAesGcmJson.mock.calls.length).toBe(1);
        const firstRequestSignal = aesRequests[0]?.signal;

        const second = encryption.decrypt([new Uint8Array([0, 2])], { signal: secondController.signal });
        await Promise.resolve();
        secondController.abort();
        firstDispatch.resolve({
            status: 'ok',
            source: 'native',
            items: [{ value: 'first-aes' }],
        });

        await expect(first).resolves.toEqual([{ value: 'first-aes' }]);
        await expect(second).resolves.toEqual([null]);
        expect(firstRequestSignal).toBe(firstController.signal);
        expect(decryptAesGcmJson).toHaveBeenCalledTimes(1);
    });

    it('does not prepare native AES payloads below the minimum batch size', async () => {
        const key = new Uint8Array(32).fill(13);
        const encryptedItems = new MapCountingArray<Uint8Array>(new Uint8Array([1]));
        const getWorker = vi.fn((): NativeCryptoWorker => ({
            async probe() {
                return {
                    available: true,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                    nativeVersion: 1,
                };
            },
            async decryptDataKeyEnvelopeV1() {
                throw new Error('decryptDataKeyEnvelopeV1 should not be called');
            },
            async decryptSecretboxJson() {
                throw new Error('decryptSecretboxJson should not be called');
            },
            async decryptAesGcmJson() {
                throw new Error('decryptAesGcmJson should not be called');
            },
        }));
        const encryption = Reflect.construct(AES256Encryption, [
            key,
            {
                nativeCryptoWorker: {
                    getWorker,
                    getRouting: () => ({ mode: 'auto', minBatchSize: 2, minPayloadBytes: 0, telemetryEnabled: true }),
                    getScope: () => ({ accountId: 'account', serverId: 'server', generation: 1 }),
                    isScopeCurrent: () => true,
                },
                decryptString: async () => {
                    throw new Error('decryptString should not be called for invalid AES prefix');
                },
                encryptString: async () => {
                    throw new Error('encryptString should not be called');
                },
            },
        ]) as AES256Encryption;

        await expect(encryption.decrypt(encryptedItems)).resolves.toEqual([null]);

        expect(encryptedItems.mapCalls).toBe(0);
        expect(getWorker).not.toHaveBeenCalled();
        expect(findEvent('sync.crypto.worker.bridgeSerialize')).toBeUndefined();
        expect(findEvent('sync.crypto.worker.queueDepth')).toBeUndefined();
    });

    it('records secretbox bridge serialization when native dispatch falls back', async () => {
        const key = new Uint8Array(32).fill(15);
        const referenceEncryption = new SecretBoxEncryption(key);
        const encrypted = await referenceEncryption.encrypt([{ value: 'reference-secretbox' }]);
        const encryption = Reflect.construct(SecretBoxEncryption, [
            key,
            {
                nativeCryptoWorker: {
                    getWorker: () => ({
                        async probe() {
                            return {
                                available: true,
                                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                                nativeVersion: 1,
                            };
                        },
                        async decryptDataKeyEnvelopeV1() {
                            throw new Error('decryptDataKeyEnvelopeV1 should not be called');
                        },
                        async decryptSecretboxJson() {
                            return {
                                status: 'stale' as const,
                                source: 'native' as const,
                                items: [],
                            };
                        },
                        async decryptAesGcmJson() {
                            throw new Error('decryptAesGcmJson should not be called');
                        },
                    }),
                    getRouting: () => ({ mode: 'auto', minPayloadBytes: 0, telemetryEnabled: true }),
                    getScope: () => ({ accountId: 'account', serverId: 'server', generation: 1 }),
                    isScopeCurrent: () => true,
                },
            },
        ]) as SecretBoxEncryption;

        syncPerformanceTelemetry.reset();
        await expect(encryption.decrypt(encrypted)).resolves.toEqual([{ value: 'reference-secretbox' }]);

        expect(findEvent('sync.crypto.worker.bridgeSerialize')).toMatchObject({
            fields: expect.objectContaining({
                operation: 2,
                items: 1,
                bytesOut: 0,
            }),
        });
    });

    it('records AES bridge serialization when native dispatch falls back', async () => {
        const key = new Uint8Array(32).fill(16);
        const encryptedItem = new Uint8Array([0, ...encodeUTF8('ciphertext')]);
        const encryption = Reflect.construct(AES256Encryption, [
            key,
            {
                nativeCryptoWorker: {
                    getWorker: () => ({
                        async probe() {
                            return {
                                available: true,
                                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                                nativeVersion: 1,
                            };
                        },
                        async decryptDataKeyEnvelopeV1() {
                            throw new Error('decryptDataKeyEnvelopeV1 should not be called');
                        },
                        async decryptSecretboxJson() {
                            throw new Error('decryptSecretboxJson should not be called');
                        },
                        async decryptAesGcmJson() {
                            return {
                                status: 'stale' as const,
                                source: 'native' as const,
                                items: [],
                            };
                        },
                    }),
                    getRouting: () => ({ mode: 'auto', minPayloadBytes: 0, telemetryEnabled: true }),
                    getScope: () => ({ accountId: 'account', serverId: 'server', generation: 1 }),
                    isScopeCurrent: () => true,
                },
                decryptString: async () => stringifySerializedJsonValue({ value: 'reference-aes' }),
                encryptString: async () => {
                    throw new Error('encryptString should not be called');
                },
            },
        ]) as AES256Encryption;

        syncPerformanceTelemetry.reset();
        await expect(encryption.decrypt([encryptedItem])).resolves.toEqual([{ value: 'reference-aes' }]);

        expect(findEvent('sync.crypto.worker.bridgeSerialize')).toMatchObject({
            fields: expect.objectContaining({
                operation: 3,
                items: 1,
                bytesOut: 0,
            }),
        });
    });

    it('keeps AES encrypt batches on the existing write path', async () => {
        const key = new Uint8Array(32).fill(14);
        const decryptAesGcmJson = vi.fn(async () => ({
            status: 'ok' as const,
            source: 'native' as const,
            items: [],
        }));
        const encryption = Reflect.construct(AES256Encryption, [
            key,
            {
                nativeCryptoWorker: {
                    getWorker: () => ({
                        async probe() {
                            return {
                                available: true,
                                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                                nativeVersion: 1,
                            };
                        },
                        async decryptDataKeyEnvelopeV1() {
                            throw new Error('decryptDataKeyEnvelopeV1 should not be called');
                        },
                        async decryptSecretboxJson() {
                            throw new Error('decryptSecretboxJson should not be called');
                        },
                        decryptAesGcmJson,
                    }),
                    getRouting: () => ({ mode: 'require', minPayloadBytes: 0 }),
                    getScope: () => ({ accountId: 'account', serverId: 'server', generation: 1 }),
                    isScopeCurrent: () => true,
                },
                encryptString: async (plaintext: string) => encodeBase64(encodeUTF8(`encrypted:${plaintext}`)),
                decryptString: async () => {
                    throw new Error('decryptString should not be called');
                },
            },
        ]) as AES256Encryption;

        const encrypted = await encryption.encrypt([{ value: 'write-path' }]);

        expect(encrypted[0]?.[0]).toBe(0);
        expect(decryptAesGcmJson).not.toHaveBeenCalled();
    });

    it('decrypts AES batches with bounded native concurrency', async () => {
        let activeDecrypts = 0;
        let maxActiveDecrypts = 0;
        const encryptedItems = ['one', 'two', 'three', 'four'].map((label) => {
            const bytes = encodeUTF8(label);
            const item = new Uint8Array(bytes.length + 1);
            item[0] = 0;
            item.set(bytes, 1);
            return item;
        });

        const encryption = new AES256Encryption(new Uint8Array(32).fill(10), {
            batchConcurrencyLimit: 2,
            decryptString: async (ciphertext) => {
                activeDecrypts += 1;
                maxActiveDecrypts = Math.max(maxActiveDecrypts, activeDecrypts);
                await Promise.resolve();
                activeDecrypts -= 1;
                return stringifySerializedJsonValue({ ciphertext });
            },
            encryptString: async () => {
                throw new Error('encryptString should not be called');
            },
        });

        const decrypted = await encryption.decrypt(encryptedItems);

        expect(maxActiveDecrypts).toBe(2);
        expect(decrypted).toEqual(encryptedItems.map((item) => ({
            ciphertext: encodeBase64(item.slice(1)),
        })));
    });

    it('encrypts AES batches with bounded native concurrency', async () => {
        let activeEncrypts = 0;
        let maxActiveEncrypts = 0;
        const encryption = new AES256Encryption(new Uint8Array(32).fill(11), {
            batchConcurrencyLimit: 2,
            encryptString: async (plaintext) => {
                activeEncrypts += 1;
                maxActiveEncrypts = Math.max(maxActiveEncrypts, activeEncrypts);
                await Promise.resolve();
                activeEncrypts -= 1;
                return encodeBase64(encodeUTF8(`encrypted:${plaintext}`));
            },
            decryptString: async () => {
                throw new Error('decryptString should not be called');
            },
        });

        const encrypted = await encryption.encrypt([{ value: 'one' }, { value: 'two' }, { value: 'three' }]);

        expect(maxActiveEncrypts).toBe(2);
        expect(encrypted.every((item) => item[0] === 0)).toBe(true);
        expect(encrypted.map((item) => item.slice(1))).toEqual([
            encodeUTF8(`encrypted:${stringifySerializedJsonValue({ value: 'one' })}`),
            encodeUTF8(`encrypted:${stringifySerializedJsonValue({ value: 'two' })}`),
            encodeUTF8(`encrypted:${stringifySerializedJsonValue({ value: 'three' })}`),
        ]);
    });
});
