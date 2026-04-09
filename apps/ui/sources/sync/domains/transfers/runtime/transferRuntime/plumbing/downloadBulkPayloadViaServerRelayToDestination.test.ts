import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHash } from 'node:crypto';

import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import type { resolveServerScopedTransferRelaySocket as resolveServerScopedTransferRelaySocketFn } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedTransferRelaySocket';

import { createEncryptedTransferChunkEnvelope } from './transferChunkEncryption';

const resolveServerScopedTransferRelaySocketMock = vi.hoisted(() => vi.fn<typeof resolveServerScopedTransferRelaySocketFn>());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedTransferRelaySocket', () => ({
    resolveServerScopedTransferRelaySocket: (
        params: Parameters<typeof resolveServerScopedTransferRelaySocketFn>[0],
    ) => resolveServerScopedTransferRelaySocketMock(params),
}));

function createRelaySocketHarness(): Readonly<{
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
    const payloadBytes = Buffer.from('hello', 'utf8');

    const computeManifestHash = async () => {
        const hex = createHash('sha256').update(payloadBytes).digest('hex');
        return `sha256:${hex}`;
    };

    return {
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

describe('downloadBulkPayloadViaServerRelayToDestination', () => {
    afterEach(() => {
        vi.useRealTimers();
        resolveServerScopedTransferRelaySocketMock.mockReset();
    });

    it('downloads an encrypted file payload over the server relay socket and closes the destination', async () => {
        const harness = createRelaySocketHarness();
        resolveServerScopedTransferRelaySocketMock.mockResolvedValue(harness.socket);
        const written: Uint8Array[] = [];
        const close = vi.fn(async () => {});
        const cleanup = vi.fn(async () => {});
        const initMock = vi.fn(async () => ({
            success: true as const,
            downloadId: 'download-1',
            chunkSizeBytes: 4096,
            sizeBytes: 5,
            name: 'hello.txt',
        }));
        const finalizeMock = vi.fn(async () => ({ success: true as const }));

        const { downloadBulkPayloadViaServerRelayToDestination } = await import('./downloadBulkPayloadViaServerRelayToDestination');
        const result = await downloadBulkPayloadViaServerRelayToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            destination: {
                writeBytes: async (bytes) => {
                    written.push(new Uint8Array(bytes));
                },
                close,
                cleanup,
            },
            init: initMock,
            finalize: finalizeMock,
        });

        expect(result).toEqual({
            ok: true,
            name: 'hello.txt',
            sizeBytes: 5,
        });
        expect(new TextDecoder().decode(Uint8Array.from(written.flatMap((chunk) => Array.from(chunk))))).toBe('hello');
        expect(initMock).toHaveBeenCalledWith({
            recipientPublicKeyBase64: expect.any(String),
        });
        expect(finalizeMock).toHaveBeenCalledWith({
            downloadId: 'download-1',
        });
        expect(close).toHaveBeenCalledTimes(1);
        expect(cleanup).not.toHaveBeenCalled();
        expect(harness.disconnect).toHaveBeenCalledTimes(1);
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

    it('aborts and cleans up the destination when finalize fails', async () => {
        const harness = createRelaySocketHarness();
        resolveServerScopedTransferRelaySocketMock.mockResolvedValue(harness.socket);
        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const abortMock = vi.fn(async () => ({ success: true as const }));
        const initMock = vi.fn(async () => ({
            success: true as const,
            downloadId: 'download-finalize-fail',
            chunkSizeBytes: 4096,
            sizeBytes: 5,
            name: 'hello.txt',
        }));
        const finalizeMock = vi.fn(async () => ({ success: false as const, error: 'finalize failed' }));

        const { downloadBulkPayloadViaServerRelayToDestination } = await import('./downloadBulkPayloadViaServerRelayToDestination');
        const result = await downloadBulkPayloadViaServerRelayToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
            init: initMock,
            finalize: finalizeMock,
            abort: abortMock,
        });

        expect(result).toEqual({
            ok: false,
            error: 'finalize failed',
        });
        expect(abortMock).toHaveBeenCalledWith({
            downloadId: 'download-finalize-fail',
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });

    it('aborts and cleans up the destination when the init callback throws', async () => {
        const harness = createRelaySocketHarness();
        resolveServerScopedTransferRelaySocketMock.mockResolvedValue(harness.socket);
        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const abortMock = vi.fn(async () => ({ success: true as const }));
        const initMock = vi.fn(async () => ({
            success: true as const,
            downloadId: 'download-init-throws',
            chunkSizeBytes: 4096,
            sizeBytes: 5,
            name: 'hello.txt',
        }));

        const { downloadBulkPayloadViaServerRelayToDestination } = await import('./downloadBulkPayloadViaServerRelayToDestination');
        const resultPromise = downloadBulkPayloadViaServerRelayToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
            init: initMock,
            finalize: async () => ({ success: true as const }),
            abort: abortMock,
            onInit: async () => {
                throw new Error('relay init callback exploded');
            },
        });

        await expect(resultPromise).resolves.toEqual({
            ok: false,
            error: 'relay init callback exploded',
        });
        expect(initMock).toHaveBeenCalledTimes(1);
        expect(abortMock).toHaveBeenCalledWith({
            downloadId: 'download-init-throws',
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });

    it('aborts and cleans up the destination when the init callback fails closed', async () => {
        const harness = createRelaySocketHarness();
        resolveServerScopedTransferRelaySocketMock.mockResolvedValue(harness.socket);
        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const abortMock = vi.fn(async () => ({ success: true as const }));
        const initMock = vi.fn(async () => ({
            success: true as const,
            downloadId: 'download-init-fail-closed',
            chunkSizeBytes: 4096,
            sizeBytes: 5,
            name: 'hello.txt',
        }));

        const { downloadBulkPayloadViaServerRelayToDestination } = await import('./downloadBulkPayloadViaServerRelayToDestination');
        const resultPromise = downloadBulkPayloadViaServerRelayToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
            init: initMock,
            finalize: async () => ({ success: true as const }),
            abort: abortMock,
            onInit: async () => ({
                success: false as const,
                error: 'too big',
            }),
        });

        await expect(resultPromise).resolves.toEqual({
            ok: false,
            error: 'too big',
        });
        expect(initMock).toHaveBeenCalledTimes(1);
        expect(abortMock).toHaveBeenCalledWith({
            downloadId: 'download-init-fail-closed',
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });

    it('aborts and cleans up the destination if the relay transfer times out before completion', async () => {
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
        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const abortMock = vi.fn(async () => ({ success: true as const }));

        const { downloadBulkPayloadViaServerRelayToDestination } = await import('./downloadBulkPayloadViaServerRelayToDestination');
        const downloadPromise = downloadBulkPayloadViaServerRelayToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            timeoutMs: 10,
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
            init: async () => ({
                success: true as const,
                downloadId: 'download-timeout',
                chunkSizeBytes: 4096,
                sizeBytes: 5,
                name: 'hello.txt',
            }),
            finalize: async () => ({ success: true as const }),
            abort: abortMock,
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
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
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

    it('passes a normalized timeout to the relay socket resolver', async () => {
        const harness = createRelaySocketHarness();
        resolveServerScopedTransferRelaySocketMock.mockResolvedValue(harness.socket);
        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});

        const { downloadBulkPayloadViaServerRelayToDestination } = await import('./downloadBulkPayloadViaServerRelayToDestination');
        const result = await downloadBulkPayloadViaServerRelayToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            timeoutMs: 0,
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
            init: async () => ({
                success: true as const,
                downloadId: 'download-timeout-normalized',
                chunkSizeBytes: 4096,
                sizeBytes: 5,
                name: 'hello.txt',
            }),
            finalize: async () => ({ success: true as const }),
        });

        expect(result).toEqual({
            ok: true,
            name: 'hello.txt',
            sizeBytes: 5,
        });
        expect(resolveServerScopedTransferRelaySocketMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-a',
        });
        expect(close).toHaveBeenCalledTimes(1);
        expect(cleanup).not.toHaveBeenCalled();
        expect(harness.disconnect).toHaveBeenCalledTimes(1);
    });

    it('aborts and cleans up the destination when the relay emits an abort envelope', async () => {
        vi.useFakeTimers();
        const listeners = new Set<(payload: TransferRelayV2SendEnvelope) => void>();
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
            sendEnvelope() {},
            disconnect,
        });

        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const abortMock = vi.fn(async () => ({ success: true as const }));

        const { downloadBulkPayloadViaServerRelayToDestination } = await import('./downloadBulkPayloadViaServerRelayToDestination');
        const downloadPromise = downloadBulkPayloadViaServerRelayToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
            init: async () => ({
                success: true as const,
                downloadId: 'download-abort',
                chunkSizeBytes: 4096,
                sizeBytes: 5,
                name: 'hello.txt',
            }),
            finalize: async () => ({ success: true as const }),
            abort: abortMock,
        });

        await vi.advanceTimersByTimeAsync(0);
        for (const listener of listeners) {
            listener({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                recipient: {
                    kind: 'user',
                },
                envelope: {
                    transferId: 'download-abort',
                    kind: 'abort',
                    reason: 'relay aborted',
                },
            });
        }

        await expect(downloadPromise).resolves.toEqual({
            ok: false,
            error: 'relay aborted',
        });
        expect(abortMock).toHaveBeenCalledWith({
            downloadId: 'download-abort',
        });
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });
});
