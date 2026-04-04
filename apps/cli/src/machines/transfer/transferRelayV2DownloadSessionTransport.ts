import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol';

import {
    abortDownloadTransferSession,
    finalizeDownloadTransferSession,
    readDownloadTransferChunk,
    type TransferSessionLifecycle,
} from '@/transfers/core/transferSessionLifecycle';
import { type TransferSessionStore } from '@/transfers/core/transferSessionStore';

import { createFileTransferPayloadSource, resolveTransferPayloadManifestHash } from './transferPayloadSource';

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
            await abortDownloadTransferSession({
                lifecycle: input.owner.lifecycle,
                downloadId: input.transferId,
            });
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
        const session = input.owner.store.getDownloadSession(input.transferId);
        if (!session) {
            await sendAbort({
                transferId: input.transferId,
                scopeUserId: input.scopeUserId,
                reason: 'transfer_not_found',
            });
            return;
        }

        const chunkIndex = session.nextIndex;
        const chunk = await readDownloadTransferChunk({
            lifecycle: input.owner.lifecycle,
            downloadId: input.transferId,
            index: chunkIndex,
        });
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
                if (!session) {
                    await sendAbort({
                        transferId: envelope.transferId,
                        scopeUserId: payload.scopeUserId,
                        reason: 'transfer_not_found',
                    });
                    return;
                }
                if (
                    typeof session.recipientPublicKeyBase64 === 'string'
                    && session.recipientPublicKeyBase64 !== envelope.recipientPublicKeyBase64
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

                const manifestHash = await resolveTransferPayloadManifestHash(createFileTransferPayloadSource({
                    filePath: session.filePath,
                    sizeBytes: session.sizeBytes,
                }));
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
                await abortDownloadTransferSession({
                    lifecycle: active.owner.lifecycle,
                    downloadId: envelope.transferId,
                });
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
                await finalizeDownloadTransferSession({
                    lifecycle: active.owner.lifecycle,
                    downloadId: envelope.transferId,
                });
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
