import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol';

import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from './transferChunkEncryption';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import {
    createTransferSessionLifecycle,
    openDownloadTransferSession,
} from '@/transfers/core/transferSessionLifecycle';

type RelayChannel = Readonly<{
    onEnvelope: (listener: (payload: TransferRelayV2SendEnvelope) => void) => () => void;
    sendEnvelope: (payload: TransferRelayV2SendEnvelope) => void;
}>;

function createRelayChannelHarness(): Readonly<{
    channel: RelayChannel;
    sent: TransferRelayV2SendEnvelope[];
    receive: (payload: TransferRelayV2SendEnvelope) => void;
}> {
    const listeners = new Set<(payload: TransferRelayV2SendEnvelope) => void>();
    const sent: TransferRelayV2SendEnvelope[] = [];

    return {
        channel: {
            onEnvelope(listener) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
            sendEnvelope(payload) {
                sent.push(payload);
            },
        },
        sent,
        receive(payload) {
            for (const listener of listeners) {
                listener(payload);
            }
        },
    };
}

async function waitForSentEnvelope(
    sent: readonly TransferRelayV2SendEnvelope[],
    predicate: (payload: TransferRelayV2SendEnvelope) => boolean,
): Promise<TransferRelayV2SendEnvelope> {
    await vi.waitFor(() => {
        expect(sent.some(predicate)).toBe(true);
    });
    const matched = sent.find(predicate);
    if (!matched) {
        throw new Error('Expected relay envelope was not sent');
    }
    return matched;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('transferRelayV2DownloadSessionTransport', () => {
    it('streams an existing download session to a user-scoped relay client and finalizes on finish', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-relay-v2-download-session-'));
        const store = new TransferSessionStore({ ttlMs: 30_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 5 });
        const recipientKeyPair = createTransferRecipientKeyPair();

        try {
            const filePath = join(tempDir, 'hello.txt');
            await writeFile(filePath, Buffer.from('hello', 'utf8'));

            const session = await openDownloadTransferSession({
                lifecycle,
                source: {
                    filePath,
                    deleteFileOnClose: false,
                    sizeBytes: 5,
                    name: 'hello.txt',
                },
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            });

            const { registerTransferRelayV2DownloadSessionResponder } = await import('./transferRelayV2DownloadSessionTransport');
            const harness = createRelayChannelHarness();
            const unsubscribe = registerTransferRelayV2DownloadSessionResponder({
                machineId: 'machine-1',
                transferRelayChannel: harness.channel,
                resolveSessionOwner: (transferId) => (
                    store.getDownloadSession(transferId)
                        ? { store, lifecycle }
                        : null
                ),
            });

            harness.receive({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: session.downloadId,
                    kind: 'open',
                    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                },
            });

            const firstChunkEnvelope = await waitForSentEnvelope(
                harness.sent,
                (payload) => payload.envelope.transferId === session.downloadId && payload.envelope.kind === 'chunk',
            );

            expect(firstChunkEnvelope).toMatchObject({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                recipient: {
                    kind: 'user',
                },
                envelope: {
                    transferId: session.downloadId,
                    kind: 'chunk',
                    sequence: 0,
                },
            });

            if (firstChunkEnvelope.envelope.kind !== 'chunk' || !firstChunkEnvelope.envelope.encryptedDataKeyEnvelopeBase64) {
                throw new Error('Expected encrypted chunk envelope');
            }

            const decryptedChunk = decryptEncryptedTransferChunkEnvelope({
                transferId: session.downloadId,
                sequence: 0,
                payloadBase64: firstChunkEnvelope.envelope.payloadBase64,
                encryptedDataKeyEnvelopeBase64: firstChunkEnvelope.envelope.encryptedDataKeyEnvelopeBase64,
                recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            });
            expect(decryptedChunk.toString('utf8')).toBe('hello');

            harness.receive({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: session.downloadId,
                    kind: 'ack',
                    nextSequence: 1,
                },
            });

            const finishEnvelope = await waitForSentEnvelope(
                harness.sent,
                (payload) => payload.envelope.transferId === session.downloadId && payload.envelope.kind === 'finish',
            );
            expect(finishEnvelope).toMatchObject({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                recipient: {
                    kind: 'user',
                },
                envelope: {
                    transferId: session.downloadId,
                    kind: 'finish',
                    manifestHash: expect.stringMatching(/^sha256:/),
                },
            });

            await vi.waitFor(() => {
                expect(store.getDownloadSession(session.downloadId)).toBeNull();
            });

            unsubscribe();
        } finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('aborts without sending a chunk when an opened download source no longer has bytes', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-relay-v2-download-session-truncated-'));
        const store = new TransferSessionStore({ ttlMs: 30_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 5 });
        const recipientKeyPair = createTransferRecipientKeyPair();

        try {
            const filePath = join(tempDir, 'hello.txt');
            await writeFile(filePath, Buffer.from('hello', 'utf8'));
            const session = await openDownloadTransferSession({
                lifecycle,
                source: {
                    filePath,
                    deleteFileOnClose: false,
                    sizeBytes: 5,
                    name: 'hello.txt',
                },
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            });
            await truncate(filePath, 0);

            const { registerTransferRelayV2DownloadSessionResponder } = await import('./transferRelayV2DownloadSessionTransport');
            const harness = createRelayChannelHarness();
            const unsubscribe = registerTransferRelayV2DownloadSessionResponder({
                machineId: 'machine-1',
                transferRelayChannel: harness.channel,
                resolveSessionOwner: (transferId) => (
                    store.getDownloadSession(transferId)
                        ? { store, lifecycle }
                        : null
                ),
            });

            harness.receive({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: session.downloadId,
                    kind: 'open',
                    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                },
            });

            const abortEnvelope = await waitForSentEnvelope(
                harness.sent,
                (payload) => payload.envelope.transferId === session.downloadId && payload.envelope.kind === 'abort',
            );
            expect(abortEnvelope).toMatchObject({
                envelope: {
                    transferId: session.downloadId,
                    kind: 'abort',
                    reason: 'Download source ended before expected size',
                },
            });
            expect(
                harness.sent.some(
                    (payload) => payload.envelope.transferId === session.downloadId && payload.envelope.kind === 'chunk',
                ),
            ).toBe(false);
            expect(store.getDownloadSession(session.downloadId)).toBeNull();

            unsubscribe();
        } finally {
            await store.dispose();
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('resolves transfer ownership across multiple download-session stores before sending aborts', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-relay-v2-download-session-multi-'));
        const primaryStore = new TransferSessionStore({ ttlMs: 30_000 });
        const secondaryStore = new TransferSessionStore({ ttlMs: 30_000 });
        const primaryLifecycle = createTransferSessionLifecycle({ store: primaryStore, chunkSizeBytes: 5 });
        const secondaryLifecycle = createTransferSessionLifecycle({ store: secondaryStore, chunkSizeBytes: 5 });
        const recipientKeyPair = createTransferRecipientKeyPair();

        try {
            const filePath = join(tempDir, 'hello.txt');
            await writeFile(filePath, Buffer.from('hello', 'utf8'));

            const session = await openDownloadTransferSession({
                lifecycle: secondaryLifecycle,
                source: {
                    filePath,
                    deleteFileOnClose: false,
                    sizeBytes: 5,
                    name: 'hello.txt',
                },
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            });

            const { registerTransferRelayV2DownloadSessionResponder } = await import('./transferRelayV2DownloadSessionTransport');
            const harness = createRelayChannelHarness();
            const unsubscribe = registerTransferRelayV2DownloadSessionResponder({
                machineId: 'machine-1',
                transferRelayChannel: harness.channel,
                resolveSessionOwner: (transferId) => {
                    if (primaryStore.getDownloadSession(transferId)) {
                        return { store: primaryStore, lifecycle: primaryLifecycle };
                    }
                    if (secondaryStore.getDownloadSession(transferId)) {
                        return { store: secondaryStore, lifecycle: secondaryLifecycle };
                    }
                    return null;
                },
            });

            harness.receive({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: session.downloadId,
                    kind: 'open',
                    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                },
            });

            const firstChunkEnvelope = await waitForSentEnvelope(
                harness.sent,
                (payload) => payload.envelope.transferId === session.downloadId && payload.envelope.kind === 'chunk',
            );

            expect(firstChunkEnvelope.envelope.kind).toBe('chunk');
            expect(
                harness.sent.some(
                    (payload) => payload.envelope.transferId === session.downloadId && payload.envelope.kind === 'abort',
                ),
            ).toBe(false);

            unsubscribe();
        } finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });
});
