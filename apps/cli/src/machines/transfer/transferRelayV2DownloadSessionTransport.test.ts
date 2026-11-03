import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { z } from 'zod/mini';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { createFilesystemOwnerRpcContext } from '@/rpc/handlers/fileSystem.testkit';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem/registerFileSystemHandlers';
import { runFilesystemEffectInternal } from '@/rpc/handlers/fileSystem/filesystemEffectInternal';
import { createFilesystemEffectChannel, createFilesystemEffectRpcOwner,
    initializeFilesystemEffectChannel } from '@/rpc/handlers/fileSystem/filesystemEffectChannel';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol';

import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import {
    createTransferSessionLifecycle,
    openDownloadTransferSession,
} from '@happier-dev/transfers/node';

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
    it('streams a retained native download only for its admitted requester and closes the native process after final ACK', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-native-relay-'));
        const bytes = Buffer.from([0, 255, 128, 1]);
        await writeFile(join(root, 'payload.dat'), bytes);
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const running = runFilesystemEffectInternal(stdin, stdout);
        let closed = false;
        const channel = createFilesystemEffectChannel({ input: stdin, output: stdout,
            dispose: async () => { await running; closed = true; } });
        await initializeFilesystemEffectChannel(channel, { workingDirectory: root, accessPolicy: { kind: 'restrictedRoots', roots: [root] } });
        const context = createFilesystemOwnerRpcContext();
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        const registration = registerFileSystemHandlers({ registerHandler(method, handler) {
            handlers.set(method, handler as RpcHandler<unknown, unknown>);
        } }, root, { prepareNativeTransfer: async () => createFilesystemEffectRpcOwner(channel, async raw => {
            const scopeUserId: unknown = raw && typeof raw === 'object' ? Reflect.get(raw, 'scopeUserId') : undefined;
            const admission: unknown = raw && typeof raw === 'object' ? Reflect.get(raw, 'machineAdmission') : undefined;
            const requester: unknown = scopeUserId ?? (admission && typeof admission === 'object' ? Reflect.get(admission, 'actorAccountId') : undefined);
            if (requester !== context.machineAdmission?.actorAccountId) throw Object.assign(new Error('Different native transfer requester'), { code: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH' });
        }, () => {}) });
        const recipient = createTransferRecipientKeyPair();
        const init = handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
        if (!init) throw new Error('Missing native download init');
        const download = z.object({ success: z.literal(true), downloadId: z.string() }).parse(await init({
            t: 'session_file_download_v1', path: 'payload.dat', recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        }, context));
        const { registerTransferRelayV2DownloadSessionResponder } = await import('./transferRelayV2DownloadSessionTransport');
        const harness = createRelayChannelHarness();
        const lifecycle = createTransferSessionLifecycle({ store: registration.transferSessionStore, chunkSizeBytes: 5 });
        const unsubscribe = registerTransferRelayV2DownloadSessionResponder({ machineId: 'machine-1', transferRelayChannel: harness.channel,
            resolveSessionOwner: transferId => registration.transferSessionStore.hasNativeSession('download', transferId)
                ? { store: registration.transferSessionStore, lifecycle } : null });
        const incoming = (scopeUserId: string, envelope: TransferRelayV2SendEnvelope['envelope']): TransferRelayV2SendEnvelope => ({
            scopeUserId, sender: { kind: 'user' }, recipient: { kind: 'machine', machineId: 'machine-1' }, envelope,
        });
        try {
            harness.receive(incoming('other-requester', { kind: 'open', transferId: download.downloadId, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 }));
            const denied = await waitForSentEnvelope(harness.sent, message => message.scopeUserId === 'other-requester' && message.envelope.kind === 'abort');
            expect(denied.envelope).toMatchObject({ reason: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH' });
            expect(registration.transferSessionStore.hasNativeSession('download', download.downloadId)).toBe(true);
            harness.receive(incoming('account', { kind: 'open', transferId: download.downloadId, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 }));
            const chunk = await waitForSentEnvelope(harness.sent, message => message.scopeUserId === 'account' && message.envelope.kind === 'chunk');
            if (chunk.envelope.kind !== 'chunk' || !chunk.envelope.encryptedDataKeyEnvelopeBase64) throw new Error('Expected encrypted native chunk');
            expect(decryptEncryptedTransferChunkEnvelope({ transferId: download.downloadId, sequence: chunk.envelope.sequence,
                payloadBase64: chunk.envelope.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.envelope.encryptedDataKeyEnvelopeBase64,
                recipientSecretKeySeed: recipient.recipientSecretKeySeed })).toEqual(bytes);
            harness.receive(incoming('account', { kind: 'ack', transferId: download.downloadId, nextSequence: 1 }));
            const finish = await waitForSentEnvelope(harness.sent, message => message.envelope.kind === 'finish');
            expect(finish.envelope).toMatchObject({ manifestHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
            expect(closed).toBe(true);
            expect(registration.transferSessionStore.hasNativeSession('download', download.downloadId)).toBe(false);
        } finally { unsubscribe(); await registration.dispose(); await channel.dispose(); await rm(root, { recursive: true, force: true }); }
    });

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
                scopeUserId: 'user-1',
                sender: { kind: 'machine', machineId: 'machine-1' },
                recipient: { kind: 'user' },
                envelope: {
                    transferId: session.downloadId,
                    kind: 'abort',
                    reason: 'transfer_failed',
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
