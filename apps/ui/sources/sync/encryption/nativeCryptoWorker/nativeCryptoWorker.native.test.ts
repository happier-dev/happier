import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
} from './types';

const nativeModuleMock = vi.hoisted(() => ({
    requireNativeModule: vi.fn(),
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: nativeModuleMock.requireNativeModule,
}));

describe('createNativeCryptoWorker native', () => {
    beforeEach(() => {
        vi.resetModules();
        nativeModuleMock.requireNativeModule.mockReset();
    });

    it('reports unavailable when the Expo module is missing', async () => {
        nativeModuleMock.requireNativeModule.mockImplementationOnce(() => {
            throw new Error('missing module');
        });
        const { createNativeCryptoWorker } = await import('./nativeCryptoWorker.native');

        expect(await createNativeCryptoWorker().probe()).toEqual({
            available: false,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing,
        });
    });

    it('maps diagnostic echo failures to numeric failure reasons', async () => {
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({
            getCapabilities: async () => ({ moduleVersion: 1, supportedOperations: [], platform: 'android' }),
            echoBatchForDiagnostics: async () => ['wrong'],
        });
        const { createNativeCryptoWorker } = await import('./nativeCryptoWorker.native');

        expect(await createNativeCryptoWorker().probe()).toEqual({
            available: false,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.echoFailed,
        });
    });

    it('reports native availability with version and warmup fields', async () => {
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({
            getCapabilities: async () => ({
                moduleVersion: 1,
                supportedOperations: [
                    'decryptDataKeyEnvelopeV1',
                    'decryptSecretboxJson',
                    'unknownOperation',
                ],
                platform: 'ios',
            }),
            echoBatchForDiagnostics: async (values: readonly string[]) => values,
        });
        const { createNativeCryptoWorker } = await import('./nativeCryptoWorker.native');

        expect(await createNativeCryptoWorker().probe()).toEqual({
            available: true,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
            nativeVersion: 1,
            warmupMs: expect.any(Number),
            supportedOperations: [
                NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
                NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson,
            ],
        });
    });

    it('routes data-key envelope batches to the native module', async () => {
        const decryptDataKeyEnvelopeV1Batch = vi.fn(async () => ['opened-key', null]);
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({
            getCapabilities: async () => ({ moduleVersion: 1, supportedOperations: ['decryptDataKeyEnvelopeV1'], platform: 'android' }),
            echoBatchForDiagnostics: async (values: readonly string[]) => values,
            decryptDataKeyEnvelopeV1Batch,
        });
        const { createNativeCryptoWorker } = await import('./nativeCryptoWorker.native');

        const request = {
            scope: { accountId: 'account', serverId: 'server', generation: 1 },
            items: [
                { envelopeBase64: 'envelope-1', recipientSecretKeyOrSeedBase64: 'secret-1' },
                { envelopeBase64: 'envelope-2', recipientSecretKeyOrSeedBase64: 'secret-2' },
            ],
        };
        await expect(createNativeCryptoWorker().decryptDataKeyEnvelopeV1(request)).resolves.toEqual({
            status: 'ok',
            source: 'native',
            items: ['opened-key', null],
        });
        expect(decryptDataKeyEnvelopeV1Batch).toHaveBeenCalledWith(request.items);
    });

    it('routes secretbox JSON batches to the native module and parses per-item results', async () => {
        const decryptSecretboxJsonBatch = vi.fn(async () => [
            '{"__happierSerializedJsonValueV1":true,"type":"json","value":{"ok":true}}',
            null,
            '{"__happierSerializedJsonValueV1":true,"type":"undefined"}',
            '{',
        ]);
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({
            getCapabilities: async () => ({ moduleVersion: 1, supportedOperations: ['decryptSecretboxJson'], platform: 'ios' }),
            echoBatchForDiagnostics: async (values: readonly string[]) => values,
            decryptSecretboxJsonBatch,
        });
        const { createNativeCryptoWorker } = await import('./nativeCryptoWorker.native');

        const request = {
            scope: { accountId: 'account', serverId: 'server', generation: 1 },
            items: [
                { ciphertextBase64: 'ciphertext-1', keyBase64: 'key-1' },
                { ciphertextBase64: 'ciphertext-2', keyBase64: 'key-2' },
                { ciphertextBase64: 'ciphertext-3', keyBase64: 'key-3' },
                { ciphertextBase64: 'ciphertext-4', keyBase64: 'key-4' },
            ],
        };

        await expect(createNativeCryptoWorker().decryptSecretboxJson(request)).resolves.toEqual({
            status: 'ok',
            source: 'native',
            items: [{ ok: true }, null, undefined, null],
        });
        expect(decryptSecretboxJsonBatch).toHaveBeenCalledWith(request.items);
    });

    it('routes AES-GCM JSON batches to the native module and parses per-item results', async () => {
        const decryptAesGcmJsonBatch = vi.fn(async () => [
            '{"__happierSerializedJsonValueV1":true,"type":"json","value":["x",1]}',
            null,
            '{"__happierSerializedJsonValueV1":true,"type":"json","value":null}',
        ]);
        nativeModuleMock.requireNativeModule.mockReturnValueOnce({
            getCapabilities: async () => ({ moduleVersion: 1, supportedOperations: ['decryptAesGcmJson'], platform: 'android' }),
            echoBatchForDiagnostics: async (values: readonly string[]) => values,
            decryptAesGcmJsonBatch,
        });
        const { createNativeCryptoWorker } = await import('./nativeCryptoWorker.native');

        const request = {
            scope: { accountId: 'account', serverId: null, generation: 2 },
            items: [
                { encryptedPayloadBase64: 'payload-1', keyBase64: 'key-1' },
                { encryptedPayloadBase64: 'payload-2', keyBase64: 'key-2' },
                { encryptedPayloadBase64: 'payload-3', keyBase64: 'key-3' },
            ],
        };

        await expect(createNativeCryptoWorker().decryptAesGcmJson(request)).resolves.toEqual({
            status: 'ok',
            source: 'native',
            items: [['x', 1], null, null],
        });
        expect(decryptAesGcmJsonBatch).toHaveBeenCalledWith(request.items);
    });
});
