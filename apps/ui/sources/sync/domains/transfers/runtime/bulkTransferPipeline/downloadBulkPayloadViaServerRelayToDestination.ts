import { type TransferRelayV2SendEnvelope } from '@happier-dev/protocol';

import { digest } from '@/platform/digest';
import { resolveServerScopedTransferRelaySocket } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedTransferRelaySocket';

import { type ChunkDownloadProgress } from './chunkTransferClient';
import { type BulkTransferFileDestination } from './downloadBulkPayloadToFile';
import { mergeTransferChunks } from './mergeTransferChunks';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from './transferChunkEncryption';

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

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function computeManifestHash(payload: Uint8Array): Promise<string> {
    const payloadCopy = new Uint8Array(new ArrayBuffer(payload.byteLength));
    payloadCopy.set(payload);
    const digestBytes = await digest('SHA-256', payloadCopy);
    return `sha256:${bytesToHex(digestBytes)}`;
}

async function cleanupFailedDestination(destination: BulkTransferFileDestination): Promise<void> {
    if (destination.cleanup) {
        await destination.cleanup();
        return;
    }

    await destination.close();
}

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
    init: (request: Readonly<{ recipientPublicKeyBase64: string }>) => Promise<BulkTransferDownloadInitResponse>;
    finalize: (request: Readonly<{ downloadId: string }>) => Promise<BulkTransferDownloadFinalizeResponse>;
    abort?: ((request: Readonly<{ downloadId: string }>) => Promise<unknown>) | null;
    onInit?: ((init: Readonly<{ name: string; sizeBytes: number }>) => Promise<void | BulkTransferFailureResponse>) | null;
    onProgress?: ((progress: ChunkDownloadProgress) => void) | null;
    signal?: AbortSignal | null;
}>): Promise<RelayFileDownloadResponse> {
    const recipientKeyPair = createTransferRecipientKeyPair();
    const transferTimeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
        ? Math.max(1, Math.floor(params.timeoutMs))
        : null;
    const init = await params.init({
        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    });
    if (init.success !== true) {
        await cleanupFailedDestination(params.destination);
        return {
            ok: false,
            error: init.error,
        };
    }

    if (params.onInit) {
        try {
            const sideEffect = await params.onInit({ name: init.name, sizeBytes: init.sizeBytes });
            if (sideEffect && sideEffect.success === false) {
                try {
                    await params.abort?.({ downloadId: init.downloadId });
                } catch {
                    // Best-effort only.
                }
                await cleanupFailedDestination(params.destination);
                return {
                    ok: false,
                    error: sideEffect.error,
                };
            }
        } catch (error) {
            try {
                await params.abort?.({ downloadId: init.downloadId });
            } catch {
                // Best-effort only.
            }
            await cleanupFailedDestination(params.destination);
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Server relay transfer failed',
            };
        }
    }

    let relaySocket;
    try {
        relaySocket = await resolveServerScopedTransferRelaySocket({
            machineId: params.machineId,
            ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
            ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        });
    } catch (error) {
        try {
            await params.abort?.({ downloadId: init.downloadId });
        } catch {
            // Best-effort only.
        }
        await cleanupFailedDestination(params.destination);
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Server relay transfer failed',
        };
    }

    return await new Promise((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        let signalCleanup: (() => void) | null = null;
        let transferTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let envelopeQueue = Promise.resolve();
        let downloadedBytes = 0;
        const streamedChunks: Uint8Array[] = [];

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
            if (transferTimeoutMs === null) {
                return;
            }
            transferTimeoutId = setTimeout(() => {
                void finish({
                    ok: false,
                    error: 'Server relay transfer timed out',
                }, true);
            }, transferTimeoutMs);
        };

        const finish = async (result: RelayFileDownloadResponse, abortTransfer = false) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTransferTimeout();
            unsubscribe?.();
            signalCleanup?.();
            relaySocket.disconnect();

            if (!result.ok) {
                if (abortTransfer) {
                    try {
                        await params.abort?.({ downloadId: init.downloadId });
                    } catch {
                        // Best-effort only.
                    }
                }
                await cleanupFailedDestination(params.destination);
            }

            resolve(result);
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
                    await finish({
                        ok: false,
                        error: payload.envelope.reason,
                    });
                    return;
                }

                if (isChunkEnvelopeForTransfer(payload, params.machineId, init.downloadId)) {
                    const decrypted = await decryptEncryptedTransferChunkEnvelope({
                        transferId: init.downloadId,
                        sequence: payload.envelope.sequence,
                        payloadBase64: payload.envelope.payloadBase64,
                        encryptedDataKeyEnvelopeBase64: payload.envelope.encryptedDataKeyEnvelopeBase64,
                        recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
                    });
                    streamedChunks.push(new Uint8Array(decrypted));
                    await params.destination.writeBytes(decrypted);
                    downloadedBytes += decrypted.byteLength;
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
                            nextSequence: payload.envelope.sequence + 1,
                        },
                    });
                    return;
                }

                if (payload.envelope.kind !== 'finish') {
                    return;
                }

                const manifestHash = await computeManifestHash(mergeTransferChunks(streamedChunks));
                if (manifestHash !== payload.envelope.manifestHash) {
                    await finish({
                        ok: false,
                        error: 'Downloaded transfer payload manifest hash mismatch',
                    }, true);
                    return;
                }

                const finalize = await params.finalize({ downloadId: init.downloadId });
                if (finalize.success !== true) {
                    await finish({
                        ok: false,
                        error: finalize.error ?? 'Download finalize failed',
                    });
                    return;
                }

                await params.destination.close();
                await finish({
                    ok: true,
                    name: init.name,
                    sizeBytes: downloadedBytes,
                });
            }).catch(async (error) => {
                await finish({
                    ok: false,
                    error: error instanceof Error ? error.message : 'Server relay transfer failed',
                }, true);
            });
        });

        if (params.signal) {
            const onAbort = () => {
                void finish({
                    ok: false,
                    error: 'Transfer aborted',
                }, true);
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
