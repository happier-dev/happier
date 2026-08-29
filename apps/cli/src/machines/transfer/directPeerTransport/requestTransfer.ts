import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '../transferChunkEncryption';
import { createTransferPayloadFileSink, type TransferPayloadFileResult } from '../transferPayloadFileSink';
import {
  resolveDirectPeerTransferChunkBytes,
  resolveDirectPeerTransferExpirySkewMs,
  resolveDirectPeerTransferOpenBodyMaxBytes,
  resolveDirectPeerTransferMaxTotalChunks,
  resolveDirectPeerTransferRequestTimeoutOverrideMs as resolveDirectPeerTransferRequestTimeoutOverrideMsConfig,
} from '../transferRuntimeConfig';
import { IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR } from '../inMemoryTransferSizeLimit';
import { estimateJsonUtf8BytesBounded } from '@/transfers/shared/estimateJsonUtf8BytesBounded';

import {
  isSafeDirectTransferEndpointCandidate,
  TransferChunkEnvelopeSchema,
  TransferEndpointCandidateSchema,
  type TransferEndpointCandidate,
} from '@happier-dev/protocol';
import { z } from 'zod';

import {
  DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER,
  extractDirectPeerRequestAuth,
} from './protocol';

const DIRECT_PEER_CHUNK_HARD_MAX_BYTES = 512 * 1024;
const DIRECT_PEER_OPEN_RESPONSE_MAX_BYTES = 8 * 1024;
const DIRECT_PEER_JSON_RESPONSE_PREALLOC_MAX_BYTES = DIRECT_PEER_CHUNK_HARD_MAX_BYTES;
const ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES = 1 + 12 + 16;
const ENCRYPTED_TRANSFER_DATA_KEY_ENVELOPE_HARD_MAX_BYTES = 1024;
const DIRECT_PEER_OPEN_BODY_STREAMING_THRESHOLD_BYTES = 8 * 1024;
const DIRECT_PEER_REQUEST_RETRY_ATTEMPTS = 3;
const DIRECT_PEER_REQUEST_RETRY_DELAY_MS = 150;

const DirectPeerTransferResponseSchema = z
  .object({
    transferId: z.string().min(1),
    manifestHash: z.string().min(1),
    totalChunks: z.number().int().positive(),
    sizeBytes: z.number().int().nonnegative().optional(),
    name: z.string().min(1).optional(),
  })
  .strict();

function readDirectPeerChunkBytes(): number {
  return resolveDirectPeerTransferChunkBytes();
}

function readDirectPeerExpirySkewMs(): number {
  return resolveDirectPeerTransferExpirySkewMs();
}

function readDirectPeerOpenBodyMaxBytes(): number {
  return resolveDirectPeerTransferOpenBodyMaxBytes();
}

function readDirectPeerMaxTotalChunks(): number {
  return resolveDirectPeerTransferMaxTotalChunks();
}

function resolveDirectPeerRequestTimeoutOverrideMs(timeoutMs: number | undefined): number {
  return resolveDirectPeerTransferRequestTimeoutOverrideMsConfig(timeoutMs);
}

function createInvalidDirectPeerTransferResponseError(transferId: string): Error {
  return new Error(`Invalid direct peer transfer response for ${transferId}`);
}

function createDirectPeerTransferCommitmentMismatchError(transferId: string): Error {
  return new Error(`Direct peer transfer commitment mismatch for ${transferId}`);
}

export function isDirectPeerTransferProtocolError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith('Invalid direct peer transfer response for ')
    || error.message.startsWith('Direct peer transfer manifest mismatch for ')
    || error.message.startsWith('Direct peer transfer commitment mismatch for ')
  );
}

function isRetryableDirectPeerTransferRequestError(error: unknown): boolean {
  if (isDirectPeerTransferProtocolError(error)) {
    return false;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true;
  }
  if (error.message.includes('status 503')) {
    return true;
  }
  return error.message.includes('fetch failed');
}

function waitForDirectPeerTransferRetryDelay(delayMs: number): Promise<void> {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function estimateBase64DecodedBytes(value: string): number {
  let start = 0;
  let end = value.length - 1;
  while (start <= end && isBase64TrimChar(value.charCodeAt(start))) start += 1;
  while (end >= start && isBase64TrimChar(value.charCodeAt(end))) end -= 1;
  if (end < start) return 0;
  const trimmedLength = end - start + 1;
  const last = value.charCodeAt(end);
  const paddingBytes = last === 0x3d
    ? (end - 1 >= start && value.charCodeAt(end - 1) === 0x3d ? 2 : 1)
    : 0;
  return Math.max(0, Math.floor((trimmedLength * 3) / 4) - paddingBytes);
}

function resolveBase64TrimmedLength(value: string): number {
  let start = 0;
  let end = value.length - 1;
  while (start <= end && isBase64TrimChar(value.charCodeAt(start))) start += 1;
  while (end >= start && isBase64TrimChar(value.charCodeAt(end))) end -= 1;
  return end < start ? 0 : end - start + 1;
}

function isBase64TrimChar(code: number): boolean {
  return code <= 0x20 || code === 0xfeff;
}

function isJsonContentType(contentType: string | null): boolean {
  const normalized = String(contentType ?? '').trim().toLowerCase();
  return normalized.startsWith('application/json');
}

async function readJsonResponseWithBodyLimit(params: Readonly<{
  response: Response;
  maxBodyBytes: number;
  onInvalidJson: () => Error;
  onOverLimit: () => Error;
}>): Promise<unknown> {
  const contentLength = params.response.headers.get('content-length');
  const parsedContentLength = contentLength ? Number.parseInt(contentLength, 10) : NaN;
  const expectedBytes =
    Number.isFinite(parsedContentLength) && parsedContentLength >= 0
      ? Math.floor(parsedContentLength)
      : null;
  if (expectedBytes != null && expectedBytes > params.maxBodyBytes) {
    throw params.onOverLimit();
  }

  const body = params.response.body;
  if (!body) {
    throw params.onInvalidJson();
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');

  const cancelBestEffort = async () => {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  };

  let bytes: Uint8Array | null = null;
  if (expectedBytes != null) {
    const preallocatedBytes = Math.min(
      expectedBytes,
      params.maxBodyBytes,
      DIRECT_PEER_JSON_RESPONSE_PREALLOC_MAX_BYTES,
    );
    const buffer = new Uint8Array(preallocatedBytes);
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const nextOffset = offset + value.byteLength;
      if (nextOffset > params.maxBodyBytes) {
        await cancelBestEffort();
        throw params.onOverLimit();
      }

      if (nextOffset <= buffer.byteLength) {
        buffer.set(value, offset);
        offset = nextOffset;
        continue;
      }

      let grown = buffer;
      let grownOffset = offset;
      const ensureCapacity = (needed: number) => {
        if (needed <= grown.byteLength) return;
        const minCapacity = grown.byteLength > 0 ? grown.byteLength : Math.min(16 * 1024, params.maxBodyBytes);
        let nextCapacity = Math.max(1, minCapacity);
        while (nextCapacity < needed) {
          nextCapacity *= 2;
        }
        nextCapacity = Math.min(nextCapacity, params.maxBodyBytes);
        if (nextCapacity < needed) nextCapacity = needed;
        const nextBuffer = new Uint8Array(nextCapacity);
        nextBuffer.set(grown.subarray(0, grownOffset), 0);
        grown = nextBuffer;
      };

      ensureCapacity(nextOffset);
      grown.set(value, grownOffset);
      grownOffset = nextOffset;

      while (true) {
        const res = await reader.read();
        if (res.done) break;
        if (!res.value) continue;
        const next = grownOffset + res.value.byteLength;
        if (next > params.maxBodyBytes) {
          await cancelBestEffort();
          throw params.onOverLimit();
        }
        ensureCapacity(next);
        grown.set(res.value, grownOffset);
        grownOffset = next;
      }

      bytes = grown.subarray(0, grownOffset);
      offset = grownOffset;
      break;
    }

    if (!bytes) {
      bytes = buffer.subarray(0, offset);
    }
  } else {
    const initialCapacity = Math.min(16 * 1024, params.maxBodyBytes);
    let buffer = new Uint8Array(initialCapacity);
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const nextOffset = offset + value.byteLength;
      if (nextOffset > params.maxBodyBytes) {
        await cancelBestEffort();
        throw params.onOverLimit();
      }

      if (nextOffset > buffer.byteLength) {
        let nextCapacity = buffer.byteLength;
        while (nextCapacity < nextOffset) {
          nextCapacity *= 2;
        }
        nextCapacity = Math.min(nextCapacity, params.maxBodyBytes);
        if (nextCapacity < nextOffset) {
          nextCapacity = nextOffset;
        }
        const nextBuffer = new Uint8Array(nextCapacity);
        nextBuffer.set(buffer.subarray(0, offset), 0);
        buffer = nextBuffer;
      }

      buffer.set(value, offset);
      offset = nextOffset;
    }

    bytes = buffer.subarray(0, offset);
  }

  if (!bytes || bytes.byteLength === 0) {
    throw params.onInvalidJson();
  }
  const text = decoder.decode(bytes);
  bytes = null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw params.onInvalidJson();
  }
}

function resolveDirectPeerJsonBodyMaxBytes(maxInMemoryPayloadBytes: number): number {
  if (!Number.isFinite(maxInMemoryPayloadBytes) || maxInMemoryPayloadBytes <= 0) {
    throw new Error(`Invalid direct peer maxInMemoryPayloadBytes: ${String(maxInMemoryPayloadBytes)}`);
  }
  const maxBytes = Math.floor(maxInMemoryPayloadBytes);
  const maxEncryptedBytes = maxBytes + ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES;
  const maxEncodedChars = Math.ceil(maxEncryptedBytes / 3) * 4;
  const maxDataKeyEnvelopeBase64Chars = 4 * 1024;
  const jsonOverheadBytes = 4 * 1024;
  return maxEncodedChars + maxDataKeyEnvelopeBase64Chars + jsonOverheadBytes;
}

function* escapeJsonStringChunks(value: string): Generator<string> {
  let runStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const isSurrogate = codeUnit >= 0xd800 && codeUnit <= 0xdfff;
    if (codeUnit === 0x22 || codeUnit === 0x5c || codeUnit <= 0x1f || isSurrogate) {
      if (runStart < index) {
        yield value.slice(runStart, index);
      }
      switch (codeUnit) {
        case 0x22:
          yield '\\"';
          break;
        case 0x5c:
          yield '\\\\';
          break;
        case 0x08:
          yield '\\b';
          break;
        case 0x0c:
          yield '\\f';
          break;
        case 0x0a:
          yield '\\n';
          break;
        case 0x0d:
          yield '\\r';
          break;
        case 0x09:
          yield '\\t';
          break;
        default:
          yield `\\u${codeUnit.toString(16).padStart(4, '0')}`;
          break;
      }
      runStart = index + 1;
    }
  }
  if (runStart < value.length) {
    yield value.slice(runStart);
  }
}

function* iterateDirectPeerJsonChunks(value: unknown, seenObjects = new Set<object>()): Generator<string> {
  if (value === null) {
    yield 'null';
    return;
  }
  if (typeof value === 'string') {
    yield '"';
    yield* escapeJsonStringChunks(value);
    yield '"';
    return;
  }
  if (typeof value === 'boolean') {
    yield value ? 'true' : 'false';
    return;
  }
  if (typeof value === 'number') {
    yield Number.isFinite(value) ? String(value) : 'null';
    return;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    yield 'null';
    return;
  }
  if (typeof value === 'bigint') {
    throw new Error('Invalid direct peer transfer request');
  }

  if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) {
        yield ',';
      }
      const item = value[index];
      if (typeof item === 'undefined' || typeof item === 'function' || typeof item === 'symbol') {
        yield 'null';
      } else {
        yield* iterateDirectPeerJsonChunks(item, seenObjects);
      }
    }
    yield ']';
    return;
  }

  const obj = value as Record<string, unknown>;
  if (seenObjects.has(obj)) {
    throw new Error('Invalid direct peer transfer request');
  }
  seenObjects.add(obj);
  try {
    const toJSON = obj.toJSON;
    if (typeof toJSON === 'function') {
      yield* iterateDirectPeerJsonChunks(toJSON.call(obj), seenObjects);
      return;
    }

    yield '{';
    let wroteAny = false;
    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      const propertyValue = obj[key];
      if (typeof propertyValue === 'undefined' || typeof propertyValue === 'function' || typeof propertyValue === 'symbol') {
        continue;
      }
      if (wroteAny) {
        yield ',';
      }
      wroteAny = true;
      yield '"';
      yield* escapeJsonStringChunks(key);
      yield '":';
      yield* iterateDirectPeerJsonChunks(propertyValue, seenObjects);
    }
    yield '}';
  } finally {
    seenObjects.delete(obj);
  }
}

function serializeDirectPeerOpenRequestBodyToBytes(params: Readonly<{
  openBody: unknown;
  estimatedBytes: number;
  maxBodyBytes: number;
}>): Uint8Array<ArrayBuffer> {
  const maxBodyBytes = Math.max(0, Math.floor(params.maxBodyBytes));
  const estimatedBytes = Math.max(0, Math.floor(params.estimatedBytes));
  const initialCapacity = Math.min(Math.max(256, estimatedBytes), maxBodyBytes);

  const encoder = new TextEncoder();
  let buffer = new Uint8Array(initialCapacity);
  let offset = 0;

  const ensureCapacity = (needed: number) => {
    if (needed <= buffer.byteLength) return;
    let nextCapacity = Math.max(1, buffer.byteLength);
    while (nextCapacity < needed) {
      nextCapacity *= 2;
    }
    nextCapacity = Math.min(nextCapacity, maxBodyBytes);
    if (nextCapacity < needed) {
      nextCapacity = needed;
    }
    const nextBuffer = new Uint8Array(nextCapacity);
    nextBuffer.set(buffer.subarray(0, offset), 0);
    buffer = nextBuffer;
  };

  for (const chunk of iterateDirectPeerJsonChunks(params.openBody)) {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    const nextOffset = offset + chunkBytes;
    if (nextOffset > maxBodyBytes) {
      throw new Error(`Direct peer transfer open request body exceeds the configured body-limit (${maxBodyBytes} bytes)`);
    }
    ensureCapacity(nextOffset);
    const target = buffer.subarray(offset, nextOffset);
    const { read, written } = encoder.encodeInto(chunk, target);
    if (read !== chunk.length || written !== chunkBytes) {
      throw new Error('Invalid direct peer transfer request');
    }
    offset = nextOffset;
  }

  return buffer.subarray(0, offset);
}

function createDirectPeerOpenRequestBodyStream(params: Readonly<{ openBody: unknown; maxBodyBytes: number }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = iterateDirectPeerJsonChunks(params.openBody);
  const maxBodyBytes = Math.max(0, Math.floor(params.maxBodyBytes));
  let writtenBytes = 0;
  const createOverLimitError = () =>
    new Error(`Direct peer transfer open request body exceeds the configured body-limit (${maxBodyBytes} bytes)`);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      const chunk = next.value;
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (writtenBytes + chunkBytes > maxBodyBytes) {
        controller.error(createOverLimitError());
        iterator.return?.(undefined);
        return;
      }
      writtenBytes += chunkBytes;
      controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      iterator.return?.(undefined);
    },
  });
}

type DirectPeerOpenRequestBodyTransmission =
  | Readonly<{ kind: 'bytes'; body: Uint8Array<ArrayBuffer> }>
  | Readonly<{ kind: 'stream'; body: () => ReadableStream<Uint8Array> }>;

function createDirectPeerOpenRequestBodyTransmission(params: Readonly<{
  openBody: unknown;
}>): DirectPeerOpenRequestBodyTransmission {
  const maxBodyBytes = readDirectPeerOpenBodyMaxBytes();
  const estimatedBytes = estimateJsonUtf8BytesBounded(params.openBody, maxBodyBytes);
  if (estimatedBytes > maxBodyBytes) {
    throw new Error(`Direct peer transfer open request body exceeds the configured body-limit (${maxBodyBytes} bytes)`);
  }
  if (estimatedBytes > DIRECT_PEER_OPEN_BODY_STREAMING_THRESHOLD_BYTES) {
    return {
      kind: 'stream',
      body: () => createDirectPeerOpenRequestBodyStream({ ...params, maxBodyBytes }),
    };
  }
  return {
    kind: 'bytes',
    body: serializeDirectPeerOpenRequestBodyToBytes({
      openBody: params.openBody,
      estimatedBytes,
      maxBodyBytes,
    }),
  };
}

async function requestDirectPeerTransfer<TPayload>(params: Readonly<{
  transferId: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  expectedSizeBytes?: number;
  expectedManifestHash?: string;
  openBody?: unknown;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxInMemoryPayloadBytes: number;
  onChunk: (chunk: Buffer) => Promise<void> | void;
  onFinish: (manifestHash: string) => Promise<TPayload>;
  onAbort?: (terminal: boolean) => Promise<void> | void;
}>): Promise<TPayload> {
  if (!Number.isFinite(params.maxInMemoryPayloadBytes) || params.maxInMemoryPayloadBytes <= 0) {
    throw new Error(`Invalid direct peer maxInMemoryPayloadBytes: ${String(params.maxInMemoryPayloadBytes)}`);
  }
  const expectedSizeBytes = params.expectedSizeBytes;
  const expectedManifestHash = params.expectedManifestHash;
  const hasExpectedSizeBytes = expectedSizeBytes !== undefined;
  const hasExpectedManifestHash = expectedManifestHash !== undefined;
  if (
    hasExpectedSizeBytes !== hasExpectedManifestHash
    || (
      hasExpectedSizeBytes
      && (
        !Number.isSafeInteger(expectedSizeBytes)
        || expectedSizeBytes < 0
        || typeof expectedManifestHash !== 'string'
        || expectedManifestHash.length === 0
      )
    )
  ) {
    throw createDirectPeerTransferCommitmentMismatchError(params.transferId);
  }
  const expectedCommitment =
    typeof expectedSizeBytes === 'number' && typeof expectedManifestHash === 'string'
    ? {
      sizeBytes: expectedSizeBytes,
      manifestHash: expectedManifestHash,
    }
    : null;
  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? Date.now;
  const expirySkewMs = readDirectPeerExpirySkewMs();
  const requestTimeoutMs = resolveDirectPeerRequestTimeoutOverrideMs(params.timeoutMs);
  const recipientKeyPair = createTransferRecipientKeyPair();
  let openBodyTransmission: DirectPeerOpenRequestBodyTransmission | undefined;
  const resolveOpenBodyTransmission = (): DirectPeerOpenRequestBodyTransmission | undefined => {
    if (openBodyTransmission !== undefined) {
      return openBodyTransmission;
    }
    if (params.openBody === undefined) {
      return undefined;
    }
    openBodyTransmission = createDirectPeerOpenRequestBodyTransmission({ openBody: params.openBody });
    return openBodyTransmission;
  };
  let lastError: Error | null = null;

  for (const candidate of params.endpointCandidates) {
    if (!isSafeDirectTransferEndpointCandidate(candidate)) continue;
    const parsedCandidate = TransferEndpointCandidateSchema.safeParse(candidate);
    if (!parsedCandidate.success) continue;
    if (parsedCandidate.data.expiresAt + expirySkewMs < now()) continue;
    if (parsedCandidate.data.kind !== 'http' && parsedCandidate.data.kind !== 'https') {
      continue;
    }
    let auth: Readonly<{
      requestUrl: string;
      authorizationHeader?: string;
    }>;
    try {
      auth = extractDirectPeerRequestAuth(parsedCandidate.data);
    } catch {
      continue;
    }
    const headers: Record<string, string> = {
      [DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER]: recipientKeyPair.recipientPublicKeyBase64,
    };
    if (auth.authorizationHeader) {
      headers.authorization = auth.authorizationHeader;
    }
    const candidateOpenBodyTransmission = resolveOpenBodyTransmission();
    if (candidateOpenBodyTransmission !== undefined) {
      headers['content-type'] = 'application/json';
    }

    for (let attempt = 0; attempt < DIRECT_PEER_REQUEST_RETRY_ATTEMPTS; attempt += 1) {
      let receivedSizeBytes = 0;
      try {
        const openRequestInit: RequestInit & { duplex?: 'half' } = {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(requestTimeoutMs),
        };
        if (candidateOpenBodyTransmission?.kind === 'bytes') {
          openRequestInit.body = candidateOpenBodyTransmission.body;
        } else if (candidateOpenBodyTransmission?.kind === 'stream') {
          openRequestInit.body = candidateOpenBodyTransmission.body();
          openRequestInit.duplex = 'half';
        }
        const openResponse = await fetchFn(`${auth.requestUrl}/open`, openRequestInit);
        if (!openResponse.ok) {
          throw new Error(`Direct peer request failed with status ${openResponse.status}`);
        }
        if (!isJsonContentType(openResponse.headers.get('content-type'))) {
          throw createInvalidDirectPeerTransferResponseError(params.transferId);
        }
        let json: unknown;
        json = await readJsonResponseWithBodyLimit({
          response: openResponse,
          maxBodyBytes: Math.min(
            DIRECT_PEER_OPEN_RESPONSE_MAX_BYTES,
            resolveDirectPeerJsonBodyMaxBytes(params.maxInMemoryPayloadBytes),
          ),
          onInvalidJson: () => createInvalidDirectPeerTransferResponseError(params.transferId),
          onOverLimit: () => new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${params.maxInMemoryPayloadBytes}`),
        });
        const parsed = DirectPeerTransferResponseSchema.safeParse(json);
        json = null;
        if (!parsed.success || parsed.data.transferId !== params.transferId) {
          throw createInvalidDirectPeerTransferResponseError(params.transferId);
        }
        if (
          expectedCommitment
          && (
            (
              parsed.data.sizeBytes !== undefined
              && parsed.data.sizeBytes !== expectedCommitment.sizeBytes
            )
            || parsed.data.manifestHash !== expectedCommitment.manifestHash
          )
        ) {
          throw createDirectPeerTransferCommitmentMismatchError(params.transferId);
        }
        if (parsed.data.totalChunks > readDirectPeerMaxTotalChunks()) {
          throw new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${params.maxInMemoryPayloadBytes}`);
        }
        for (let sequence = 0; sequence < parsed.data.totalChunks; sequence += 1) {
          const chunkResponse = await fetchFn(`${auth.requestUrl}/chunks/${sequence}`, {
            method: 'GET',
            headers: {
              ...headers,
              ...(auth.authorizationHeader ? { authorization: auth.authorizationHeader } : {}),
            },
            signal: AbortSignal.timeout(requestTimeoutMs),
          });
          if (!chunkResponse.ok) {
            throw new Error(`Direct peer request failed with status ${chunkResponse.status}`);
          }
          if (!isJsonContentType(chunkResponse.headers.get('content-type'))) {
            throw createInvalidDirectPeerTransferResponseError(params.transferId);
          }
          let chunkJson: unknown;
          chunkJson = await readJsonResponseWithBodyLimit({
            response: chunkResponse,
            maxBodyBytes: resolveDirectPeerJsonBodyMaxBytes(params.maxInMemoryPayloadBytes),
            onInvalidJson: () => createInvalidDirectPeerTransferResponseError(params.transferId),
            onOverLimit: () => new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${params.maxInMemoryPayloadBytes}`),
          });
          const parsedChunk = TransferChunkEnvelopeSchema.safeParse(chunkJson);
          chunkJson = null;
          if (
            !parsedChunk.success
            || parsedChunk.data.transferId !== params.transferId
            || parsedChunk.data.sequence !== sequence
            || !parsedChunk.data.encryptedDataKeyEnvelopeBase64
          ) {
            throw createInvalidDirectPeerTransferResponseError(params.transferId);
          }
          const payloadBase64 = parsedChunk.data.payloadBase64;
          const encryptedDataKeyEnvelopeBase64 = parsedChunk.data.encryptedDataKeyEnvelopeBase64;
          const payloadBase64TrimmedLength = resolveBase64TrimmedLength(payloadBase64);
          const encryptedDataKeyEnvelopeBase64TrimmedLength = resolveBase64TrimmedLength(encryptedDataKeyEnvelopeBase64);
          const estimatedEncryptedPayloadBytes = estimateBase64DecodedBytes(payloadBase64);
          const estimatedDataKeyEnvelopeBytes = estimateBase64DecodedBytes(encryptedDataKeyEnvelopeBase64);

          const maxEncryptedBytes = params.maxInMemoryPayloadBytes + ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES;
          const maxEncodedChars = Math.ceil(maxEncryptedBytes / 3) * 4;
          const maxDataKeyEnvelopeEncodedChars = Math.ceil(ENCRYPTED_TRANSFER_DATA_KEY_ENVELOPE_HARD_MAX_BYTES / 3) * 4;
          if (
            payloadBase64TrimmedLength > maxEncodedChars
            || estimatedEncryptedPayloadBytes > maxEncryptedBytes
            || estimatedDataKeyEnvelopeBytes > ENCRYPTED_TRANSFER_DATA_KEY_ENVELOPE_HARD_MAX_BYTES
            || encryptedDataKeyEnvelopeBase64TrimmedLength > maxDataKeyEnvelopeEncodedChars
          ) {
            throw new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${params.maxInMemoryPayloadBytes}`);
          }
          const chunk = decryptEncryptedTransferChunkEnvelope({
            transferId: params.transferId,
            sequence,
            payloadBase64,
            encryptedDataKeyEnvelopeBase64,
            recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
          });
          const nextReceivedSizeBytes = receivedSizeBytes + chunk.byteLength;
          if (
            !Number.isSafeInteger(nextReceivedSizeBytes)
            || (expectedCommitment && nextReceivedSizeBytes > expectedCommitment.sizeBytes)
          ) {
            throw createDirectPeerTransferCommitmentMismatchError(params.transferId);
          }
          await params.onChunk(chunk);
          receivedSizeBytes = nextReceivedSizeBytes;
        }
        if (expectedCommitment && receivedSizeBytes !== expectedCommitment.sizeBytes) {
          throw createDirectPeerTransferCommitmentMismatchError(params.transferId);
        }
        try {
          return await params.onFinish(expectedCommitment?.manifestHash ?? parsed.data.manifestHash);
        } catch (error) {
          if (
            expectedCommitment
            && error instanceof Error
            && error.message.startsWith('Transfer payload manifest mismatch for ')
          ) {
            throw createDirectPeerTransferCommitmentMismatchError(params.transferId);
          }
          throw error;
        }
      } catch (error) {
        const isProtocolError = isDirectPeerTransferProtocolError(error);
        await params.onAbort?.(isProtocolError);
        if (isProtocolError) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error('Direct peer transfer request failed');
        if (attempt + 1 >= DIRECT_PEER_REQUEST_RETRY_ATTEMPTS || !isRetryableDirectPeerTransferRequestError(error)) {
          break;
        }
        await waitForDirectPeerTransferRetryDelay(DIRECT_PEER_REQUEST_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  throw lastError ?? new Error(`No reachable direct peer transfer candidate for ${params.transferId}`);
}

export async function requestDirectPeerTransferToFile(params: Readonly<{
  transferId: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  destinationPath: string;
  expectedSizeBytes?: number;
  expectedManifestHash?: string;
  openBody?: unknown;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  onProgress?: (receivedBytes: number) => Promise<void> | void;
}>): Promise<TransferPayloadFileResult> {
  let receivedBytes = 0;
  let sink = await createTransferPayloadFileSink({
    destinationPath: params.destinationPath,
  });

  const resetForRetry = async () => {
    await sink.abort().catch(() => undefined);
    receivedBytes = 0;
    await params.onProgress?.(0);
    sink = await createTransferPayloadFileSink({
      destinationPath: params.destinationPath,
    });
  };

  try {
    return await requestDirectPeerTransfer({
      ...params,
      maxInMemoryPayloadBytes: readDirectPeerChunkBytes(),
      onChunk: async (chunk) => {
        await sink.appendChunk(chunk);
        receivedBytes += chunk.length;
        await params.onProgress?.(receivedBytes);
      },
      onFinish: async (manifestHash) => await sink.finalize(manifestHash),
      onAbort: async (terminal) => {
        if (terminal) {
          await sink.abort();
          return;
        }
        await resetForRetry();
      },
    });
  } catch (error) {
    await sink.abort().catch(() => undefined);
    throw error;
  }
}
