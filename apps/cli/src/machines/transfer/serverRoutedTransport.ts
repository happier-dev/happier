import type { MachineTransferReceiveEnvelope, MachineTransferSendEnvelope } from '@happier-dev/protocol';

import {
  isServerRoutedTransferOverSizeLimit,
  resolveServerRoutedTransferMaxBytes,
  SERVER_ROUTED_TRANSFER_SIZE_LIMIT_ERROR,
} from './serverRoutedTransferPolicy';
import { IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR, resolveInMemoryTransferMaxBytes } from './inMemoryTransferSizeLimit';
import {
  createEncryptedTransferChunkEnvelope,
  createTransferRecipientKeyPair,
  decryptEncryptedTransferChunkEnvelope,
} from './transferChunkEncryption';
import {
  readTransferPayloadChunk,
  resolveTransferPayloadManifestHash,
  resolveTransferPayloadSizeBytes,
  type TransferPayloadSource,
} from './transferPayloadSource';
import { createTransferPayloadFileSink, type TransferPayloadFileResult } from './transferPayloadFileSink';
import { readPositiveIntEnv } from '../../utils/readPositiveIntEnv';
import { clampTransferChunkBytes } from './transferChunkSizeLimit';

const DEFAULT_TRANSFER_TIMEOUT_MS = 90_000;
const DEFAULT_TRANSFER_CHUNK_BYTES = 256 * 1024;
const ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES = 1 + 12 + 16; // version + nonce + auth tag
// Encrypted data-key envelopes are small and fixed-size today (~105 bytes for V1), but we still
// cap them independently so hostile payloads cannot force large base64 decode allocations.
const ENCRYPTED_TRANSFER_DATA_KEY_ENVELOPE_HARD_MAX_BYTES = 1024;

export type MachineTransferChannel = Readonly<{
  onEnvelope: (listener: (payload: MachineTransferReceiveEnvelope) => void) => () => void;
  sendEnvelope: (payload: MachineTransferSendEnvelope) => void;
}>;

type MachineTransferReceiveOpenEnvelope = Extract<MachineTransferReceiveEnvelope['envelope'], { kind: 'open' }>;
type MachineTransferReceiveChunkEnvelope = Extract<MachineTransferReceiveEnvelope['envelope'], { kind: 'chunk' }>;
type MachineTransferSendOpenEnvelope = Extract<MachineTransferSendEnvelope['envelope'], { kind: 'open' }>;
type MachineTransferSendChunkEnvelope = Extract<MachineTransferSendEnvelope['envelope'], { kind: 'chunk' }>;

type ActiveTransferState = Readonly<{
  targetMachineId: string;
  payloadSource: TransferPayloadSource;
  manifestHash: string;
  chunkBytes: number;
  totalChunks: number;
  nextSequenceToSend: number;
  recipientPublicKeyBase64: string;
}>;

function readTransferTimeoutMs(): number {
  return readPositiveIntEnv('HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS', DEFAULT_TRANSFER_TIMEOUT_MS);
}

function readTransferChunkBytes(): number {
  return clampTransferChunkBytes(readPositiveIntEnv(
    'HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_CHUNK_BYTES',
    DEFAULT_TRANSFER_CHUNK_BYTES,
  ));
}

function isBase64TrimChar(code: number): boolean {
  // We only expect ASCII base64 strings; treat common ASCII whitespace/control as trim chars.
  // This avoids allocating via `value.trim()` on potentially large hostile payloads.
  return code <= 0x20 || code === 0xfeff;
}

function estimateBase64DecodedBytes(value: string): number {
  let start = 0;
  let end = value.length - 1;
  while (start <= end && isBase64TrimChar(value.charCodeAt(start))) start += 1;
  while (end >= start && isBase64TrimChar(value.charCodeAt(end))) end -= 1;
  if (start > end) return 0;

  const trimmedLength = end - start + 1;
  const lastChar = value[end];
  const paddingBytes = lastChar === '=' ? (value[end - 1] === '=' ? 2 : 1) : 0;
  return Math.max(0, Math.floor((trimmedLength * 3) / 4) - paddingBytes);
}

function isReceiveOpenEnvelope(
  envelope: MachineTransferReceiveEnvelope['envelope'],
): envelope is MachineTransferReceiveOpenEnvelope {
  return envelope.kind === 'open';
}

function isReceiveChunkEnvelope(
  envelope: MachineTransferReceiveEnvelope['envelope'],
): envelope is MachineTransferReceiveChunkEnvelope {
  return envelope.kind === 'chunk';
}

function createSendOpenEnvelope(input: Readonly<{
  transferId: string;
  manifestHash: string;
  recipientPublicKeyBase64: string;
}>): MachineTransferSendOpenEnvelope {
  return {
    transferId: input.transferId,
    kind: 'open',
    manifestHash: input.manifestHash,
    recipientPublicKeyBase64: input.recipientPublicKeyBase64,
  };
}

function createSendChunkEnvelope(input: Readonly<{
  transferId: string;
  sequence: number;
  payloadBase64: string;
  encryptedDataKeyEnvelopeBase64: string;
}>): MachineTransferSendChunkEnvelope {
  return {
    transferId: input.transferId,
    kind: 'chunk',
    sequence: input.sequence,
    payloadBase64: input.payloadBase64,
    encryptedDataKeyEnvelopeBase64: input.encryptedDataKeyEnvelopeBase64,
  };
}

async function sendTransferChunk(params: Readonly<{
  machineTransferChannel: MachineTransferChannel;
  transferId: string;
  state: ActiveTransferState;
}>): Promise<void> {
  if (params.state.nextSequenceToSend >= params.state.totalChunks) {
    params.machineTransferChannel.sendEnvelope({
      targetMachineId: params.state.targetMachineId,
      envelope: {
        transferId: params.transferId,
        kind: 'finish',
        manifestHash: params.state.manifestHash,
      },
    });
    return;
  }

  const offset = params.state.nextSequenceToSend * params.state.chunkBytes;
  const encryptedChunk = createEncryptedTransferChunkEnvelope({
    transferId: params.transferId,
    sequence: params.state.nextSequenceToSend,
    payload: await readTransferPayloadChunk({
      source: params.state.payloadSource,
      offset,
      length: params.state.chunkBytes,
    }),
    recipientPublicKeyBase64: params.state.recipientPublicKeyBase64,
  });
  params.machineTransferChannel.sendEnvelope({
    targetMachineId: params.state.targetMachineId,
    envelope: createSendChunkEnvelope({
      transferId: params.transferId,
      sequence: params.state.nextSequenceToSend,
      payloadBase64: encryptedChunk.payloadBase64,
      encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
    }),
  });
}

export function registerServerRoutedTransferResponder(params: Readonly<{
  machineTransferChannel: MachineTransferChannel;
  loadTransferPayloadSource: (transferId: string) => TransferPayloadSource | null | Promise<TransferPayloadSource | null>;
  chunkBytes?: number;
}>): () => void {
  const activeTransfers = new Map<string, ActiveTransferState>();
  const chunkBytes = clampTransferChunkBytes(typeof params.chunkBytes === 'number' && params.chunkBytes > 0
    ? params.chunkBytes
    : readTransferChunkBytes());
  const maxBytes = resolveServerRoutedTransferMaxBytes();
  const inMemoryMaxBytes = resolveInMemoryTransferMaxBytes();

  return params.machineTransferChannel.onEnvelope((payload) => {
    void (async () => {
    const envelope = payload.envelope;
    if (isReceiveOpenEnvelope(envelope)) {
      if (!envelope.recipientPublicKeyBase64) {
        params.machineTransferChannel.sendEnvelope({
          targetMachineId: payload.sourceMachineId,
          envelope: {
            transferId: envelope.transferId,
            kind: 'abort',
            reason: `invalid_open_request:${envelope.transferId}`,
          },
        });
        return;
      }
      const transferPayloadSource = await params.loadTransferPayloadSource(envelope.transferId);
      if (!transferPayloadSource) {
        params.machineTransferChannel.sendEnvelope({
          targetMachineId: payload.sourceMachineId,
          envelope: {
            transferId: envelope.transferId,
            kind: 'abort',
            reason: `transfer_not_found:${envelope.transferId}`,
          },
        });
        return;
      }
      const transferSizeBytes = await resolveTransferPayloadSizeBytes(transferPayloadSource);
      if (isServerRoutedTransferOverSizeLimit(transferSizeBytes, maxBytes)) {
        params.machineTransferChannel.sendEnvelope({
          targetMachineId: payload.sourceMachineId,
          envelope: {
            transferId: envelope.transferId,
            kind: 'abort',
            reason: `${SERVER_ROUTED_TRANSFER_SIZE_LIMIT_ERROR}:${maxBytes}`,
          },
        });
        return;
      }
      if (transferPayloadSource.kind === 'buffer' && transferSizeBytes > inMemoryMaxBytes) {
        params.machineTransferChannel.sendEnvelope({
          targetMachineId: payload.sourceMachineId,
          envelope: {
            transferId: envelope.transferId,
            kind: 'abort',
            reason: `${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${inMemoryMaxBytes}`,
          },
        });
        return;
      }

      const totalChunks = Math.max(1, Math.ceil(transferSizeBytes / chunkBytes));
      const state: ActiveTransferState = {
        targetMachineId: payload.sourceMachineId,
        payloadSource: transferPayloadSource,
        manifestHash: await resolveTransferPayloadManifestHash(transferPayloadSource),
        chunkBytes,
        totalChunks,
        nextSequenceToSend: 0,
        recipientPublicKeyBase64: envelope.recipientPublicKeyBase64,
      };
      activeTransfers.set(envelope.transferId, state);
      await sendTransferChunk({
        machineTransferChannel: params.machineTransferChannel,
        transferId: envelope.transferId,
        state,
      });
      return;
    }

    if (envelope.kind === 'abort') {
      const current = activeTransfers.get(envelope.transferId);
      if (!current || current.targetMachineId !== payload.sourceMachineId) {
        return;
      }
      activeTransfers.delete(envelope.transferId);
      return;
    }

    if (envelope.kind !== 'ack') return;
    const current = activeTransfers.get(envelope.transferId);
    if (!current || current.targetMachineId !== payload.sourceMachineId) {
      return;
    }
    if (envelope.nextSequence <= current.nextSequenceToSend) {
      return;
    }
    const nextState: ActiveTransferState = {
      ...current,
      nextSequenceToSend: envelope.nextSequence,
    };
    if (nextState.nextSequenceToSend > nextState.totalChunks) {
      activeTransfers.delete(envelope.transferId);
      params.machineTransferChannel.sendEnvelope({
        targetMachineId: payload.sourceMachineId,
        envelope: {
          transferId: envelope.transferId,
          kind: 'abort',
          reason: `invalid_ack_sequence:${envelope.nextSequence}`,
        },
      });
      return;
    }
    if (nextState.nextSequenceToSend >= nextState.totalChunks) {
      activeTransfers.delete(envelope.transferId);
    } else {
      activeTransfers.set(envelope.transferId, nextState);
    }
    await sendTransferChunk({
      machineTransferChannel: params.machineTransferChannel,
      transferId: envelope.transferId,
      state: nextState,
    });
    })().catch((error) => {
      const transferId = payload.envelope.transferId;
      activeTransfers.delete(transferId);
      params.machineTransferChannel.sendEnvelope({
        targetMachineId: payload.sourceMachineId,
        envelope: {
          transferId,
          kind: 'abort',
          reason: error instanceof Error ? error.message : `transfer_failed:${transferId}`,
        },
      });
    });
  });
}

async function requestServerRoutedTransfer<TPayload>(params: Readonly<{
  transferId: string;
  sourceMachineId: string;
  machineTransferChannel: MachineTransferChannel;
  timeoutMs?: number;
  maxInMemoryPayloadBytes?: number;
  onChunk: (chunk: Buffer, info: Readonly<{ sequence: number }>) => Promise<void> | void;
  onFinish: (manifestHash: string) => Promise<TPayload>;
  onAbort?: () => Promise<void> | void;
}>): Promise<TPayload> {
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : readTransferTimeoutMs();
  const recipientKeyPair = createTransferRecipientKeyPair();
  return await new Promise<TPayload>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let timeoutNonce = 0;
    let nextExpectedSequence = 0;
    let envelopeQueue = Promise.resolve();

    const armTimeout = () => {
      if (settled) return;
      timeoutNonce += 1;
      const localNonce = timeoutNonce;
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => {
        // The event loop can delay timer callbacks; if a newer timeout was armed after this one,
        // ignore the stale callback instead of aborting an active transfer.
        if (settled || localNonce !== timeoutNonce) {
          return;
        }
        // Ensure file sinks and other resources are reliably torn down on timeout.
        // Without this, file-backed requests can leak open FileHandles and `.part` files until GC.
        cleanup();
        params.machineTransferChannel.sendEnvelope({
          targetMachineId: params.sourceMachineId,
          envelope: {
            transferId: params.transferId,
            kind: 'abort',
            reason: 'timeout',
          },
        });
        void Promise.resolve(params.onAbort?.()).finally(() => {
          reject(new Error(`Timed out waiting for machine transfer ${params.transferId}`));
        });
      }, timeoutMs);
    };

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      unsubscribe?.();
    };

    unsubscribe = params.machineTransferChannel.onEnvelope((payload) => {
      if (payload.sourceMachineId !== params.sourceMachineId) return;
      if (payload.envelope.transferId !== params.transferId) return;
      // Treat timeout as inactivity since *last received* envelope, not since last fully-processed
      // envelope. Without this, slow chunk delivery can time out while chunks are in-flight but
      // queued behind previous processing.
      armTimeout();
      envelopeQueue = envelopeQueue
        .then(async () => {
          if (settled) {
            return;
          }

          if (isReceiveChunkEnvelope(payload.envelope)) {
            const chunkEnvelope = payload.envelope;
            if (chunkEnvelope.sequence < nextExpectedSequence) {
              params.machineTransferChannel.sendEnvelope({
                targetMachineId: params.sourceMachineId,
                envelope: {
                  transferId: params.transferId,
                  kind: 'ack',
                  nextSequence: nextExpectedSequence,
                  windowBytes: nextExpectedSequence,
                },
              });
              // Sending an ack is progress; treat it as activity so we don't time out while the
              // next chunk is gated on this ack.
              armTimeout();
              return;
            }
            if (chunkEnvelope.sequence > nextExpectedSequence) {
              throw new Error(
                `Machine transfer received out-of-order chunk ${chunkEnvelope.sequence} for ${params.transferId}; expected ${nextExpectedSequence}`,
              );
            }
            const encryptedDataKeyEnvelopeBase64 = chunkEnvelope.encryptedDataKeyEnvelopeBase64;
            if (!encryptedDataKeyEnvelopeBase64) {
              throw new Error(`Machine transfer missing encrypted chunk key for ${params.transferId}`);
            }
            if (typeof params.maxInMemoryPayloadBytes === 'number' && params.maxInMemoryPayloadBytes > 0) {
              const maxEncryptedPayloadBytes =
                params.maxInMemoryPayloadBytes + ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES;
              const estimatedEncryptedPayloadBytes = estimateBase64DecodedBytes(chunkEnvelope.payloadBase64);
              const estimatedEncryptedDataKeyEnvelopeBytes = estimateBase64DecodedBytes(encryptedDataKeyEnvelopeBase64);
              if (
                estimatedEncryptedPayloadBytes > maxEncryptedPayloadBytes
                || estimatedEncryptedDataKeyEnvelopeBytes > ENCRYPTED_TRANSFER_DATA_KEY_ENVELOPE_HARD_MAX_BYTES
              ) {
                throw new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${params.maxInMemoryPayloadBytes}`);
              }
            }
            await params.onChunk(decryptEncryptedTransferChunkEnvelope({
              transferId: params.transferId,
              sequence: chunkEnvelope.sequence,
              payloadBase64: chunkEnvelope.payloadBase64,
              encryptedDataKeyEnvelopeBase64,
              recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            }), {
              sequence: chunkEnvelope.sequence,
            });
            nextExpectedSequence = chunkEnvelope.sequence + 1;
            params.machineTransferChannel.sendEnvelope({
              targetMachineId: params.sourceMachineId,
              envelope: {
                transferId: params.transferId,
                kind: 'ack',
                nextSequence: nextExpectedSequence,
                windowBytes: nextExpectedSequence,
              },
            });
            // Treat ack send as activity. Without this, slow disk writes can delay the ack enough
            // that no new chunk arrives before the inactivity timer fires.
            armTimeout();
            return;
          }

          if (payload.envelope.kind === 'abort') {
            throw new Error(`Machine transfer aborted: ${payload.envelope.reason}`);
          }

          if (payload.envelope.kind === 'finish') {
            const result = await params.onFinish(payload.envelope.manifestHash);
            cleanup();
            resolve(result);
          }
        })
        .catch((error) => {
          cleanup();
          void Promise.resolve(params.onAbort?.()).finally(() => {
            reject(error instanceof Error ? error : new Error(`Machine transfer failed for ${params.transferId}`));
          });
        });
    });

    armTimeout();

    params.machineTransferChannel.sendEnvelope({
      targetMachineId: params.sourceMachineId,
      envelope: createSendOpenEnvelope({
        transferId: params.transferId,
        manifestHash: params.transferId,
        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
      }),
    });
  });
}

export async function requestServerRoutedTransferToFile(params: Readonly<{
  transferId: string;
  sourceMachineId: string;
  machineTransferChannel: MachineTransferChannel;
  destinationPath: string;
  timeoutMs?: number;
}>): Promise<TransferPayloadFileResult> {
  const maxBytes = resolveServerRoutedTransferMaxBytes();
  const sink = await createTransferPayloadFileSink({
    destinationPath: params.destinationPath,
  });
  let receivedBytes = 0;
  return await requestServerRoutedTransfer({
    ...params,
    // File-backed transfers are still bounded per chunk to avoid OOM, but they must not be constrained
    // by the small-only whole-buffer in-memory cap (`HAPPIER_FILES_READ_MAX_BYTES`).
    maxInMemoryPayloadBytes: readTransferChunkBytes(),
    onChunk: async (chunk) => {
      const nextBytes = receivedBytes + chunk.length;
      if (maxBytes !== null && isServerRoutedTransferOverSizeLimit(nextBytes, maxBytes)) {
        throw new Error(`${SERVER_ROUTED_TRANSFER_SIZE_LIMIT_ERROR}:${maxBytes}`);
      }
      receivedBytes = nextBytes;
      await sink.appendChunk(chunk);
    },
    onFinish: async (manifestHash) => {
      if (maxBytes !== null && isServerRoutedTransferOverSizeLimit(receivedBytes, maxBytes)) {
        throw new Error(`${SERVER_ROUTED_TRANSFER_SIZE_LIMIT_ERROR}:${maxBytes}`);
      }
      const received = await sink.finalize(manifestHash);
      return received;
    },
    onAbort: async () => {
      await sink.abort();
    },
  });
}
