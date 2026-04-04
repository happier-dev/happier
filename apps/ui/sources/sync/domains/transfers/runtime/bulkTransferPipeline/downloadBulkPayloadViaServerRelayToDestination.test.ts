import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import type { digest as digestFn } from '@/platform/digest';
import type { resolveServerScopedTransferRelaySocket as resolveServerScopedTransferRelaySocketFn } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedTransferRelaySocket';

import { createEncryptedTransferChunkEnvelope } from './transferChunkEncryption';

const resolveServerScopedTransferRelaySocketMock = vi.hoisted(() => vi.fn<typeof resolveServerScopedTransferRelaySocketFn>());
const digestMock = vi.hoisted(() => vi.fn<typeof digestFn>(async () => Uint8Array.from(Buffer.from(
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
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
    sent: TransferRelayV2SendEnvelope[];
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
    const payloadBytes = Buffer.from('hello', 'utf8');

    const computeManifestHash = async () => {
        const digestBytes = await digestMock('SHA-256', payloadBytes);
        return `sha256:${Array.from(digestBytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    };

    return {
        sent,
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
            disconnect() {},
        },
    };
}

describe('downloadBulkPayloadViaServerRelayToDestination', () => {
    afterEach(() => {
        resolveServerScopedTransferRelaySocketMock.mockReset();
        digestMock.mockClear();
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
});
