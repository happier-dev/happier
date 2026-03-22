import type { MachineTransferReceiveEnvelope, MachineTransferSendEnvelope } from '@happier-dev/protocol';

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import type { TransferPayloadCodec } from './transferPayloadCodec';
import {
  createBufferTransferPayloadSource,
  readTransferPayloadChunk,
  resolveTransferPayloadManifestHash,
  resolveTransferPayloadSizeBytes,
  type TransferPayloadSource,
} from './transferPayloadSource';
import { createTransferPayloadFileSink, type TransferPayloadFileResult } from './transferPayloadFileSink';
import { readPositiveIntEnv } from '../../utils/readPositiveIntEnv';

const DEFAULT_TRANSFER_TIMEOUT_MS = 90_000;
const DEFAULT_TRANSFER_CHUNK_BYTES = 256 * 1024;
const ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES = 1 + 12 + 16; // version + nonce + auth tag

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
  return readPositiveIntEnv('HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_CHUNK_BYTES', DEFAULT_TRANSFER_CHUNK_BYTES);
}

function estimateBase64DecodedBytes(value: string): number {
  const raw = value.trim();
  if (raw.length === 0) return 0;
  const paddingBytes = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((raw.length * 3) / 4) - paddingBytes);
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
  const chunkBytes = typeof params.chunkBytes === 'number' && params.chunkBytes > 0
    ? params.chunkBytes
    : readTransferChunkBytes();
  const maxBytes = resolveServerRoutedTransferMaxBytes();

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

export function registerTypedServerRoutedTransferResponder<TPayload>(params: Readonly<{
  machineTransferChannel: MachineTransferChannel;
  loadTransferPayload: (transferId: string) => TPayload | null;
  codec: TransferPayloadCodec<TPayload>;
  chunkBytes?: number;
}>): () => void {
  return registerServerRoutedTransferResponder({
    machineTransferChannel: params.machineTransferChannel,
    loadTransferPayloadSource: (transferId) => {
      const payload = params.loadTransferPayload(transferId);
      return payload === null ? null : createBufferTransferPayloadSource(params.codec.encode(payload));
    },
    chunkBytes: params.chunkBytes,
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
    let nextExpectedSequence = 0;
    let envelopeQueue = Promise.resolve();

    const armTimeout = () => {
      if (settled) return;
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for machine transfer ${params.transferId}`));
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
      envelopeQueue = envelopeQueue
        .then(async () => {
          if (settled) {
            return;
          }
          armTimeout();

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
              const estimatedEncryptedBytes = estimateBase64DecodedBytes(chunkEnvelope.payloadBase64);
              const maxEncryptedBytes = params.maxInMemoryPayloadBytes + ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES;
              if (estimatedEncryptedBytes > maxEncryptedBytes) {
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

export async function requestServerRoutedTransferPayload(params: Readonly<{
  transferId: string;
  sourceMachineId: string;
  machineTransferChannel: MachineTransferChannel;
  timeoutMs?: number;
}>): Promise<Buffer> {
  const maxBytes = resolveServerRoutedTransferMaxBytes();
  const inMemoryMaxBytes = resolveInMemoryTransferMaxBytes();
  const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-payload-'));
  const destinationPath = join(tempDir, `payload-${randomUUID()}.bin`);
  const sink = await createTransferPayloadFileSink({ destinationPath });
  let receivedBytes = 0;

  return await requestServerRoutedTransfer({
    ...params,
    maxInMemoryPayloadBytes: inMemoryMaxBytes,
    onChunk: async (chunk, _info) => {
      receivedBytes += chunk.length;
      if (maxBytes !== null && isServerRoutedTransferOverSizeLimit(receivedBytes, maxBytes)) {
        throw new Error(`${SERVER_ROUTED_TRANSFER_SIZE_LIMIT_ERROR}:${maxBytes}`);
      }
      if (receivedBytes > inMemoryMaxBytes) {
        throw new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${inMemoryMaxBytes}`);
      }
      await sink.appendChunk(chunk);
    },
    onFinish: async (manifestHash) => {
      try {
        const received = await sink.finalize(manifestHash);
        if (maxBytes !== null && isServerRoutedTransferOverSizeLimit(received.sizeBytes, maxBytes)) {
          throw new Error(`${SERVER_ROUTED_TRANSFER_SIZE_LIMIT_ERROR}:${maxBytes}`);
        }
        if (received.sizeBytes > inMemoryMaxBytes) {
          throw new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${inMemoryMaxBytes}`);
        }

        const payload = await readFile(received.destinationPath);
        await rm(tempDir, { recursive: true, force: true });
        return payload;
      } catch (error) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },
    onAbort: async () => {
      await sink.abort();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    },
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
  return await requestServerRoutedTransfer({
    ...params,
    onChunk: async (chunk) => {
      await sink.appendChunk(chunk);
    },
    onFinish: async (manifestHash) => {
      const received = await sink.finalize(manifestHash);
      if (isServerRoutedTransferOverSizeLimit(received.sizeBytes, maxBytes)) {
        throw new Error(`${SERVER_ROUTED_TRANSFER_SIZE_LIMIT_ERROR}:${maxBytes}`);
      }
      return received;
    },
    onAbort: async () => {
      await sink.abort();
    },
  });
}

export async function requestTypedServerRoutedTransferPayload<TPayload>(params: Readonly<{
  transferId: string;
  sourceMachineId: string;
  machineTransferChannel: MachineTransferChannel;
  codec: TransferPayloadCodec<TPayload>;
  timeoutMs?: number;
}>): Promise<TPayload> {
  const payload = await requestServerRoutedTransferPayload(params);
  return params.codec.decode({
    transferId: params.transferId,
    payload,
  });
}
