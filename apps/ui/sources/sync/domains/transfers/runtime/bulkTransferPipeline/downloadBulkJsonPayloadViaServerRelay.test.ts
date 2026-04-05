import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import type { digest as digestFn } from '@/platform/digest';
import type { resolveServerScopedTransferRelaySocket as resolveServerScopedTransferRelaySocketFn } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedTransferRelaySocket';

import { createEncryptedTransferChunkEnvelope } from './transferChunkEncryption';

const resolveServerScopedTransferRelaySocketMock = vi.hoisted(() => vi.fn<typeof resolveServerScopedTransferRelaySocketFn>());
const digestMock = vi.hoisted(() => vi.fn<typeof digestFn>(async () => Uint8Array.from(Buffer.from(
    '914cf6b67acd6dd1dde3e9920bf44b1adf2bb1fe0503e4e4b6106e099a600477',
    'hex',
))));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedTransferRelaySocket', () => ({
    resolveServerScopedTransferRelaySocket: (
        params: Parameters<typeof resolveServerScopedTransferRelaySocketFn>[0],
    ) => resolveServerScopedTransferRelaySocketMock(params),
}));

vi.mock('@/platform/digest', () => ({
    digest: (
        algorithm: Parameters<typeof digestFn>[0],
        bytes: Parameters<typeof digestFn>[1],
    ) => digestMock(algorithm, bytes),
}));

function createRelaySocketHarness(): Readonly<{
    scopeUserId: string;
    sent: TransferRelayV2SendEnvelope[];
    disconnect: ReturnType<typeof vi.fn>;
    socket: Readonly<{
        scopeUserId: string;
        machineId: string;
        onEnvelope: (listener: (payload: TransferRelayV2SendEnvelope) => void) => () => void;
        sendEnvelope: (payload: TransferRelayV2SendEnvelope) => void;
        disconnect: () => void;
    }>;
}> {
    const listeners = new Set<(payload: TransferRelayV2SendEnvelope) => void>();
    const sent: TransferRelayV2SendEnvelope[] = [];
    const disconnect = vi.fn();
    const payloadBytes = Buffer.from(JSON.stringify({
        ok: true,
        title: 'Relay payload',
    }), 'utf8');

    const computeManifestHash = async () => {
        const digestBytes = await digestMock('SHA-256', payloadBytes);
        return `sha256:${Array.from(digestBytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    };

    return {
        scopeUserId: 'user-1',
        sent,
        disconnect,
        socket: {
            scopeUserId: 'user-1',
            machineId: 'machine-1',
            onEnvelope(listener) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
            sendEnvelope(payload) {
                sent.push(payload);
                if (payload.envelope.kind === 'open') {
                    const recipientPublicKeyBase64 = payload.envelope.recipientPublicKeyBase64;
                    void (async () => {
                        const encryptedChunk = await createEncryptedTransferChunkEnvelope({
                            transferId: payload.envelope.transferId,
                            sequence: 0,
                            payload: payloadBytes,
                            recipientPublicKeyBase64,
                        });
                        for (const listener of listeners) {
                            listener({
                                scopeUserId: payload.scopeUserId,
                                sender: {
                                    kind: 'machine',
                                    machineId: 'machine-1',
                                },
                                recipient: {
                                    kind: 'user',
                                },
                                envelope: {
                                    transferId: payload.envelope.transferId,
                                    kind: 'chunk',
                                    sequence: 0,
                                    payloadBase64: encryptedChunk.payloadBase64,
                                    encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
                                },
                            });
                        }
                    })();
                }
                if (payload.envelope.kind === 'ack') {
                    setTimeout(() => {
                        void computeManifestHash().then((manifestHash) => {
                            for (const listener of listeners) {
                                listener({
                                    scopeUserId: payload.scopeUserId,
                                    sender: {
                                        kind: 'machine',
                                        machineId: 'machine-1',
                                    },
                                    recipient: {
                                        kind: 'user',
                                    },
                                    envelope: {
                                        transferId: payload.envelope.transferId,
                                        kind: 'finish',
                                        manifestHash,
                                    },
                                });
                            }
                        });
                    }, 0);
                }
            },
            disconnect,
        },
    };
}

describe('downloadBulkJsonPayloadViaServerRelay', () => {
    afterEach(() => {
        vi.useRealTimers();
        resolveServerScopedTransferRelaySocketMock.mockReset();
        digestMock.mockClear();
    });

    it('downloads and parses a JSON payload over the server relay socket', async () => {
        const harness = createRelaySocketHarness();
        resolveServerScopedTransferRelaySocketMock.mockResolvedValue(harness.socket);
        const initMock = vi.fn(async () => ({
            success: true as const,
            downloadId: 'download-1',
            chunkSizeBytes: 4096,
            sizeBytes: 33,
            name: 'payload.json',
        }));
        const finalizeMock = vi.fn(async () => ({ success: true as const }));

        const { downloadBulkJsonPayloadViaServerRelay } = await import('./downloadBulkJsonPayloadViaServerRelay');
        const result = await downloadBulkJsonPayloadViaServerRelay({
            machineId: 'machine-1',
            serverId: 'server-a',
            init: initMock,
            finalize: finalizeMock,
            parsePayload: (value) => value as { ok: boolean; title: string },
        });

        expect(result).toEqual({
            ok: true,
            payload: {
                ok: true,
                title: 'Relay payload',
            },
        });
        expect(harness.disconnect).toHaveBeenCalledTimes(1);
        expect(initMock).toHaveBeenCalledWith({
            recipientPublicKeyBase64: expect.any(String),
        });
        expect(finalizeMock).toHaveBeenCalledWith({
            downloadId: 'download-1',
        });
        expect(digestMock).toHaveBeenCalled();
        expect(harness.sent[0]).toMatchObject({
            scopeUserId: 'user-1',
            sender: {
                kind: 'user',
            },
            recipient: {
                kind: 'machine',
                machineId: 'machine-1',
            },
            envelope: {
                transferId: 'download-1',
                kind: 'open',
                recipientPublicKeyBase64: expect.any(String),
            },
        });
        expect(harness.sent[1]).toMatchObject({
            scopeUserId: 'user-1',
            sender: {
                kind: 'user',
            },
            recipient: {
                kind: 'machine',
                machineId: 'machine-1',
            },
            envelope: {
                transferId: 'download-1',
                kind: 'ack',
                nextSequence: 1,
            },
        });
    });

    it('aborts the server-side download session when the relay payload cannot be parsed', async () => {
        const harness = createRelaySocketHarness();
        resolveServerScopedTransferRelaySocketMock.mockResolvedValue(harness.socket);
        const abortMock = vi.fn(async () => ({ success: true as const }));

        const { downloadBulkJsonPayloadViaServerRelay } = await import('./downloadBulkJsonPayloadViaServerRelay');
        const result = await downloadBulkJsonPayloadViaServerRelay({
            machineId: 'machine-1',
            serverId: 'server-a',
            init: async () => ({
                success: true as const,
                downloadId: 'download-parse-fail',
                chunkSizeBytes: 4096,
                sizeBytes: 33,
                name: 'payload.json',
            }),
            finalize: async () => ({ success: true as const }),
            abort: abortMock,
            parsePayload: () => null,
        });

        expect(result).toEqual({
            ok: false,
            error: 'Downloaded transfer payload returned an unsupported response',
        });
        expect(abortMock).toHaveBeenCalledWith({
            downloadId: 'download-parse-fail',
        });
    });

    it('aborts the relay download if the transfer timeout elapses before completion', async () => {
        vi.useFakeTimers();
        const listeners = new Set<(payload: TransferRelayV2SendEnvelope) => void>();
        const sent: TransferRelayV2SendEnvelope[] = [];
        const disconnect = vi.fn();
        resolveServerScopedTransferRelaySocketMock.mockResolvedValue({
            scopeUserId: 'user-1',
            machineId: 'machine-1',
            onEnvelope(listener) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
            sendEnvelope(payload) {
                sent.push(payload);
            },
            disconnect,
        });
        const abortMock = vi.fn(async () => ({ success: true as const }));

        const { downloadBulkJsonPayloadViaServerRelay } = await import('./downloadBulkJsonPayloadViaServerRelay');
        const downloadPromise = downloadBulkJsonPayloadViaServerRelay({
            machineId: 'machine-1',
            serverId: 'server-a',
            timeoutMs: 10,
            init: async () => ({
                success: true as const,
                downloadId: 'download-timeout',
                chunkSizeBytes: 4096,
                sizeBytes: 33,
                name: 'payload.json',
            }),
            finalize: async () => ({ success: true as const }),
            abort: abortMock,
            parsePayload: (value) => value as { ok: boolean },
        });

        await vi.advanceTimersByTimeAsync(10);

        await expect(downloadPromise).resolves.toEqual({
            ok: false,
            error: 'Server relay transfer timed out',
        });
        expect(abortMock).toHaveBeenCalledWith({
            downloadId: 'download-timeout',
        });
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([
            expect.objectContaining({
                envelope: {
                    transferId: 'download-timeout',
                    kind: 'open',
                    recipientPublicKeyBase64: expect.any(String),
                },
            }),
        ]);
        expect(listeners.size).toBe(0);
    });
});
