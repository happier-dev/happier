import { type TransferRelayV2SendEnvelope } from '@happier-dev/protocol';

import { resolveServerScopedTransferRelaySocket } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedTransferRelaySocket';

import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from './transferChunkEncryption';
import { resolveBulkTransferJsonMaxBytes } from './resolveBulkTransferJsonMaxBytes';
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

function concatUint8Arrays(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
    const concatenated = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        concatenated.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return concatenated;
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

export async function downloadBulkJsonPayloadViaServerRelay<TPayload>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number | null;
    init: (request: Readonly<{ recipientPublicKeyBase64: string }>) => Promise<BulkTransferDownloadInitResponse>;
    finalize: (request: Readonly<{ downloadId: string }>) => Promise<BulkTransferDownloadFinalizeResponse>;
    abort?: ((request: Readonly<{ downloadId: string }>) => Promise<unknown>) | null;
    parsePayload: (value: unknown) => TPayload | null;
    signal?: AbortSignal | null;
}>): Promise<
    | Readonly<{ ok: true; payload: TPayload }>
    | Readonly<{ ok: false; error: string }>
> {
    const recipientKeyPair = createTransferRecipientKeyPair();
    const transferTimeoutMs = resolveServerRelayTransferInactivityTimeoutMs(params.timeoutMs);
    const init = await params.init({
        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    });
    if (init.success !== true) {
        return {
            ok: false,
            error: init.error,
        };
    }

    const jsonMaxBytes = resolveBulkTransferJsonMaxBytes(null);
    if (init.sizeBytes > jsonMaxBytes) {
        try {
            await params.abort?.({ downloadId: init.downloadId });
        } catch {
            // Best-effort only.
        }
        return {
            ok: false,
            error: `Downloaded JSON payload exceeds max allowed bytes (${jsonMaxBytes})`,
        };
    }

    let relaySocket;
    try {
        relaySocket = await resolveServerScopedTransferRelaySocket({
            machineId: params.machineId,
            ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
            timeoutMs: transferTimeoutMs,
        });
    } catch (error) {
        try {
            await params.abort?.({ downloadId: init.downloadId });
        } catch {
            // Best-effort only.
        }
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Server relay transfer failed',
        };
    }

    const manifestHasher = createTransferManifestHasher();

    return await new Promise((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        let signalCleanup: (() => void) | null = null;
        let transferTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let envelopeQueue = Promise.resolve();
        const receivedChunks: Uint8Array[] = [];
        let receivedBytes = 0;
        let nextExpectedSequence = 0;

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

        const cleanup = () => {
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
            if (!cleanup()) {
                return;
            }
            if (abortTransfer) {
                try {
                    await params.abort?.({ downloadId: init.downloadId });
                } catch {
                    // Best-effort only.
                }
            }
            resolve({
                ok: false as const,
                error,
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
                    if (receivedBytes + decrypted.byteLength > jsonMaxBytes) {
                        await resolveError(`Downloaded JSON payload exceeds max allowed bytes (${jsonMaxBytes})`, true);
                        return;
                    }
                    receivedChunks.push(decrypted);
                    receivedBytes += decrypted.byteLength;
                    nextExpectedSequence = payload.envelope.sequence + 1;
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

                const receivedPayload = concatUint8Arrays(receivedChunks, receivedBytes);
                let parsedJson: unknown;
                try {
                    parsedJson = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(receivedPayload));
                } catch {
                    await resolveError('Downloaded transfer payload is not valid JSON', true);
                    return;
                }

                const parsedPayload = params.parsePayload(parsedJson);
                if (parsedPayload === null) {
                    await resolveError('Downloaded transfer payload returned an unsupported response', true);
                    return;
                }

                if (!cleanup()) {
                    return;
                }
                resolve({
                    ok: true as const,
                    payload: parsedPayload,
                });
            }).catch((error) => {
                void resolveError(error instanceof Error ? error.message : 'Server relay transfer failed', true);
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
