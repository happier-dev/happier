import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { encodeBase64 } from '@/encryption/base64';
import {
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    type NativeCryptoWorker,
} from './nativeCryptoWorker/types';

import { ArtifactEncryption } from './artifactEncryption';
import { AES256Encryption } from './encryptor';
import { EncryptionCache } from './encryptionCache';
import { Encryption } from './encryption';
import {
    MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS,
    MachineEncryption,
    measureMachineEncryptRawAttribution,
} from './machineEncryption';
import { SessionEncryption } from './sessionEncryption';

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

function expectNumericFields(name: string) {
    const event = findEvent(name);
    expect(event).toBeTruthy();
    expect(Object.values(event?.fields ?? {}).every((value) => typeof value === 'number')).toBe(true);
}

function createUnusedNativeWorker(): NativeCryptoWorker {
    return {
        probe: async () => ({
            available: true,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
            nativeVersion: 1,
        }),
        async decryptDataKeyEnvelopeV1() {
            throw new Error('decryptDataKeyEnvelopeV1 should not be called');
        },
        async decryptSecretboxJson() {
            throw new Error('decryptSecretboxJson should not be called');
        },
        async decryptAesGcmJson() {
            throw new Error('decryptAesGcmJson should not be called');
        },
    };
}

describe('encryption telemetry', () => {
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

    it('records semantic session raw encryption operations', async () => {
        const sessionEncryption = new SessionEncryption(
            'session-telemetry',
            new AES256Encryption(new Uint8Array(32).fill(3)),
            new EncryptionCache(),
        );

        const encrypted = await sessionEncryption.encryptRaw({ hello: 'world' });
        const decrypted = await sessionEncryption.decryptRaw(encrypted);

        expect(decrypted).toEqual({ hello: 'world' });
        expect(findEvent('sync.encryption.session.encryptRaw')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
        expect(findEvent('sync.encryption.decryptRaw')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
    });

    it('records session message decrypt cache hits and plaintext bypasses', async () => {
        const encryptor = new AES256Encryption(new Uint8Array(32).fill(11));
        const sessionEncryption = new SessionEncryption(
            'session-message-telemetry',
            encryptor,
            new EncryptionCache(),
        );
        const encrypted = await encryptor.encrypt([
            { role: 'user', content: { type: 'text', text: 'encrypted' } },
        ]);
        const encryptedMessage: ApiMessage = {
            id: 'm_encrypted',
            seq: 1,
            localId: null,
            createdAt: 1,
            updatedAt: 1,
            content: { t: 'encrypted' as const, c: encodeBase64(encrypted[0], 'base64') },
        };
        const plainMessage: ApiMessage = {
            id: 'm_plain',
            seq: 2,
            localId: null,
            createdAt: 2,
            updatedAt: 2,
            content: {
                t: 'plain' as const,
                v: { role: 'user', content: { type: 'text', text: 'plain' } },
            },
        };

        syncPerformanceTelemetry.reset();
        await sessionEncryption.decryptMessages([encryptedMessage, plainMessage]);

        expect(findEvent('sync.encryption.decryptMessages.scan')).toMatchObject({
            count: 1,
            fields: {
                messages: 2,
                toDecrypt: 1,
                cached: 0,
                plain: 1,
                invalid: 0,
            },
        });
        expect(findEvent('sync.encryption.decryptMessages.decodeCiphertext')).toMatchObject({
            count: 1,
            fields: { messages: 1 },
        });

        syncPerformanceTelemetry.reset();
        await sessionEncryption.decryptMessages([encryptedMessage, plainMessage]);

        expect(findEvent('sync.encryption.decryptMessages.scan')).toMatchObject({
            count: 1,
            fields: {
                messages: 2,
                toDecrypt: 0,
                cached: 2,
                plain: 0,
                invalid: 0,
            },
        });
    });

    it('records account data-key envelope operations', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));

        const wrapped = await encryption.encryptEncryptionKey(new Uint8Array(32).fill(5));
        const opened = await encryption.decryptEncryptionKey(Buffer.from(wrapped).toString('base64'));

        expect(opened).toEqual(new Uint8Array(32).fill(5));
        expect(findEvent('sync.encryption.account.encryptDataKey')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
        expect(findEvent('sync.encryption.account.decryptDataKey')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
    });

    it('routes account data-key envelope decrypts through the configured native worker', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        const nativeDataKey = new Uint8Array(32).fill(99);
        const worker: NativeCryptoWorker = {
            async probe() {
                return {
                    available: true,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                    nativeVersion: 1,
                };
            },
            async decryptDataKeyEnvelopeV1() {
                return {
                    status: 'ok',
                    source: 'native',
                    items: [encodeBase64(nativeDataKey, 'base64')],
                };
            },
            async decryptSecretboxJson() {
                throw new Error('not used');
            },
            async decryptAesGcmJson() {
                throw new Error('not used');
            },
        };

        encryption.configureNativeCryptoWorker({
            worker,
            routing: {
                mode: 'require',
                minPayloadBytes: 0,
                telemetryEnabled: true,
            },
            scope: {
                accountId: 'account',
                serverId: 'server',
                generation: 0,
            },
        });

        await expect(encryption.decryptEncryptionKey('not-reference-decodable')).resolves.toEqual(nativeDataKey);
        expect(findEvent('sync.crypto.worker.bridgeSerialize')).toMatchObject({
            fields: expect.objectContaining({
                operation: 1,
                items: 1,
            }),
        });
        expect(findEvent('sync.crypto.worker.queueDepth')).toMatchObject({
            fields: expect.objectContaining({
                operation: 1,
                queueDepth: 1,
            }),
        });
        expect(findEvent('sync.crypto.worker.queueWaitMs')).toMatchObject({
            fields: expect.objectContaining({
                operation: 1,
                items: 1,
            }),
        });
    });

    it('does not prepare native data-key payloads when worker mode is off', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        const encryptedValues = new MapCountingArray<string>('not-reference-decodable');
        const worker = createUnusedNativeWorker();

        encryption.configureNativeCryptoWorker({
            worker,
            routing: {
                mode: 'off',
                minPayloadBytes: 0,
                telemetryEnabled: true,
            },
        });

        const decrypted = await encryption.decryptEncryptionKeys(encryptedValues);

        expect(Array.from(decrypted)).toEqual([null]);
        expect(encryptedValues.mapCalls).toBe(1);
        expect(findEvent('sync.crypto.worker.bridgeSerialize')).toBeUndefined();
        expect(findEvent('sync.crypto.worker.queueDepth')).toBeUndefined();
    });

    it('does not prepare native data-key payloads below the minimum batch size', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        const encryptedValues = new MapCountingArray<string>('not-reference-decodable');
        const worker = createUnusedNativeWorker();

        encryption.configureNativeCryptoWorker({
            worker,
            routing: {
                mode: 'auto',
                minBatchSize: 2,
                minPayloadBytes: 0,
                telemetryEnabled: true,
            },
        });

        const decrypted = await encryption.decryptEncryptionKeys(encryptedValues);

        expect(Array.from(decrypted)).toEqual([null]);
        expect(encryptedValues.mapCalls).toBe(1);
        expect(findEvent('sync.crypto.worker.bridgeSerialize')).toBeUndefined();
        expect(findEvent('sync.crypto.worker.queueDepth')).toBeUndefined();
    });

    it('records data-key bridge serialization when native dispatch falls back', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        const dataKey = new Uint8Array(32).fill(5);
        const wrapped = await encryption.encryptEncryptionKey(dataKey);
        const worker: NativeCryptoWorker = {
            async probe() {
                return {
                    available: true,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                    nativeVersion: 1,
                };
            },
            async decryptDataKeyEnvelopeV1() {
                return {
                    status: 'stale',
                    source: 'native',
                    items: [],
                };
            },
            async decryptSecretboxJson() {
                throw new Error('not used');
            },
            async decryptAesGcmJson() {
                throw new Error('not used');
            },
        };

        syncPerformanceTelemetry.reset();
        encryption.configureNativeCryptoWorker({
            worker,
            routing: {
                mode: 'auto',
                minPayloadBytes: 0,
                telemetryEnabled: true,
            },
        });

        await expect(encryption.decryptEncryptionKey(Buffer.from(wrapped).toString('base64'))).resolves.toEqual(dataKey);
        expect(findEvent('sync.crypto.worker.bridgeSerialize')).toMatchObject({
            fields: expect.objectContaining({
                operation: 1,
                items: 1,
                bytesOut: 0,
            }),
        });
    });

    it('preserves data-key decrypt result ordering when a native worker batch becomes stale', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        const staleDataKey = new Uint8Array(32).fill(101);
        const worker: NativeCryptoWorker = {
            async probe() {
                return {
                    available: true,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                    nativeVersion: 1,
                };
            },
            async decryptDataKeyEnvelopeV1() {
                encryption.configureNativeCryptoWorker({
                    scope: {
                        accountId: 'account',
                        serverId: 'server',
                        generation: 1,
                    },
                });
                return {
                    status: 'ok',
                    source: 'native',
                    items: [encodeBase64(staleDataKey, 'base64')],
                };
            },
            async decryptSecretboxJson() {
                throw new Error('not used');
            },
            async decryptAesGcmJson() {
                throw new Error('not used');
            },
        };

        encryption.configureNativeCryptoWorker({
            worker,
            routing: {
                mode: 'require',
                minPayloadBytes: 0,
            },
            scope: {
                accountId: 'account',
                serverId: 'server',
                generation: 0,
            },
        });

        await expect(encryption.decryptEncryptionKeys(['not-reference-decodable'])).resolves.toEqual([null]);
    });

    it('warms the configured native worker and records its capability', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        const capability = {
            available: true,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
            nativeVersion: 1,
            warmupMs: 7,
            supportedOperations: [NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1],
        } as const;
        const worker: NativeCryptoWorker = {
            async probe() {
                return capability;
            },
            async decryptDataKeyEnvelopeV1() {
                throw new Error('not used');
            },
            async decryptSecretboxJson() {
                throw new Error('not used');
            },
            async decryptAesGcmJson() {
                throw new Error('not used');
            },
        };

        encryption.configureNativeCryptoWorker({
            worker,
            routing: {
                mode: 'auto',
                telemetryEnabled: true,
            },
            scope: {
                accountId: 'account',
                serverId: 'server',
                generation: 0,
            },
        });

        const warmup = (encryption as unknown as {
            warmNativeCryptoWorkerForDiagnostics?: () => Promise<unknown>;
        }).warmNativeCryptoWorkerForDiagnostics;
        expect(warmup).toBeTypeOf('function');

        await warmup!.call(encryption);

        expect(findEvent('sync.crypto.worker.capability')).toMatchObject({
            count: 1,
            fields: {
                workerMode: 1,
                available: 1,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                warmupMs: 7,
                supportsDecryptDataKeyEnvelopeV1: 1,
                supportsDecryptSecretboxJson: 0,
                supportsDecryptAesGcmJson: 0,
            },
        });
    });

    it('reuses the warm native worker capability for the first data-key decrypt dispatch', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        const nativeDataKey = new Uint8Array(32).fill(66);
        let probeCount = 0;
        const worker: NativeCryptoWorker = {
            async probe() {
                probeCount += 1;
                return {
                    available: true,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                    nativeVersion: 1,
                };
            },
            async decryptDataKeyEnvelopeV1() {
                return {
                    status: 'ok',
                    source: 'native',
                    items: [encodeBase64(nativeDataKey, 'base64')],
                };
            },
            async decryptSecretboxJson() {
                throw new Error('not used');
            },
            async decryptAesGcmJson() {
                throw new Error('not used');
            },
        };

        encryption.configureNativeCryptoWorker({
            worker,
            routing: {
                mode: 'require',
                minPayloadBytes: 0,
                telemetryEnabled: true,
            },
            scope: {
                accountId: 'account',
                serverId: 'server',
                generation: 0,
            },
        });

        await encryption.warmNativeCryptoWorkerForDiagnostics();
        await expect(encryption.decryptEncryptionKey('not-reference-decodable')).resolves.toEqual(nativeDataKey);

        expect(probeCount).toBe(1);
    });

    it('uses configured AES batch concurrency for session data-key encryption', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(12));
        const configurable = encryption as unknown as {
            configureAesBatchConcurrencyLimit?: (limit: number) => void;
        };
        configurable.configureAesBatchConcurrencyLimit?.(2);

        await encryption.initializeSessions(new Map([['session-configured-aes', new Uint8Array(32).fill(13)]]));
        const sessionEncryption = encryption.getSessionEncryption('session-configured-aes');
        expect(sessionEncryption).toBeTruthy();

        const encrypted = await sessionEncryption!.encryptRaw({ hello: 'configured' });
        syncPerformanceTelemetry.reset();
        expect(await sessionEncryption!.decryptRaw(encrypted)).toEqual({ hello: 'configured' });

        expect(findEvent('sync.encryption.crypto.aes.decrypt')).toMatchObject({
            fields: { concurrency: 2 },
        });
    });

    it('decrypts session snapshot metadata and agent state in one AES batch', async () => {
        const sessionEncryption = new SessionEncryption(
            'session-snapshot-batch',
            new AES256Encryption(new Uint8Array(32).fill(14)),
            new EncryptionCache(),
        );
        const encryptedMetadata = await sessionEncryption.encryptMetadata({ path: '/tmp/project', host: 'dev' });
        const encryptedAgentState = await sessionEncryption.encryptAgentState({ controlledByUser: true });
        const batchDecrypt = (sessionEncryption as unknown as {
            decryptSessionSnapshotState?: (
                metadataVersion: number,
                metadata: string,
                agentStateVersion: number,
                agentState: string | null | undefined,
            ) => Promise<{ metadata: unknown; agentState: unknown }>;
        }).decryptSessionSnapshotState;

        syncPerformanceTelemetry.reset();
        expect(batchDecrypt).toBeTypeOf('function');

        const decrypted = await sessionEncryption.decryptSessionSnapshotState(1, encryptedMetadata, 2, encryptedAgentState);

        expect(decrypted).toEqual({
            metadata: expect.objectContaining({ path: '/tmp/project', host: 'dev' }),
            agentState: expect.objectContaining({ controlledByUser: true }),
        });
        expect(findEvent('sync.encryption.decryptSessionSnapshotState')).toMatchObject({
            count: 1,
            fields: { items: 2, cached: 0, metadata: 1, agentState: 1 },
        });
        expect(findEvent('sync.encryption.decryptSessionSnapshotState.decodeCiphertext')).toMatchObject({
            count: 1,
            fields: { items: 2, metadata: 1, agentState: 1 },
        });
        expect(findEvent('sync.encryption.crypto.aes.decrypt')).toMatchObject({
            count: 1,
            fields: { items: 2 },
            fieldStats: {
                items: expect.objectContaining({ max: 2 }),
            },
        });
    });

    it('records semantic machine raw encryption operations', async () => {
        const machineEncryption = new MachineEncryption(
            'machine-telemetry',
            new AES256Encryption(new Uint8Array(32).fill(6)),
            new EncryptionCache(),
        );

        const encrypted = await machineEncryption.encryptRaw({ hello: 'machine' });
        const decrypted = await machineEncryption.decryptRaw(encrypted);

        expect(decrypted).toEqual({ hello: 'machine' });
        expect(findEvent('sync.encryption.machine.encryptRaw')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
        expect(findEvent('sync.encryption.machine.decryptRaw')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
    });

    it('records machine raw encryption attribution event names with numeric fields', async () => {
        const machineEncryption = new MachineEncryption(
            'machine-telemetry-attribution',
            new AES256Encryption(new Uint8Array(32).fill(16)),
            new EncryptionCache(),
        );
        const attributionEventName = MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS.metadataWrite;

        const encrypted = await measureMachineEncryptRawAttribution(
            attributionEventName,
            async () => await machineEncryption.encryptRaw({ hello: 'metadata-write' }),
        );

        expect(await machineEncryption.decryptRaw(encrypted)).toEqual({ hello: 'metadata-write' });
        expect(findEvent(attributionEventName)).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
        expect(findEvent('sync.encryption.machine.encryptRaw')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
        expectNumericFields(attributionEventName);
    });

    it('records artifact header and body encryption operations', async () => {
        const artifactEncryption = new ArtifactEncryption(new Uint8Array(32).fill(8));

        const encryptedHeader = await artifactEncryption.encryptHeader({ v: 1, kind: 'artifact.test', title: 'Test' });
        const encryptedBody = await artifactEncryption.encryptBody({ body: 'hello' });

        expect(await artifactEncryption.decryptHeader(encryptedHeader)).toEqual({
            v: 1,
            kind: 'artifact.test',
            title: 'Test',
        });
        expect(await artifactEncryption.decryptBody(encryptedBody)).toEqual({ body: 'hello' });
        expect(findEvent('sync.encryption.artifact.encryptHeader')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
        expect(findEvent('sync.encryption.artifact.decryptBody')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
    });
});
