import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { z } from 'zod/mini';

import {
    abortDownloadTransferSession,
    finalizeDownloadTransferSession,
    readDownloadTransferChunk,
    type TransferSessionLifecycle,
} from '@happier-dev/transfers/node';
import { type TransferSessionStore } from '@happier-dev/transfers/node';

import { createFileTransferPayloadSource, resolveTransferPayloadManifestHash } from './transferPayloadSource';
import { readFilesystemTransferErrorCode } from './preparedFilesystemTransferScope';
import type { NativeTransferDownloadDescription } from '@happier-dev/transfers/node';

const nativeChunkSchema = z.union([z.strictObject({ success: z.literal(true), contentBase64: z.string(), isLast: z.boolean() }),
    z.strictObject({ success: z.literal(true), payloadBase64: z.string(), encryptedDataKeyEnvelopeBase64: z.string(), isLast: z.boolean() }),
    z.object({ success: z.literal(false), error: z.string() })]);

async function readNativeChunk(owner: TransferRelayV2DownloadSessionOwner, downloadId: string) {
    const retained = owner.store.beginNativeSessionOperation('download', downloadId);
    if (!retained) return null;
    try {
        if (!retained.owner.describeDownload) throw new Error('Native download metadata is unavailable');
        const session = await retained.owner.describeDownload(downloadId, false);
        const chunk = nativeChunkSchema.parse(await retained.owner.invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
            { downloadId, index: session.nextIndex }));
        owner.store.refreshDownloadExpiry(downloadId);
        return { chunkIndex: session.nextIndex, chunk };
    } finally { retained.release(); }
}

async function closeOwnedDownload(owner: TransferRelayV2DownloadSessionOwner, downloadId: string, abort: boolean): Promise<void> {
    const retained = owner.store.beginNativeSessionOperation('download', downloadId);
    if (retained) {
        try { await owner.store.closeDownloadSession(downloadId); }
        finally { retained.release(); }
        return;
    }
    if (abort) await abortDownloadTransferSession({ lifecycle: owner.lifecycle, downloadId });
    else await finalizeDownloadTransferSession({ lifecycle: owner.lifecycle, downloadId });
}

type TransferRelayV2DownloadChannel = Readonly<{
    onEnvelope: (listener: (payload: TransferRelayV2SendEnvelope) => void) => () => void;
    sendEnvelope: (payload: TransferRelayV2SendEnvelope) => void;
}>;

export type TransferRelayV2DownloadSessionOwner = Readonly<{
    store: TransferSessionStore;
    lifecycle: TransferSessionLifecycle;
}>;

type ActiveDownloadTransfer = Readonly<{
    scopeUserId: string;
    manifestHash: string;
    awaitingAckSequence: number | null;
    owner: TransferRelayV2DownloadSessionOwner;
}>;

type TransferRelayV2Envelope = TransferRelayV2SendEnvelope['envelope'];

function buildMachineToUserEnvelope(params: Readonly<{
    machineId: string;
    scopeUserId: string;
    envelope: TransferRelayV2Envelope;
}>): TransferRelayV2SendEnvelope {
    return {
        scopeUserId: params.scopeUserId,
        sender: {
            kind: 'machine',
            machineId: params.machineId,
        },
        recipient: {
            kind: 'user',
        },
        envelope: params.envelope,
    };
}

export function registerTransferRelayV2DownloadSessionResponder(params: Readonly<{
    machineId: string;
    transferRelayChannel: TransferRelayV2DownloadChannel;
    resolveSessionOwner: (transferId: string) => TransferRelayV2DownloadSessionOwner | null;
}>): () => void {
    const activeTransfers = new Map<string, ActiveDownloadTransfer>();

    const sendAbort = async (input: Readonly<{
        scopeUserId: string;
        transferId: string;
        reason: string;
        closeSession?: boolean;
        owner?: TransferRelayV2DownloadSessionOwner | null;
    }>): Promise<void> => {
        activeTransfers.delete(input.transferId);
        if (input.closeSession === true && input.owner) {
            await closeOwnedDownload(input.owner, input.transferId, true);
        }
        params.transferRelayChannel.sendEnvelope(buildMachineToUserEnvelope({
            machineId: params.machineId,
            scopeUserId: input.scopeUserId,
            envelope: {
                transferId: input.transferId,
                kind: 'abort',
                reason: input.reason,
            },
        }));
    };

    const sendNextChunk = async (input: Readonly<{
        transferId: string;
        scopeUserId: string;
        manifestHash: string;
        owner: TransferRelayV2DownloadSessionOwner;
    }>): Promise<void> => {
        const nativeChunk = await readNativeChunk(input.owner, input.transferId);
        const session = input.owner.store.getDownloadSession(input.transferId);
        if (!session && !nativeChunk) {
            await sendAbort({
                transferId: input.transferId,
                scopeUserId: input.scopeUserId,
                reason: 'transfer_not_found',
            });
            return;
        }

        const next = nativeChunk ?? (session ? { chunkIndex: session.nextIndex,
            chunk: await readDownloadTransferChunk({ lifecycle: input.owner.lifecycle,
                downloadId: input.transferId, index: session.nextIndex }) } : null);
        if (!next) return;
        const { chunkIndex, chunk } = next;
        if (chunk.success !== true || !('payloadBase64' in chunk) || !chunk.encryptedDataKeyEnvelopeBase64) {
            await sendAbort({
                transferId: input.transferId,
                scopeUserId: input.scopeUserId,
                reason: chunk.success !== true ? chunk.error : 'encrypted_chunk_required',
                closeSession: true,
                owner: input.owner,
            });
            return;
        }

        const awaitingAckSequence = chunkIndex;
        activeTransfers.set(input.transferId, {
            scopeUserId: input.scopeUserId,
            manifestHash: input.manifestHash,
            awaitingAckSequence: chunk.isLast ? awaitingAckSequence : null,
            owner: input.owner,
        });
        params.transferRelayChannel.sendEnvelope(buildMachineToUserEnvelope({
            machineId: params.machineId,
            scopeUserId: input.scopeUserId,
            envelope: {
                transferId: input.transferId,
                kind: 'chunk',
                sequence: awaitingAckSequence,
                payloadBase64: chunk.payloadBase64,
                encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64,
            },
        }));
    };

    return params.transferRelayChannel.onEnvelope((payload) => {
        void (async () => {
            if (payload.sender.kind !== 'user') {
                return;
            }
            if (payload.recipient.kind !== 'machine' || payload.recipient.machineId !== params.machineId) {
                return;
            }

            const { envelope } = payload;
            if (envelope.kind === 'open') {
                const owner = params.resolveSessionOwner(envelope.transferId);
                if (!owner) {
                    await sendAbort({
                        transferId: envelope.transferId,
                        scopeUserId: payload.scopeUserId,
                        reason: 'transfer_not_found',
                    });
                    return;
                }
                const session = owner.store.getDownloadSession(envelope.transferId);
                const retained = owner.store.beginNativeSessionOperation('download', envelope.transferId);
                let nativeSession: NativeTransferDownloadDescription | undefined;
                if (retained) {
                    try {
                        await retained.owner.verifyInvocation(payload);
                        if (!retained.owner.describeDownload) throw new Error('Native download metadata is unavailable');
                        nativeSession = await retained.owner.describeDownload(envelope.transferId, true);
                    } catch (error) {
                        await sendAbort({ transferId: envelope.transferId, scopeUserId: payload.scopeUserId,
                            reason: readFilesystemTransferErrorCode(error, 'transfer_not_found') });
                        return;
                    } finally { retained.release(); }
                }
                if (!session && !nativeSession) {
                    await sendAbort({
                        transferId: envelope.transferId,
                        scopeUserId: payload.scopeUserId,
                        reason: 'transfer_not_found',
                    });
                    return;
                }
                if (
                    typeof (nativeSession?.recipientPublicKeyBase64 ?? session?.recipientPublicKeyBase64) === 'string'
                    && (nativeSession?.recipientPublicKeyBase64 ?? session?.recipientPublicKeyBase64) !== envelope.recipientPublicKeyBase64
                ) {
                    await sendAbort({
                        transferId: envelope.transferId,
                        scopeUserId: payload.scopeUserId,
                        reason: 'recipient_public_key_mismatch',
                        closeSession: true,
                        owner,
                    });
                    return;
                }

                let manifestHash: string;
                try {
                    if (nativeSession) {
                        if (!nativeSession.manifestHash) throw new Error('Native download hash is unavailable');
                        manifestHash = nativeSession.manifestHash;
                    } else {
                        if (!session) throw new Error('Download is unavailable');
                        manifestHash = await resolveTransferPayloadManifestHash(createFileTransferPayloadSource({
                            filePath: session.filePath, sizeBytes: session.sizeBytes,
                        }));
                    }
                } catch {
                    // The admitted owner is already known, but no active transfer
                    // exists yet for the ordinary streaming failure handler.
                    await sendAbort({
                        transferId: envelope.transferId,
                        scopeUserId: payload.scopeUserId,
                        reason: 'transfer_failed',
                        closeSession: true,
                        owner,
                    });
                    return;
                }
                activeTransfers.set(envelope.transferId, {
                    scopeUserId: payload.scopeUserId,
                    manifestHash,
                    awaitingAckSequence: null,
                    owner,
                });
                await sendNextChunk({
                    transferId: envelope.transferId,
                    scopeUserId: payload.scopeUserId,
                    manifestHash,
                    owner,
                });
                return;
            }

            const active = activeTransfers.get(envelope.transferId);
            if (!active || active.scopeUserId !== payload.scopeUserId) {
                return;
            }

            if (envelope.kind === 'abort') {
                activeTransfers.delete(envelope.transferId);
                await closeOwnedDownload(active.owner, envelope.transferId, true);
                return;
            }

            if (envelope.kind !== 'ack') {
                return;
            }

            if (
                typeof active.awaitingAckSequence === 'number'
                && envelope.nextSequence === active.awaitingAckSequence + 1
            ) {
                activeTransfers.delete(envelope.transferId);
                await closeOwnedDownload(active.owner, envelope.transferId, false);
                params.transferRelayChannel.sendEnvelope(buildMachineToUserEnvelope({
                    machineId: params.machineId,
                    scopeUserId: active.scopeUserId,
                    envelope: {
                        transferId: envelope.transferId,
                        kind: 'finish',
                        manifestHash: active.manifestHash,
                    },
                }));
                return;
            }

            await sendNextChunk({
                transferId: envelope.transferId,
                scopeUserId: active.scopeUserId,
                manifestHash: active.manifestHash,
                owner: active.owner,
            });
        })().catch(() => {
            const active = activeTransfers.get(payload.envelope.transferId);
            if (!active) {
                return;
            }
            void sendAbort({
                transferId: payload.envelope.transferId,
                scopeUserId: active.scopeUserId,
                reason: 'transfer_failed',
                closeSession: true,
                owner: active.owner,
            });
        });
    });
}
