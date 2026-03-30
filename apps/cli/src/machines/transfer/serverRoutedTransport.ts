import { BOX_BUNDLE_PUBLIC_KEY_BYTES, type MachineTransferReceiveEnvelope, type MachineTransferSendEnvelope } from '@happier-dev/protocol';

import { estimateJsonUtf8BytesBounded } from '@/transfers/shared/estimateJsonUtf8BytesBounded';

import {
  isServerRoutedTransferOverSizeLimit,
  resolveServerRoutedTransferMaxBytes,
  SERVER_ROUTED_TRANSFER_SIZE_LIMIT_ERROR,
} from './serverRoutedTransferPolicy';
import { IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR, resolveInMemoryTransferMaxBytes } from './inMemoryTransferSizeLimit';
import { clampTransferChunkBytes } from './transferChunkSizeLimit';
import {
  createEncryptedTransferChunkEnvelope,
  createTransferRecipientKeyPair,
  decryptEncryptedTransferChunkEnvelope,
  parseTransferRecipientPublicKeyBase64,
} from './transferChunkEncryption';
import {
  resolveServerRoutedTransferChunkBytes,
  resolveServerRoutedTransferMaxActiveTransfers,
  resolveServerRoutedTransferOpenPayloadMaxBytes,
  resolveServerRoutedTransferTimeoutMs as resolveServerRoutedTransferTimeoutMsConfig,
} from './transferRuntimeConfig';
import {
  readTransferPayloadChunk,
  resolveTransferPayloadManifestHash,
  resolveTransferPayloadSizeBytes,
  disposeTransferPayloadSource,
  type TransferPayloadSource,
} from './transferPayloadSource';
import { createTransferPayloadFileSink, type TransferPayloadFileResult } from './transferPayloadFileSink';

// Default is intentionally large enough to cover deferred source-export on large workspaces.
const TRANSFER_TIMEOUT_HARD_MAX_MS = 30 * 60_000;
const TRANSFER_OPEN_PAYLOAD_HARD_MAX_BYTES = 64 * 1024;
// Open payloads are small metadata envelopes. Cap nesting depth to prevent stack overflows and
// pathological CPU work when serializing or validating JSON-like payloads.
const TRANSFER_OPEN_PAYLOAD_HARD_MAX_DEPTH = 64;
const ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES = 1 + 12 + 16; // version + nonce + auth tag
// Encrypted data-key envelopes are small and fixed-size today (~105 bytes for V1), but we still
// cap them independently so hostile payloads cannot force large base64 decode allocations.
const ENCRYPTED_TRANSFER_DATA_KEY_ENVELOPE_HARD_MAX_BYTES = 1024;
// Transfers are internal but still untrusted input; cap ids to keep AAD/logging/state bounded.
const TRANSFER_ID_HARD_MAX_CHARS = 256;
// Curve25519 public keys base64-encode to ~44 chars; allow some slack but hard-cap to block
// pathological whitespace/garbage payloads before any crypto/base64 decode work.
const TRANSFER_RECIPIENT_PUBLIC_KEY_BASE64_HARD_MAX_CHARS = 128;
// The only manifest hashes we currently emit are `sha256:<hex>` (~71 chars). Hard-cap to avoid
// pathological string payloads in finish envelopes.
const TRANSFER_MANIFEST_HASH_HARD_MAX_CHARS = 128;
// Request-side open envelopes must include a manifestHash field (protocol shape), but the
// requester does not know the payload's real manifest hash yet. Use a stable, valid sentinel.
const TRANSFER_OPEN_MANIFEST_HASH_SENTINEL = `sha256:${'0'.repeat(64)}`;
const TRANSFER_OPEN_RETRY_INITIAL_DELAY_MS = 200;
const TRANSFER_OPEN_RETRY_MAX_DELAY_MS = 2000;

export type MachineTransferChannel = Readonly<{
  onEnvelope: (listener: (payload: MachineTransferReceiveEnvelope) => void) => () => void;
  sendEnvelope: (payload: MachineTransferSendEnvelope) => void;
}>;

export type ServerRoutedTransferOpenRequest = Readonly<{
  transferId: string;
  openPayload: unknown | undefined;
}>;

export class ServerRoutedInvalidOpenRequestError extends Error {
  readonly code: 'invalid_open_request';

  constructor(message: string) {
    super(message);
    this.name = 'ServerRoutedInvalidOpenRequestError';
    this.code = 'invalid_open_request';
  }
}

export class ServerRoutedAbortTransferError extends Error {
  readonly code: 'abort_transfer';
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? `Server routed transfer aborted: ${reason}`);
    this.name = 'ServerRoutedAbortTransferError';
    this.code = 'abort_transfer';
    this.reason = reason;
  }
}

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
  timeoutMs: number;
  timeoutNonce: number;
  timeout: NodeJS.Timeout | null;
}>;

function readTransferTimeoutMs(): number {
  return resolveServerRoutedTransferTimeoutMsConfig();
}

export function resolveServerRoutedTransferTimeoutMs(): number {
  return readTransferTimeoutMs();
}

function readTransferMaxActiveTransfers(): number {
  return resolveServerRoutedTransferMaxActiveTransfers();
}

function clampTransferTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return readTransferTimeoutMs();
  }
  return Math.min(timeoutMs, TRANSFER_TIMEOUT_HARD_MAX_MS);
}

function readTransferChunkBytes(): number {
  return resolveServerRoutedTransferChunkBytes();
}

function readTransferOpenPayloadMaxBytes(): number {
  return resolveServerRoutedTransferOpenPayloadMaxBytes();
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

function assertOpenPayloadDepthBounded(value: unknown): void {
  const seenObjects = new Set<object>();
  const stack: Array<Readonly<{ value: unknown; depth: number }>> = [{ value, depth: 0 }];

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;

    if (next.depth > TRANSFER_OPEN_PAYLOAD_HARD_MAX_DEPTH) {
      throw new Error(`Open payload exceeds max depth (${next.depth} > ${TRANSFER_OPEN_PAYLOAD_HARD_MAX_DEPTH})`);
    }

    const nextValue = next.value;
    if (nextValue === null) continue;

    if (Array.isArray(nextValue)) {
      if (seenObjects.has(nextValue)) continue;
      seenObjects.add(nextValue);
      for (let i = 0; i < nextValue.length; i += 1) {
        stack.push({ value: nextValue[i], depth: next.depth + 1 });
      }
      continue;
    }

    if (typeof nextValue === 'object') {
      const obj = nextValue as object;
      if (seenObjects.has(obj)) continue;
      seenObjects.add(obj);
      const record = obj as Record<string, unknown>;
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        stack.push({ value: record[key], depth: next.depth + 1 });
      }
    }
  }
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
  openPayloadBase64?: string;
}>): MachineTransferSendOpenEnvelope {
  return {
    transferId: input.transferId,
    kind: 'open',
    manifestHash: input.manifestHash,
    recipientPublicKeyBase64: input.recipientPublicKeyBase64,
    ...(typeof input.openPayloadBase64 === 'string' ? { openPayloadBase64: input.openPayloadBase64 } : {}),
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
  loadTransferPayloadSource: (
    request: ServerRoutedTransferOpenRequest,
  ) => TransferPayloadSource | null | Promise<TransferPayloadSource | null>;
  chunkBytes?: number;
}>): () => void {
  const activeTransfers = new Map<string, ActiveTransferState>();
  const pendingOpenTransfers = new Set<string>();
  const chunkBytes = clampTransferChunkBytes(typeof params.chunkBytes === 'number' && params.chunkBytes > 0
    ? params.chunkBytes
    : readTransferChunkBytes());
  const defaultTimeoutMs = readTransferTimeoutMs();
  const maxActiveTransfers = readTransferMaxActiveTransfers();
  const maxBytes = resolveServerRoutedTransferMaxBytes();
  const inMemoryMaxBytes = resolveInMemoryTransferMaxBytes();
  const openPayloadMaxBytes = readTransferOpenPayloadMaxBytes();

  const decodeOpenPayload = (payloadBase64: string): unknown => {
    // Fail closed on *encoded* size before any base64 decode. Node's base64 decoder is permissive
    // about whitespace, so a hostile peer could otherwise send a tiny decoded payload padded with
    // a huge amount of ASCII whitespace and still pass a decoded-bytes check.
    const maxEncodedChars = Math.ceil(openPayloadMaxBytes / 3) * 4;
    if (payloadBase64.length > maxEncodedChars) {
      throw new ServerRoutedInvalidOpenRequestError('Open payload exceeds max bytes');
    }

    const estimatedDecodedBytes = estimateBase64DecodedBytes(payloadBase64);
    if (!Number.isFinite(estimatedDecodedBytes) || estimatedDecodedBytes > openPayloadMaxBytes) {
      throw new ServerRoutedInvalidOpenRequestError('Open payload exceeds max bytes');
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(payloadBase64, 'base64');
    } catch {
      throw new ServerRoutedInvalidOpenRequestError('Invalid open payload encoding');
    }
    if (decoded.byteLength > openPayloadMaxBytes) {
      throw new ServerRoutedInvalidOpenRequestError('Open payload exceeds max bytes');
    }
    try {
      return JSON.parse(decoded.toString('utf8')) as unknown;
    } catch {
      throw new ServerRoutedInvalidOpenRequestError('Invalid open payload');
    }
  };

  const resolveInvalidOpenPayloadReason = (error: ServerRoutedInvalidOpenRequestError): string => {
    // Keep reasons non-sensitive while still distinguishing common QA failures.
    if (error.message.toLowerCase().includes('exceeds max bytes')) {
      return 'invalid_open_request:open_payload_too_large';
    }
    return 'invalid_open_request:open_payload_invalid';
  };

  const cleanupTransfer = (transferId: string, state: ActiveTransferState | null): void => {
    if (!state) {
      return;
    }
    if (state.timeout) {
      clearTimeout(state.timeout);
    }
    activeTransfers.delete(transferId);
    void disposeTransferPayloadSource(state.payloadSource).catch(() => undefined);
  };

  const rearmTransferTimeout = (transferId: string, state: ActiveTransferState): ActiveTransferState => {
    const nextNonce = state.timeoutNonce + 1;
    if (state.timeout) {
      clearTimeout(state.timeout);
    }
    const localNonce = nextNonce;
    const timeout = setTimeout(() => {
      const current = activeTransfers.get(transferId);
      if (!current || current.timeoutNonce !== localNonce) {
        return;
      }
      cleanupTransfer(transferId, current);
      params.machineTransferChannel.sendEnvelope({
        targetMachineId: current.targetMachineId,
        envelope: {
          transferId,
          kind: 'abort',
          reason: 'timeout',
        },
      });
    }, state.timeoutMs);
    return {
      ...state,
      timeoutNonce: nextNonce,
      timeout,
    };
  };

  return params.machineTransferChannel.onEnvelope((payload) => {
    void (async () => {
	    const envelope = payload.envelope;
	    if (isReceiveOpenEnvelope(envelope)) {
        const transferId = envelope.transferId;
	      if (envelope.transferId.length === 0 || envelope.transferId.length > TRANSFER_ID_HARD_MAX_CHARS) {
	        params.machineTransferChannel.sendEnvelope({
	          targetMachineId: payload.sourceMachineId,
	          envelope: {
	            transferId: envelope.transferId,
	            kind: 'abort',
	            reason: 'invalid_open_request:transfer_id_out_of_range',
	          },
	        });
	        return;
	      }
	        const existing = activeTransfers.get(transferId) ?? null;
	        if (existing) {
	          // Idempotent open: ignore duplicate opens while the transfer is in progress.
	          return;
	        }
	        if (pendingOpenTransfers.has(transferId)) {
	          // Another open is already being processed (payload lookup / validation). Ignore retries
	          // so requesters can safely re-send opens if the original was dropped.
	          return;
	        }
	        if (activeTransfers.size + pendingOpenTransfers.size >= maxActiveTransfers) {
	          params.machineTransferChannel.sendEnvelope({
	            targetMachineId: payload.sourceMachineId,
	            envelope: {
	              transferId,
	              kind: 'abort',
	              reason: 'active-transfer-limit',
	            },
	          });
	          return;
	        }
	        pendingOpenTransfers.add(transferId);

        try {
	      if (envelope.openPayloadBase64 !== undefined && typeof envelope.openPayloadBase64 !== 'string') {
	        params.machineTransferChannel.sendEnvelope({
	          targetMachineId: payload.sourceMachineId,
	          envelope: {
	            transferId: envelope.transferId,
	            kind: 'abort',
	            reason: 'invalid_open_request:open_payload_invalid',
	          },
	        });
	        return;
	      }
	      if (
	        typeof envelope.recipientPublicKeyBase64 !== 'string'
	        || envelope.recipientPublicKeyBase64.length === 0
	      ) {
	        params.machineTransferChannel.sendEnvelope({
	          targetMachineId: payload.sourceMachineId,
	          envelope: {
	            transferId: envelope.transferId,
	            kind: 'abort',
	            reason: 'invalid_open_request:recipient_public_key_missing',
	          },
	        });
	        return;
	      }
	      if (envelope.recipientPublicKeyBase64.length > TRANSFER_RECIPIENT_PUBLIC_KEY_BASE64_HARD_MAX_CHARS) {
	        params.machineTransferChannel.sendEnvelope({
	          targetMachineId: payload.sourceMachineId,
	          envelope: {
	            transferId: envelope.transferId,
	            kind: 'abort',
	            reason: 'invalid_open_request:recipient_public_key_too_long',
	          },
	        });
	        return;
	      }
	      const estimatedRecipientPublicKeyBytes = estimateBase64DecodedBytes(envelope.recipientPublicKeyBase64);
	      if (estimatedRecipientPublicKeyBytes !== BOX_BUNDLE_PUBLIC_KEY_BYTES) {
	        params.machineTransferChannel.sendEnvelope({
	          targetMachineId: payload.sourceMachineId,
	          envelope: {
	            transferId: envelope.transferId,
	            kind: 'abort',
	            reason: 'invalid_open_request:recipient_public_key_invalid',
	          },
	        });
	        return;
	      }
	      try {
	        // Validate character set + exact decoded length without streaming any payload bytes.
	        parseTransferRecipientPublicKeyBase64(envelope.recipientPublicKeyBase64);
	      } catch {
	        params.machineTransferChannel.sendEnvelope({
	          targetMachineId: payload.sourceMachineId,
	          envelope: {
	            transferId: envelope.transferId,
	            kind: 'abort',
	            reason: 'invalid_open_request:recipient_public_key_invalid',
	          },
	        });
	        return;
	      }
		      let openPayload: unknown | undefined;
		      try {
		        openPayload = envelope.openPayloadBase64 ? decodeOpenPayload(envelope.openPayloadBase64) : undefined;
		      } catch (error) {
	        if (error instanceof ServerRoutedInvalidOpenRequestError) {
	          params.machineTransferChannel.sendEnvelope({
	            targetMachineId: payload.sourceMachineId,
	            envelope: {
	              transferId: envelope.transferId,
	              kind: 'abort',
	              reason: resolveInvalidOpenPayloadReason(error),
	            },
	          });
	          return;
	        }
	        throw error;
	      }

        const resolveTransferTimeoutMs = (value: unknown): number => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return defaultTimeoutMs;
          }
          const raw = (value as Record<string, unknown>).timeoutMs;
          if (typeof raw !== 'number' || !Number.isFinite(raw)) {
            return defaultTimeoutMs;
          }
          const floored = Math.floor(raw);
          if (floored <= 0) {
            return defaultTimeoutMs;
          }
          return clampTransferTimeoutMs(floored);
        };

        const transferTimeoutMs = resolveTransferTimeoutMs(openPayload);

        let transferPayloadSource: TransferPayloadSource | null = null;
        try {
          try {
            transferPayloadSource = await params.loadTransferPayloadSource({
              transferId: envelope.transferId,
              openPayload,
            });
	          } catch (error) {
	            if (error instanceof ServerRoutedInvalidOpenRequestError) {
	              params.machineTransferChannel.sendEnvelope({
	                targetMachineId: payload.sourceMachineId,
	                envelope: {
	                  transferId: envelope.transferId,
	                  kind: 'abort',
	                  reason: 'invalid_open_request:open_payload_invalid',
	                },
	              });
	              return;
	            }
		            if (error instanceof ServerRoutedAbortTransferError) {
		              params.machineTransferChannel.sendEnvelope({
		                targetMachineId: payload.sourceMachineId,
		                envelope: {
		                  transferId: envelope.transferId,
		                  kind: 'abort',
		                  reason: error.reason,
		                },
		              });
		              return;
		            }

		            const rawMessage = error instanceof Error ? (error.message || error.name) : String(error);
		            const sanitized = rawMessage.replace(/\s+/gu, ' ').slice(0, 200);
		            try {
		              const { logger } = await import('@/utils/logger');
		              logger.debug('[MACHINE TRANSFER] Unexpected server-routed responder failure', {
		                transferId: envelope.transferId,
		                error: sanitized,
		              });
		            } catch {
		              // Best-effort: logging must not interfere with aborting the transfer.
		            }
		            params.machineTransferChannel.sendEnvelope({
		              targetMachineId: payload.sourceMachineId,
		              envelope: {
		                transferId: envelope.transferId,
		                kind: 'abort',
		                reason: 'internal_error',
	              },
	            });
	            return;
	          }

          if (!transferPayloadSource) {
            params.machineTransferChannel.sendEnvelope({
              targetMachineId: payload.sourceMachineId,
              envelope: {
                transferId: envelope.transferId,
                kind: 'abort',
                reason: 'transfer_not_found',
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
          cleanupTransfer(envelope.transferId, existing);

          const stateBase: ActiveTransferState = {
            targetMachineId: payload.sourceMachineId,
            payloadSource: transferPayloadSource,
            manifestHash: await resolveTransferPayloadManifestHash(transferPayloadSource),
            chunkBytes,
            totalChunks,
            nextSequenceToSend: 0,
            recipientPublicKeyBase64: envelope.recipientPublicKeyBase64,
            timeoutMs: transferTimeoutMs,
            timeoutNonce: 0,
            timeout: null,
          };

          const state = rearmTransferTimeout(envelope.transferId, stateBase);
          activeTransfers.set(envelope.transferId, state);

          // Ownership transferred to `activeTransfers`; abort paths in this block must dispose.
          transferPayloadSource = null;

          await sendTransferChunk({
            machineTransferChannel: params.machineTransferChannel,
            transferId: envelope.transferId,
            state,
          });
          return;
        } finally {
          if (transferPayloadSource) {
            await disposeTransferPayloadSource(transferPayloadSource).catch(() => undefined);
          }
        }
        } finally {
          pendingOpenTransfers.delete(transferId);
        }
    }

    if (envelope.kind === 'abort') {
      const current = activeTransfers.get(envelope.transferId);
      if (!current || current.targetMachineId !== payload.sourceMachineId) {
        return;
      }
      cleanupTransfer(envelope.transferId, current);
      return;
    }

    if (envelope.kind !== 'ack') return;
    const current = activeTransfers.get(envelope.transferId);
    if (!current || current.targetMachineId !== payload.sourceMachineId) {
      return;
    }
    const rearmedCurrent = rearmTransferTimeout(envelope.transferId, current);
    activeTransfers.set(envelope.transferId, rearmedCurrent);
    if (!Number.isInteger(envelope.nextSequence) || envelope.nextSequence < 0) {
      cleanupTransfer(envelope.transferId, rearmedCurrent);
      params.machineTransferChannel.sendEnvelope({
        targetMachineId: payload.sourceMachineId,
        envelope: {
          transferId: envelope.transferId,
          kind: 'abort',
          reason: `invalid_ack_sequence:${String(envelope.nextSequence)}`,
        },
      });
      return;
    }
    if (envelope.nextSequence <= current.nextSequenceToSend) {
      return;
    }
    const nextState: ActiveTransferState = {
      ...rearmedCurrent,
      nextSequenceToSend: envelope.nextSequence,
    };
    if (nextState.nextSequenceToSend > nextState.totalChunks) {
      cleanupTransfer(envelope.transferId, nextState);
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
    await sendTransferChunk({
      machineTransferChannel: params.machineTransferChannel,
      transferId: envelope.transferId,
      state: nextState,
    });
    if (nextState.nextSequenceToSend >= nextState.totalChunks) {
      cleanupTransfer(envelope.transferId, nextState);
    } else {
      activeTransfers.set(envelope.transferId, rearmTransferTimeout(envelope.transferId, nextState));
    }
    })().catch((error) => {
      const transferId = payload.envelope.transferId;
      const current = activeTransfers.get(transferId) ?? null;
      cleanupTransfer(transferId, current);
      params.machineTransferChannel.sendEnvelope({
        targetMachineId: payload.sourceMachineId,
        envelope: {
          transferId,
          kind: 'abort',
          reason: 'transfer_failed',
        },
      });
    });
  });
}

async function requestServerRoutedTransfer<TPayload>(params: Readonly<{
  transferId: string;
  sourceMachineId: string;
  machineTransferChannel: MachineTransferChannel;
  openBody?: unknown;
  timeoutMs?: number;
  maxInMemoryPayloadBytes?: number;
  maxTotalBytes?: number | null;
  onChunk: (chunk: Buffer, info: Readonly<{ sequence: number }>) => Promise<void> | void;
  onFinish: (manifestHash: string) => Promise<TPayload>;
  onAbort?: () => Promise<void> | void;
}>): Promise<TPayload> {
  const timeoutMs = clampTransferTimeoutMs(typeof params.timeoutMs === 'number' ? params.timeoutMs : readTransferTimeoutMs());
  const recipientKeyPair = createTransferRecipientKeyPair();
  if (params.transferId.length === 0 || params.transferId.length > TRANSFER_ID_HARD_MAX_CHARS) {
    throw new Error(`Invalid transfer id length (${params.transferId.length})`);
  }
  const openPayloadMaxBytes = readTransferOpenPayloadMaxBytes();
  let openPayloadBase64: string | undefined;
  if (params.openBody !== undefined) {
    assertOpenPayloadDepthBounded(params.openBody);
    const estimatedBytes = estimateJsonUtf8BytesBounded(params.openBody, openPayloadMaxBytes);
    if (!Number.isFinite(estimatedBytes) || estimatedBytes > openPayloadMaxBytes) {
      throw new Error(`Open payload exceeds max bytes (${estimatedBytes} > ${openPayloadMaxBytes})`);
    }
    const encoded = Buffer.from(JSON.stringify(params.openBody), 'utf8');
    if (encoded.byteLength > openPayloadMaxBytes) {
      throw new Error(`Open payload exceeds max bytes (${encoded.byteLength} > ${openPayloadMaxBytes})`);
    }
    openPayloadBase64 = encoded.toString('base64');
  }
  return await new Promise<TPayload>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let timeoutNonce = 0;
    let nextExpectedSequence = 0;
    let receivedBytes = 0;
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
              const maxEncodedChars = Math.ceil(maxEncryptedPayloadBytes / 3) * 4;
              const maxDataKeyEnvelopeEncodedChars = Math.ceil(ENCRYPTED_TRANSFER_DATA_KEY_ENVELOPE_HARD_MAX_BYTES / 3) * 4;
              if (
                chunkEnvelope.payloadBase64.length > maxEncodedChars
                || encryptedDataKeyEnvelopeBase64.length > maxDataKeyEnvelopeEncodedChars
              ) {
                throw new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${params.maxInMemoryPayloadBytes}`);
              }
              const estimatedEncryptedPayloadBytes = estimateBase64DecodedBytes(chunkEnvelope.payloadBase64);
              const estimatedEncryptedDataKeyEnvelopeBytes = estimateBase64DecodedBytes(encryptedDataKeyEnvelopeBase64);
              if (
                estimatedEncryptedPayloadBytes > maxEncryptedPayloadBytes
                || estimatedEncryptedDataKeyEnvelopeBytes > ENCRYPTED_TRANSFER_DATA_KEY_ENVELOPE_HARD_MAX_BYTES
              ) {
                throw new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${params.maxInMemoryPayloadBytes}`);
              }

              // Enforce max-bytes before decrypting so oversized transfers cannot force expensive crypto work.
              if (params.maxTotalBytes !== null && typeof params.maxTotalBytes === 'number' && params.maxTotalBytes > 0) {
                const estimatedPlainBytes = Math.max(
                  0,
                  estimatedEncryptedPayloadBytes - ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES,
                );
                if (isServerRoutedTransferOverSizeLimit(receivedBytes + estimatedPlainBytes, params.maxTotalBytes)) {
                  throw new Error(`${SERVER_ROUTED_TRANSFER_SIZE_LIMIT_ERROR}:${params.maxTotalBytes}`);
                }
              }
            }
            const decrypted = decryptEncryptedTransferChunkEnvelope({
              transferId: params.transferId,
              sequence: chunkEnvelope.sequence,
              payloadBase64: chunkEnvelope.payloadBase64,
              encryptedDataKeyEnvelopeBase64,
              recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            });
            await params.onChunk(decrypted, {
              sequence: chunkEnvelope.sequence,
            });
            receivedBytes += decrypted.length;
            nextExpectedSequence = chunkEnvelope.sequence + 1;
            params.machineTransferChannel.sendEnvelope({
              targetMachineId: params.sourceMachineId,
              envelope: {
                transferId: params.transferId,
                kind: 'ack',
                nextSequence: nextExpectedSequence,
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
            const manifestHash = payload.envelope.manifestHash;
            if (manifestHash.length === 0 || manifestHash.length > TRANSFER_MANIFEST_HASH_HARD_MAX_CHARS) {
              throw new Error('Invalid transfer manifest hash');
            }
            const result = await params.onFinish(payload.envelope.manifestHash);
            cleanup();
            resolve(result);
          }
        })
        .catch((error) => {
          if (settled) {
            return;
          }
          // Best-effort abort back to the source so responders can drop `activeTransfers` state even
          // when the recipient fails locally (disk error, policy mismatch, malformed envelope, etc).
          // This prevents leaked responder state waiting forever on an ack that will never arrive.
          try {
            params.machineTransferChannel.sendEnvelope({
              targetMachineId: params.sourceMachineId,
              envelope: {
                transferId: params.transferId,
                kind: 'abort',
                reason: 'recipient_error',
              },
            });
          } catch {
            // Ignore send errors; we'll still tear down local resources and reject.
          }
          cleanup();
          void Promise.resolve(params.onAbort?.()).catch(() => undefined).finally(() => {
            reject(error instanceof Error ? error : new Error(`Machine transfer failed for ${params.transferId}`));
          });
        });
    });

    armTimeout();

    params.machineTransferChannel.sendEnvelope({
      targetMachineId: params.sourceMachineId,
      envelope: createSendOpenEnvelope({
        transferId: params.transferId,
        manifestHash: TRANSFER_OPEN_MANIFEST_HASH_SENTINEL,
        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
        ...(openPayloadBase64 ? { openPayloadBase64 } : {}),
      }),
    });
  });
}

export async function requestServerRoutedTransferToFile(params: Readonly<{
  transferId: string;
  sourceMachineId: string;
  machineTransferChannel: MachineTransferChannel;
  destinationPath: string;
  openBody?: unknown;
  timeoutMs?: number;
}>): Promise<TransferPayloadFileResult> {
  const maxBytes = resolveServerRoutedTransferMaxBytes();
  const sink = await createTransferPayloadFileSink({
    destinationPath: params.destinationPath,
  });
  let receivedBytes = 0;
  try {
    return await requestServerRoutedTransfer({
      ...params,
      // File-backed transfers are still bounded per chunk to avoid OOM, but they must not be constrained
      // by the small-only whole-buffer in-memory cap (`HAPPIER_FILES_READ_MAX_BYTES`).
      maxInMemoryPayloadBytes: readTransferChunkBytes(),
      maxTotalBytes: maxBytes,
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
  } catch (error) {
    await sink.abort().catch(() => undefined);
    throw error;
  }
}
