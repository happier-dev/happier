import { type TransferRelayV2SendEnvelope } from '@happier-dev/protocol';

import { resolveServerScopedTransferRelaySocket } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedTransferRelaySocket';

import { type ChunkDownloadProgress } from './chunkTransferClient';
import { type BulkTransferFileDestination } from './bulkTransferFileDestination';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from './transferChunkEncryption';
import { cleanupBulkTransferDestination } from './cleanupBulkTransferDestination';
import { createTransferManifestHasher } from './transferManifestHasher';
import { classifyServerRelayTransferChunkSequence } from './classifyServerRelayTransferChunkSequence';
import { resolveServerRelayTransferInactivityTimeoutMs } from './resolveServerRelayTransferInactivityTimeoutMs';

type BulkTransferFailureResponse = Readonly<{
    success: false;
    error: string;
    errorCode?: string;
}>;

type BulkTransferDownloadInitSuccess = Readonly<{
    success: true;
    downloadId: string;
    chunkSizeBytes: number;
    sizeBytes: number;
    name: string;
}>;

type BulkTransferDownloadInitResponse = BulkTransferDownloadInitSuccess | BulkTransferFailureResponse;
type BulkTransferDownloadFinalizeResponse = Readonly<{ success: boolean; error?: string }>;
type RelayFileDownloadResponse =
    | Readonly<{ ok: true; name: string; sizeBytes: number }>
    | Readonly<{ ok: false; error: string }>;

function isChunkEnvelopeForTransfer(
    payload: TransferRelayV2SendEnvelope,
    machineId: string,
    transferId: string,
): payload is TransferRelayV2SendEnvelope & Readonly<{
    envelope: Readonly<{
        transferId: string;
        kind: 'chunk';
        sequence: number;
        payloadBase64: string;
        encryptedDataKeyEnvelopeBase64: string;
    }>;
}> {
    return payload.sender.kind === 'machine'
        && payload.sender.machineId === machineId
        && payload.recipient.kind === 'user'
        && payload.envelope.transferId === transferId
        && payload.envelope.kind === 'chunk'
        && typeof payload.envelope.encryptedDataKeyEnvelopeBase64 === 'string';
}

export async function downloadBulkPayloadViaServerRelayToDestination(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number | null;
    destination: BulkTransferFileDestination;
    cleanupOnFailure?: boolean;
    init: (request: Readonly<{ recipientPublicKeyBase64: string }>) => Promise<BulkTransferDownloadInitResponse>;
    finalize: (request: Readonly<{ downloadId: string }>) => Promise<BulkTransferDownloadFinalizeResponse>;
    abort?: ((request: Readonly<{ downloadId: string }>) => Promise<unknown>) | null;
    onInit?: ((init: Readonly<{ name: string; sizeBytes: number }>) => Promise<void | BulkTransferFailureResponse>) | null;
    onProgress?: ((progress: ChunkDownloadProgress) => void) | null;
    signal?: AbortSignal | null;
}>): Promise<RelayFileDownloadResponse> {
    async function cleanupFailedDestination(): Promise<void> {
        if (params.cleanupOnFailure === false) {
            return;
        }
        await cleanupBulkTransferDestination(params.destination);
    }

    const recipientKeyPair = createTransferRecipientKeyPair();
    const transferTimeoutMs = resolveServerRelayTransferInactivityTimeoutMs(params.timeoutMs);
    const init = await params.init({
        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    });
    if (init.success !== true) {
        await cleanupFailedDestination();
        return {
            ok: false,
            error: init.error,
        };
    }

    const downloadId = init.downloadId;

    async function abortAndCleanupFailure(error: string, abortTransfer = false): Promise<RelayFileDownloadResponse> {
        if (abortTransfer) {
            try {
                await params.abort?.({ downloadId });
            } catch {
                // Best-effort only.
            }
        }
        await cleanupFailedDestination();
        return {
            ok: false,
            error,
        };
    }

    if (params.onInit) {
        try {
            const sideEffect = await params.onInit({ name: init.name, sizeBytes: init.sizeBytes });
            if (sideEffect && sideEffect.success === false) {
                return await abortAndCleanupFailure(sideEffect.error, true);
            }
        } catch (error) {
            return await abortAndCleanupFailure(
                error instanceof Error ? error.message : 'Server relay transfer failed',
                true,
            );
        }
    }

    let relaySocket;
    try {
        relaySocket = await resolveServerScopedTransferRelaySocket({
            machineId: params.machineId,
            ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
            timeoutMs: transferTimeoutMs,
        });
    } catch (error) {
        return await abortAndCleanupFailure(
            error instanceof Error ? error.message : 'Server relay transfer failed',
            true,
        );
    }

    return await new Promise((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        let signalCleanup: (() => void) | null = null;
        let transferTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let envelopeQueue = Promise.resolve();
        let downloadedBytes = 0;
        let nextExpectedSequence = 0;
        const manifestHasher = createTransferManifestHasher();

        const emitProgress = () => {
            if (!params.onProgress) {
                return;
            }

            try {
                params.onProgress({
                    downloadedBytes,
                    totalBytes: init.sizeBytes,
                });
            } catch {
                // ignore
            }
        };

        const clearTransferTimeout = () => {
            if (transferTimeoutId === null) {
                return;
            }
            clearTimeout(transferTimeoutId);
            transferTimeoutId = null;
        };

        const armTransferTimeout = () => {
            clearTransferTimeout();
            transferTimeoutId = setTimeout(() => {
                void resolveError('Server relay transfer timed out', true);
            }, transferTimeoutMs);
        };

        const settle = () => {
            if (settled) {
                return false;
            }
            settled = true;
            clearTransferTimeout();
            unsubscribe?.();
            signalCleanup?.();
            relaySocket.disconnect();
            return true;
        };

        const resolveError = async (error: string, abortTransfer = false) => {
            if (!settle()) {
                return;
            }
            resolve(await abortAndCleanupFailure(error, abortTransfer));
        };

        const resolveSuccess = async () => {
            if (!settle()) {
                return;
            }
            try {
                await params.destination.close();
            } catch (error) {
                resolve(await abortAndCleanupFailure(
                    error instanceof Error ? error.message : 'Failed to close transfer destination',
                    true,
                ));
                return;
            }
            resolve({
                ok: true as const,
                name: init.name,
                sizeBytes: downloadedBytes,
            });
        };

        unsubscribe = relaySocket.onEnvelope((payload) => {
            envelopeQueue = envelopeQueue.then(async () => {
                if (settled || payload.scopeUserId !== relaySocket.scopeUserId) {
                    return;
                }

                if (
                    payload.sender.kind !== 'machine'
                    || payload.sender.machineId !== params.machineId
                    || payload.recipient.kind !== 'user'
                    || payload.envelope.transferId !== init.downloadId
                ) {
                    return;
                }

                armTransferTimeout();

                if (payload.envelope.kind === 'abort') {
                    await resolveError(payload.envelope.reason, true);
                    return;
                }

                if (isChunkEnvelopeForTransfer(payload, params.machineId, init.downloadId)) {
                    const sequenceDisposition = classifyServerRelayTransferChunkSequence(
                        payload.envelope.sequence,
                        nextExpectedSequence,
                    );
                    if (sequenceDisposition === 'duplicate') {
                        relaySocket.sendEnvelope({
                            scopeUserId: relaySocket.scopeUserId,
                            sender: {
                                kind: 'user',
                            },
                            recipient: {
                                kind: 'machine',
                                machineId: params.machineId,
                            },
                            envelope: {
                                transferId: init.downloadId,
                                kind: 'ack',
                                nextSequence: nextExpectedSequence,
                            },
                        });
                        armTransferTimeout();
                        return;
                    }
                    const decrypted = await decryptEncryptedTransferChunkEnvelope({
                        transferId: init.downloadId,
                        sequence: payload.envelope.sequence,
                        payloadBase64: payload.envelope.payloadBase64,
                        encryptedDataKeyEnvelopeBase64: payload.envelope.encryptedDataKeyEnvelopeBase64,
                        recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
                    });
                    manifestHasher.update(decrypted);
                    await params.destination.writeBytes(decrypted);
                    downloadedBytes += decrypted.byteLength;
                    nextExpectedSequence = payload.envelope.sequence + 1;
                    emitProgress();
                    relaySocket.sendEnvelope({
                        scopeUserId: relaySocket.scopeUserId,
                        sender: {
                            kind: 'user',
                        },
                        recipient: {
                            kind: 'machine',
                            machineId: params.machineId,
                        },
                        envelope: {
                            transferId: init.downloadId,
                            kind: 'ack',
                            nextSequence: nextExpectedSequence,
                        },
                    });
                    return;
                }

                if (payload.envelope.kind !== 'finish') {
                    return;
                }

                const manifestHash = manifestHasher.digestManifestHash();
                if (manifestHash !== payload.envelope.manifestHash) {
                    await resolveError('Downloaded transfer payload manifest hash mismatch', true);
                    return;
                }

                const finalize = await params.finalize({ downloadId: init.downloadId });
                if (finalize.success !== true) {
                    await resolveError(finalize.error ?? 'Download finalize failed', true);
                    return;
                }

                await resolveSuccess();
            }).catch(async (error) => {
                await resolveError(
                    error instanceof Error ? error.message : 'Server relay transfer failed',
                    true,
                );
            });
        });

        if (params.signal) {
            const onAbort = () => {
                void resolveError('Transfer aborted', true);
            };
            params.signal.addEventListener('abort', onAbort, { once: true });
            signalCleanup = () => {
                params.signal?.removeEventListener('abort', onAbort);
            };
        }

        relaySocket.sendEnvelope({
            scopeUserId: relaySocket.scopeUserId,
            sender: {
                kind: 'user',
            },
            recipient: {
                kind: 'machine',
                machineId: params.machineId,
            },
            envelope: {
                transferId: init.downloadId,
                kind: 'open',
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            },
        });
        armTransferTimeout();
    });
}
