import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import * as fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { estimateJsonUtf8BytesBounded } from '@/transfers/shared/estimateJsonUtf8BytesBounded';

import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  TransferChunkEnvelopeSchema,
  TransferEndpointCandidateSchema,
  type TransferEndpointCandidate,
} from '@happier-dev/protocol';
import { z } from 'zod';
import {
  createEncryptedTransferChunkEnvelope,
  createTransferManifestHash,
  createTransferRecipientKeyPair,
  parseTransferRecipientPublicKeyBase64,
  decryptEncryptedTransferChunkEnvelope,
} from './transferChunkEncryption';
import {
  resolveDirectPeerAdvertisedHosts,
  resolveDirectPeerTransferBindHost,
  resolveDirectPeerTransferBindPort,
  resolveDirectPeerTransferChunkBytes,
  resolveDirectPeerTransferExpirySkewMs,
  resolveDirectPeerTransferMaxTotalChunks,
  resolveDirectPeerTransferOpenBodyMaxBytes,
  resolveDirectPeerTransferPublishedTransferRegistryMaxEntries,
  resolveDirectPeerTransferRequestTimeoutOverrideMs as resolveDirectPeerTransferRequestTimeoutOverrideMsConfig,
  resolveDirectPeerTransferTtlMs,
} from './transferRuntimeConfig';
import {
  createBufferTransferPayloadSource,
  readTransferPayloadChunk,
  resolveTransferPayloadManifestHash,
  resolveTransferPayloadSizeBytes,
  disposeTransferPayloadSource,
  type TransferPayloadSource,
} from './transferPayloadSource';
import { createTransferPayloadFileSink, type TransferPayloadFileResult } from './transferPayloadFileSink';
import { IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR, resolveInMemoryTransferMaxBytes } from './inMemoryTransferSizeLimit';
import { clampTransferChunkBytes } from './transferChunkSizeLimit';

// Direct-peer transfers are used for session handoff + workspace replication, which can take
// significantly longer than 30s on large repos/slow disks/VMs (host <-> Lima). Keep the default
// TTL long enough that long-running transfers don't fail mid-flight. Still configurable via env.
const DEFAULT_DIRECT_PEER_TTL_MS = 10 * 60_000;
const DEFAULT_DIRECT_PEER_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_DIRECT_PEER_CHUNK_BYTES = 256 * 1024;
// Direct-peer chunk payloads are encoded inside JSON responses as base64 strings. Keep the hard
// max lower than the generic transfer chunk ceiling to avoid multi-megabyte string allocations
// (bytes + decoded string + JSON.parse) on each request.
const DIRECT_PEER_CHUNK_HARD_MAX_BYTES = 512 * 1024;
// Guardrail: even with bounded per-chunk bytes, an absurd chunk count would trigger an unbounded
// request loop (DoS footgun). This is an additional hard stop on the requester side.
const DEFAULT_DIRECT_PEER_MAX_TOTAL_CHUNKS = 1_000_000;
const DIRECT_PEER_MAX_TOTAL_CHUNKS_HARD_MAX = 10_000_000;
const DEFAULT_DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_MAX_ENTRIES = 2048;
const DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_HARD_MAX_ENTRIES = 100_000;
const DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_FULL_ERROR = 'Direct peer published transfer registry is full';
// Default is intentionally small; larger /open bodies should be an explicit opt-in because the
// direct-peer server can be reachable on a LAN.
const DEFAULT_DIRECT_PEER_OPEN_BODY_MAX_BYTES = 64 * 1024;
const DEFAULT_DIRECT_PEER_BIND_HOST = '0.0.0.0';
// Tolerate small clock skew by default so candidates published by a peer with a slightly "behind"
// clock are still attempted (auth TTL is still enforced by the responder).
const DEFAULT_DIRECT_PEER_EXPIRY_SKEW_MS = 2_000;
// /open responses should be tiny (transferId + sha256 + totalChunks). Hard-cap to keep JSON buffering
// bounded even if a hostile peer sends a huge body with a misleading content-length.
const DIRECT_PEER_OPEN_RESPONSE_MAX_BYTES = 8 * 1024;
// When a peer provides a `content-length`, do not blindly allocate that exact size for large
// responses. Cap preallocation so bogus/malicious headers cannot force a single large spike.
const DIRECT_PEER_JSON_RESPONSE_PREALLOC_MAX_BYTES = DIRECT_PEER_CHUNK_HARD_MAX_BYTES;
const DIRECT_PEER_AUTH_SCHEME = 'Bearer';
const DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER = 'x-happier-transfer-recipient-public-key';
// Transfer tokens are base64url-encoded random bytes. Anything huge is untrusted input that
// should be rejected before hashing/comparing (DoS hardening).
const DIRECT_PEER_AUTH_TOKEN_HARD_MAX_CHARS = 256;
// Base64-encoded Curve25519 public keys are small (~44 chars). Hard-cap before any base64 decode
// so hostile peers can't force large Buffer allocations via oversized headers.
const DIRECT_PEER_RECIPIENT_PUBLIC_KEY_BASE64_HARD_MAX_CHARS = 128;

const ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES = 1 + 12 + 16; // version + nonce + auth tag
// Encrypted data-key envelopes are small and fixed-size today (~105 bytes for V1), but we still
// cap them independently so hostile peers cannot force large base64 decode allocations.
const ENCRYPTED_TRANSFER_DATA_KEY_ENVELOPE_HARD_MAX_BYTES = 1024;
// Direct-peer /open bodies should stay small (transfer metadata and/or bounded on-demand selectors).
// Keep a hard cap so hostile peers can't force unbounded work; allow raising above the default via
// env when replication requests need more room.
const DIRECT_PEER_OPEN_BODY_HARD_MAX_BYTES = 1024 * 1024;
// Above this threshold, stream the JSON body instead of materializing one request buffer.
const DIRECT_PEER_OPEN_BODY_STREAMING_THRESHOLD_BYTES = 8 * 1024;

function encodeDirectPeerTransferPathKey(transferId: string): string {
  return Buffer.from(transferId, 'utf8').toString('base64url');
}

const DIRECT_PEER_TRANSFER_ID_HARD_MAX_CHARS = 512;
const BASE64URL_KEY_REGEX = /^[A-Za-z0-9_-]+$/;

function decodeDirectPeerTransferPathKey(transferKey: string): string | null {
  const normalizedTransferKey = transferKey.trim();
  if (normalizedTransferKey.length === 0) {
    return null;
  }

  // Fail closed: never accept legacy raw transfer ids in URL paths. Only allow canonical base64url keys.
  if (!BASE64URL_KEY_REGEX.test(normalizedTransferKey)) {
    return null;
  }

  try {
    const decoded = Buffer.from(normalizedTransferKey, 'base64url').toString('utf8');
    if (decoded.length === 0 || decoded.length > DIRECT_PEER_TRANSFER_ID_HARD_MAX_CHARS) {
      return null;
    }
    return encodeDirectPeerTransferPathKey(decoded) === normalizedTransferKey
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function hashTransferToken(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeInt(rawValue: string | undefined, fallback: number): number {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function formatCandidateHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function readDirectPeerAuthorizationToken(value: string | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const [scheme, token] = raw.split(/\s+/, 2);
  if (scheme !== DIRECT_PEER_AUTH_SCHEME) return null;
  const normalizedToken = String(token ?? '').trim();
  return normalizedToken.length > 0 ? normalizedToken : null;
}

function extractDirectPeerRequestAuth(candidate: TransferEndpointCandidate): Readonly<{
  requestUrl: string;
  authorizationHeader?: string;
}> {
  const explicitAuthorizationToken = typeof candidate.authorizationToken === 'string'
    ? candidate.authorizationToken.trim()
    : '';
  try {
    const parsed = new URL(candidate.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid direct peer endpoint candidate');
    }
    // Never allow credentialed URLs to propagate.
    parsed.username = '';
    parsed.password = '';
    // Direct-peer candidates must not rely on query params for auth or routing. Strip any query/hash.
    parsed.search = '';
    parsed.hash = '';
    // Only accept base transfer endpoints: /machine-transfers/direct/<transferKey>
    // This avoids sending auth headers to attacker-controlled URLs that smuggle additional segments.
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    if (segments.length !== 3 || segments[0] !== 'machine-transfers' || segments[1] !== 'direct' || segments[2].length === 0) {
      throw new Error('Invalid direct peer endpoint candidate');
    }
    const authorizationToken = explicitAuthorizationToken;
    if (!authorizationToken) {
      return { requestUrl: parsed.toString() };
    }
    return {
      requestUrl: parsed.toString(),
      ...(authorizationToken
        ? {
            authorizationHeader: `${DIRECT_PEER_AUTH_SCHEME} ${authorizationToken}`,
          }
        : {}),
    };
  } catch {
    throw new Error('Invalid direct peer endpoint candidate');
  }
}

function readAdvertisedHosts(networkInterfacesFn: typeof networkInterfaces): string[] {
  return resolveDirectPeerAdvertisedHosts(networkInterfacesFn);
}

function readDirectPeerTtlMs(): number {
  return resolveDirectPeerTransferTtlMs();
}

function readDirectPeerRequestTimeoutMs(): number {
  return resolveDirectPeerTransferRequestTimeoutOverrideMsConfig(undefined);
}

function resolveDirectPeerRequestTimeoutOverrideMs(timeoutMs: number | undefined): number {
  return resolveDirectPeerTransferRequestTimeoutOverrideMsConfig(timeoutMs);
}

function readDirectPeerBindPort(): number {
  return resolveDirectPeerTransferBindPort();
}

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

function readDirectPeerPublishedTransferRegistryMaxEntries(): number {
  return resolveDirectPeerTransferPublishedTransferRegistryMaxEntries();
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
    // Fail closed: without a readable body stream we cannot enforce a bounded read.
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
    // Preallocate up to a bounded cap so large or bogus content-length values can't force a same-sized
    // allocation spike purely from the header.
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

      // If the peer lies about content-length, fall back to the same bounded growing-buffer
      // strategy we use when content-length is omitted.
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

    // If we never triggered the mismatch fallback, use the filled prefix (may be shorter than
    // content-length when the peer closes early).
    if (!bytes) {
      bytes = buffer.subarray(0, offset);
    }
  } else {
    // When the peer doesn't provide content-length, we still want to avoid buffering an extra
    // array of chunks. Use a bounded growing buffer instead.
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
  // Decode and drop the byte buffer reference before parsing so callers don't retain both the
  // Uint8Array and decoded string longer than necessary.
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

  // The chunk envelope is JSON with two base64 strings (payload + data-key envelope).
  // Bound the entire JSON body so we fail closed before buffering/parsing untrusted bytes.
  const maxEncryptedBytes = maxBytes + ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES;
  const maxEncodedChars = Math.ceil(maxEncryptedBytes / 3) * 4;
  // The chunk response JSON body is ASCII (base64), so char count ~= wire bytes. Keep tight slack:
  // - payload base64 for the encrypted chunk
  // - data-key envelope base64 (small, but attacker-controlled)
  // - JSON punctuation + small fixed fields
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
}>): Uint8Array {
  // Avoid a double-buffer peak (`Uint8Array[]` + concatenated buffer) without iterating the JSON
  // generator twice (which could re-run `toJSON()` hooks and/or introduce side-effects).
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
  | Readonly<{ kind: 'bytes'; body: Uint8Array }>
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

export type PublishedDirectPeerTransfer = Readonly<{
  transferId: string;
  transferToken: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  expiresAt: number;
}>;

type PublishDirectPeerTransferInput = Readonly<{
  transferId: string;
  payload?: Buffer;
  payloadSource?: TransferPayloadSource;
  onDemandScope?: DirectPeerOnDemandTransferScope;
}>;

type StoredPublishedTransfer = Readonly<{
  transferToken: string;
  transferTokenDigest: Buffer;
  expiresAt: number;
  payloadSource: TransferPayloadSource;
}>;

export type DirectPeerOnDemandTransferScope = Readonly<{
  allowTransferId: (transferId: string) => boolean;
  resolvePayloadSourceOnOpen: (input: Readonly<{
    transferId: string;
    requestBody: unknown;
  }>) => Promise<TransferPayloadSource>;
  maxResolvedTransfers?: number;
}>;

type StoredOnDemandScope = Readonly<{
  expiresAt: number;
  allowTransferId: (transferId: string) => boolean;
  resolvePayloadSourceOnOpen: DirectPeerOnDemandTransferScope['resolvePayloadSourceOnOpen'];
  maxResolvedTransfers: number;
  resolvedTransferIds: Set<string>;
}>;

export function createDirectPeerTransferRegistry(params: Readonly<{
  advertisedPort: number;
  now?: () => number;
  networkInterfacesFn?: typeof networkInterfaces;
}>) {
  const now = params.now ?? Date.now;
  const networkInterfacesFn = params.networkInterfacesFn ?? networkInterfaces;
  const publishedTransfers = new Map<string, StoredPublishedTransfer>();
  const onDemandScopesByToken = new Map<string, StoredOnDemandScope>();

  const disposePayloadSourceBestEffort = (source: TransferPayloadSource) => {
    void disposeTransferPayloadSource(source).catch(() => undefined);
  };

  const clearPublishedTransfersForToken = (token: string): void => {
    onDemandScopesByToken.delete(token);

    for (const [candidateId, entry] of publishedTransfers.entries()) {
      if (entry.transferToken !== token) {
        continue;
      }
      publishedTransfers.delete(candidateId);
      disposePayloadSourceBestEffort(entry.payloadSource);
    }
  };

  const pruneExpiredPublishedTransfers = (): void => {
    const nowMs = now();

    const expiredTokens: string[] = [];
    for (const [token, scope] of onDemandScopesByToken.entries()) {
      if (scope.expiresAt < nowMs) {
        expiredTokens.push(token);
      }
    }
    for (const token of expiredTokens) {
      clearPublishedTransfersForToken(token);
    }

    const expiredPublishedTokens: string[] = [];
    for (const entry of publishedTransfers.values()) {
      if (entry.expiresAt < nowMs) {
        expiredPublishedTokens.push(entry.transferToken);
      }
    }
    for (const token of new Set(expiredPublishedTokens)) {
      clearPublishedTransfersForToken(token);
    }
  };

  const assertRegistryHasCapacityForTransferId = (transferId: string): void => {
    if (publishedTransfers.has(transferId)) {
      return;
    }
    const maxEntries = readDirectPeerPublishedTransferRegistryMaxEntries();
    if (publishedTransfers.size >= maxEntries) {
      throw new Error(DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_FULL_ERROR);
    }
  };

  function publishTransfer(input: PublishDirectPeerTransferInput): PublishedDirectPeerTransfer {
    pruneExpiredPublishedTransfers();
    assertRegistryHasCapacityForTransferId(input.transferId);

    // Re-publishing should clean up any prior payload sources/scope to avoid leaks and drift.
    clearPublishedTransfer(input.transferId);

    const payloadSource = input.payloadSource ?? (input.payload ? createBufferTransferPayloadSource(input.payload) : null);
    if (!payloadSource) {
      throw new Error(`Direct peer transfer ${input.transferId} is missing a payload source`);
    }
    const inMemoryMaxBytes = resolveInMemoryTransferMaxBytes();
    if (payloadSource.kind === 'buffer' && payloadSource.payload.length > inMemoryMaxBytes) {
      throw new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${inMemoryMaxBytes}`);
    }
    const transferToken = randomBytes(24).toString('base64url');
    const expiresAt = now() + readDirectPeerTtlMs();
    const transferPathKey = encodeDirectPeerTransferPathKey(input.transferId);
    const httpEndpointCandidates: TransferEndpointCandidate[] = readAdvertisedHosts(networkInterfacesFn)
      .map((host) => ({
        kind: 'http' as const,
        url: `http://${formatCandidateHost(host)}:${params.advertisedPort}/machine-transfers/direct/${transferPathKey}`,
        authorizationToken: transferToken,
        expiresAt,
      }))
      .filter(
        (candidate, index, all) =>
          all.findIndex(
            (entry) =>
              entry.url === candidate.url
              && entry.authorizationToken === candidate.authorizationToken,
          ) === index,
      );
    const endpointCandidates: TransferEndpointCandidate[] = [...httpEndpointCandidates];

    publishedTransfers.set(input.transferId, {
      transferToken,
      transferTokenDigest: hashTransferToken(transferToken),
      expiresAt,
      payloadSource,
    });

    if (input.onDemandScope) {
      onDemandScopesByToken.set(transferToken, {
        expiresAt,
        allowTransferId: input.onDemandScope.allowTransferId,
        resolvePayloadSourceOnOpen: input.onDemandScope.resolvePayloadSourceOnOpen,
        maxResolvedTransfers: input.onDemandScope.maxResolvedTransfers ?? 10_000,
        resolvedTransferIds: new Set<string>(),
      });
    }

    return {
      transferId: input.transferId,
      transferToken,
      endpointCandidates,
      expiresAt,
    };
  }

  function readPublishedTransfer(input: Readonly<{
    transferId: string;
    transferToken: string;
    transferTokenDigest?: Buffer;
  }>): TransferPayloadSource | null {
    const stored = publishedTransfers.get(input.transferId);
    if (!stored) return null;
    // `expiresAt` is generated locally; do not apply requester clock-skew tolerance to auth TTL.
    if (stored.expiresAt < now()) {
      publishedTransfers.delete(input.transferId);
      onDemandScopesByToken.delete(stored.transferToken);
      disposePayloadSourceBestEffort(stored.payloadSource);
      return null;
    }
    // Hash only the untrusted inbound token. Stored tokens are already pre-hashed at publish time
    // so repeated auth failures can't force 2x hashing work per request.
    const inboundDigest = input.transferTokenDigest ?? hashTransferToken(input.transferToken);
    if (!timingSafeEqual(inboundDigest, stored.transferTokenDigest)) {
      return null;
    }
    return stored.payloadSource;
  }

  async function resolveOnDemandTransferOnOpen(input: Readonly<{
    transferId: string;
    transferToken: string;
    requestBody: unknown;
  }>): Promise<TransferPayloadSource | null> {
    pruneExpiredPublishedTransfers();
    const scope = onDemandScopesByToken.get(input.transferToken);
    if (!scope) {
      return null;
    }
    if (scope.expiresAt < now()) {
      onDemandScopesByToken.delete(input.transferToken);
      return null;
    }
    if (!scope.allowTransferId(input.transferId)) {
      return null;
    }
    if (scope.resolvedTransferIds.size >= scope.maxResolvedTransfers) {
      throw new Error('Direct peer on-demand transfer scope exceeded max resolved transfers');
    }
    const payloadSource = await scope.resolvePayloadSourceOnOpen({
      transferId: input.transferId,
      requestBody: input.requestBody,
    });
    const inMemoryMaxBytes = resolveInMemoryTransferMaxBytes();
    if (payloadSource.kind === 'buffer' && payloadSource.payload.length > inMemoryMaxBytes) {
      disposePayloadSourceBestEffort(payloadSource);
      throw new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${inMemoryMaxBytes}`);
    }

    assertRegistryHasCapacityForTransferId(input.transferId);
    publishedTransfers.set(input.transferId, {
      transferToken: input.transferToken,
      transferTokenDigest: hashTransferToken(input.transferToken),
      expiresAt: scope.expiresAt,
      payloadSource,
    });
    scope.resolvedTransferIds.add(input.transferId);
    return payloadSource;
  }

  function clearPublishedTransfer(transferId: string): void {
    const stored = publishedTransfers.get(transferId);
    if (!stored) {
      return;
    }

    // Clearing a token carrier should also clear any on-demand transfers resolved under the same token.
    clearPublishedTransfersForToken(stored.transferToken);
  }

  return {
    publishTransfer,
    readPublishedTransfer,
    resolveOnDemandTransferOnOpen,
    clearPublishedTransfer,
  };
}

const DirectPeerTransferResponseSchema = z
  .object({
    transferId: z.string().min(1),
    manifestHash: z.string().min(1),
    totalChunks: z.number().int().positive(),
  })
  .strict();

function createInvalidDirectPeerTransferResponseError(transferId: string): Error {
  return new Error(`Invalid direct peer transfer response for ${transferId}`);
}

function isDirectPeerTransferProtocolError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith('Invalid direct peer transfer response for ')
    || error.message.startsWith('Direct peer transfer manifest mismatch for ')
  );
}

function estimateBase64DecodedBytes(value: string): number {
  let start = 0;
  let end = value.length - 1;
  while (start <= end && isBase64TrimChar(value.charCodeAt(start))) start += 1;
  while (end >= start && isBase64TrimChar(value.charCodeAt(end))) end -= 1;
  if (end < start) return 0;
  const trimmedLength = end - start + 1;
  const last = value.charCodeAt(end);
  const paddingBytes = last === 0x3d /* = */
    ? (end - 1 >= start && value.charCodeAt(end - 1) === 0x3d /* = */ ? 2 : 1)
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
  // We only expect ASCII base64 strings; treat common ASCII whitespace/control as trim chars.
  // This avoids allocating via `value.trim()` on potentially large payloads.
  return code <= 0x20 || code === 0xfeff;
}

function isJsonContentType(contentType: string | null): boolean {
  const normalized = String(contentType ?? '').trim().toLowerCase();
  // Allow charset/etc parameters.
  return normalized.startsWith('application/json');
}

export function createDirectPeerTransferApp(params: Readonly<{
  readPublishedTransfer: (input: Readonly<{
    transferId: string;
    transferToken: string;
    transferTokenDigest?: Buffer;
  }>) => TransferPayloadSource | null;
  resolveOnDemandTransfer?: (input: Readonly<{
    transferId: string;
    transferToken: string;
    requestBody: unknown;
  }>) => Promise<TransferPayloadSource | null>;
}>): FastifyInstance {
  const OPEN_METADATA_CACHE_MAX_ENTRIES = 256;
  const OPEN_FILE_HANDLE_CACHE_MAX_ENTRIES = 64;
  const OPEN_TRANSFER_TOKEN_DIGEST_CACHE_MAX_ENTRIES = 256;
  const openSizeBytesCache = new Map<string, Promise<number>>();
  const openManifestHashCache = new Map<string, Promise<string>>();
  const openFileHandleCache = new Map<string, Promise<FileHandle>>();
  const openTransferTokenDigestCache = new Map<string, Buffer>();

  const readOpenCacheKeyFromDigest = (transferId: string, transferTokenDigest: Buffer): string =>
    `${transferId}:${transferTokenDigest.toString('base64url')}`;

  const cachePromise = <TValue>(
    cache: Map<string, Promise<TValue>>,
    key: string,
    factory: () => Promise<TValue>,
  ): Promise<TValue> => {
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    const created = factory();
    cache.set(key, created);

    // If the work fails, don't pin a rejected promise indefinitely.
    created.catch(() => {
      if (cache.get(key) === created) {
        cache.delete(key);
      }
    });

    while (cache.size > OPEN_METADATA_CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }

    return created;
  };

  const resolveOpenTransferTokenDigest = (transferToken: string): Buffer => {
    const cached = openTransferTokenDigestCache.get(transferToken);
    if (cached) {
      return cached;
    }

    const digest = hashTransferToken(transferToken);
    openTransferTokenDigestCache.set(transferToken, digest);

    while (openTransferTokenDigestCache.size > OPEN_TRANSFER_TOKEN_DIGEST_CACHE_MAX_ENTRIES) {
      const oldestKey = openTransferTokenDigestCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      openTransferTokenDigestCache.delete(oldestKey);
    }

    return digest;
  };

  const closeFileHandleBestEffort = async (handlePromise: Promise<FileHandle>): Promise<void> => {
    try {
      const handle = await handlePromise;
      await handle.close();
    } catch {
      // ignore
    }
  };

  const cacheFileHandle = (key: string, filePath: string): Promise<FileHandle> => {
    const cached = openFileHandleCache.get(key);
    if (cached) {
      return cached;
    }

    const created = fsPromises.open(filePath, 'r');
    openFileHandleCache.set(key, created);

    // If open fails, don't pin a rejected promise indefinitely.
    created.catch(() => {
      if (openFileHandleCache.get(key) === created) {
        openFileHandleCache.delete(key);
      }
    });

    while (openFileHandleCache.size > OPEN_FILE_HANDLE_CACHE_MAX_ENTRIES) {
      const oldestKey = openFileHandleCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const evicted = openFileHandleCache.get(oldestKey);
      openFileHandleCache.delete(oldestKey);
      if (evicted) {
        void closeFileHandleBestEffort(evicted);
      }
    }

    return created;
  };

  const readTransferPayloadChunkForRequest = async (input: Readonly<{
    payloadSource: TransferPayloadSource;
    cacheKey: string;
    offset: number;
    length: number;
  }>): Promise<Buffer> => {
    if (input.payloadSource.kind !== 'file') {
      return await readTransferPayloadChunk({
        source: input.payloadSource,
        offset: input.offset,
        length: input.length,
      });
    }

    const handle = await cacheFileHandle(input.cacheKey, input.payloadSource.filePath);
    const chunkBuffer = Buffer.allocUnsafe(input.length);
    const { bytesRead } = await handle.read(chunkBuffer, 0, input.length, input.offset);
    return chunkBuffer.subarray(0, bytesRead);
  };

  const app = fastify({
    logger: false,
    bodyLimit: readDirectPeerOpenBodyMaxBytes(),
    routerOptions: {
      maxParamLength: 4 * 1024,
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const typed = app.withTypeProvider<ZodTypeProvider>();

  app.addHook('onClose', async () => {
    const handles = Array.from(openFileHandleCache.values());
    openFileHandleCache.clear();
    await Promise.all(handles.map(closeFileHandleBestEffort));
  });

  typed.post('/machine-transfers/direct/:transferId/open', {
    schema: {
      params: z.object({ transferId: z.string().min(1) }),
      querystring: z.object({}).passthrough(),
      headers: z.object({
        authorization: z.string().min(1).optional(),
        [DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER]: z.string().min(1),
      }).passthrough(),
      body: z.unknown().optional(),
      response: {
        200: DirectPeerTransferResponseSchema,
        400: z.object({ ok: z.literal(false), error: z.string() }).strict(),
        401: z.object({ ok: z.literal(false), error: z.string() }).strict(),
        404: z.object({ ok: z.literal(false), error: z.string() }).strict(),
      },
    },
	  }, async (request, reply) => {
	    const transferId = decodeDirectPeerTransferPathKey(request.params.transferId);
	    if (!transferId) {
	      reply.code(404);
	      return { ok: false as const, error: 'Direct peer transfer not available' };
	    }
	    const transferToken = (readDirectPeerAuthorizationToken(request.headers.authorization) ?? '').trim();
	    if (transferToken.length === 0) {
	      reply.code(404);
	      return { ok: false as const, error: 'Direct peer transfer not available' };
	    }
	    if (transferToken.length > DIRECT_PEER_AUTH_TOKEN_HARD_MAX_CHARS) {
	      reply.code(401);
	      return { ok: false as const, error: 'Direct peer transfer not available' };
	    }
	    const transferTokenDigest = resolveOpenTransferTokenDigest(transferToken);
	    let payloadSource = params.readPublishedTransfer({
	      transferId,
	      transferToken,
	      transferTokenDigest,
	    });
	    if (!payloadSource && params.resolveOnDemandTransfer) {
	      try {
	        // Validate recipient key before any on-demand resolution work (blob pack building, hashing, IO).
	        if (request.headers[DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER].length > DIRECT_PEER_RECIPIENT_PUBLIC_KEY_BASE64_HARD_MAX_CHARS) {
	          throw new Error('Oversized recipient public key');
	        }
	        parseTransferRecipientPublicKeyBase64(request.headers[DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER]);
	      } catch {
	        reply.code(400);
	        return { ok: false as const, error: 'Invalid direct peer transfer request' };
	      }
      try {
        payloadSource = await params.resolveOnDemandTransfer({
          transferId,
          transferToken,
          requestBody: request.body,
        });
      } catch {
        reply.code(400);
        return { ok: false as const, error: 'Invalid direct peer transfer request' };
      }
    }
		    if (!payloadSource) {
		      reply.code(401);
		      return { ok: false as const, error: 'Direct peer transfer not available' };
		    }
		    try {
		      if (request.headers[DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER].length > DIRECT_PEER_RECIPIENT_PUBLIC_KEY_BASE64_HARD_MAX_CHARS) {
		        throw new Error('Oversized recipient public key');
		      }
		      parseTransferRecipientPublicKeyBase64(request.headers[DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER]);
		    } catch {
		      reply.code(400);
		      return { ok: false as const, error: 'Invalid direct peer transfer request' };
		    }
    const cacheKey = readOpenCacheKeyFromDigest(transferId, transferTokenDigest);
    const sizeBytes = await cachePromise(
      openSizeBytesCache,
      cacheKey,
      async () => await resolveTransferPayloadSizeBytes(payloadSource),
    );
    return {
      transferId,
      manifestHash: await cachePromise(
        openManifestHashCache,
        cacheKey,
        async () => await resolveTransferPayloadManifestHash(payloadSource),
      ),
      totalChunks: Math.max(1, Math.ceil(sizeBytes / readDirectPeerChunkBytes())),
    };
  });

  typed.get('/machine-transfers/direct/:transferId/chunks/:sequence', {
    schema: {
      params: z.object({
        transferId: z.string().min(1),
        sequence: z.coerce.number().int().nonnegative(),
      }),
      querystring: z.object({}).passthrough(),
      headers: z.object({
        authorization: z.string().min(1).optional(),
        [DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER]: z.string().min(1),
      }).passthrough(),
      response: {
        200: TransferChunkEnvelopeSchema,
        400: z.object({ ok: z.literal(false), error: z.string() }).strict(),
        401: z.object({ ok: z.literal(false), error: z.string() }).strict(),
        404: z.object({ ok: z.literal(false), error: z.string() }).strict(),
      },
    },
	  }, async (request, reply) => {
	    const transferId = decodeDirectPeerTransferPathKey(request.params.transferId);
	    if (!transferId) {
	      reply.code(404);
	      return { ok: false as const, error: 'Direct peer transfer not available' };
	    }
	    const transferToken = (readDirectPeerAuthorizationToken(request.headers.authorization) ?? '').trim();
	    if (transferToken.length === 0) {
	      reply.code(404);
	      return { ok: false as const, error: 'Direct peer transfer not available' };
	    }
	    if (transferToken.length > DIRECT_PEER_AUTH_TOKEN_HARD_MAX_CHARS) {
	      reply.code(401);
	      return { ok: false as const, error: 'Direct peer transfer not available' };
	    }
	    const transferTokenDigest = resolveOpenTransferTokenDigest(transferToken);
	    const payloadSource = params.readPublishedTransfer({
	      transferId,
	      transferToken,
	      transferTokenDigest,
	    });
		    if (!payloadSource) {
		      reply.code(401);
		      return { ok: false as const, error: 'Direct peer transfer not available' };
		    }
		    try {
		      // Fail fast before reading payload bytes to avoid wasted IO on malformed keys.
		      if (request.headers[DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER].length > DIRECT_PEER_RECIPIENT_PUBLIC_KEY_BASE64_HARD_MAX_CHARS) {
		        throw new Error('Oversized recipient public key');
		      }
		      parseTransferRecipientPublicKeyBase64(request.headers[DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER]);
		    } catch {
		      reply.code(400);
		      return { ok: false as const, error: 'Invalid direct peer transfer request' };
		    }

	    const chunkBytes = readDirectPeerChunkBytes();
	    const cacheKey = readOpenCacheKeyFromDigest(transferId, transferTokenDigest);
	    const sizeBytes = await cachePromise(
      openSizeBytesCache,
      cacheKey,
      async () => await resolveTransferPayloadSizeBytes(payloadSource),
    );
    const totalChunks = Math.max(1, Math.ceil(sizeBytes / chunkBytes));
    if (request.params.sequence >= totalChunks) {
      reply.code(404);
      return { ok: false as const, error: 'Direct peer transfer chunk not available' };
    }

    try {
      const offset = request.params.sequence * chunkBytes;
      const encryptedChunk = createEncryptedTransferChunkEnvelope({
        transferId,
        sequence: request.params.sequence,
        payload: await readTransferPayloadChunkForRequest({
          payloadSource,
          cacheKey,
          offset,
          length: chunkBytes,
        }),
        recipientPublicKeyBase64: request.headers[DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER],
      });
      return {
        transferId,
        kind: 'chunk' as const,
        sequence: request.params.sequence,
        payloadBase64: encryptedChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
      };
    } catch {
      reply.code(400);
      return { ok: false as const, error: 'Invalid direct peer transfer request' };
    }
  });

  return app;
}

export async function startDirectPeerTransferServer(params: Readonly<{
  readPublishedTransfer: (input: Readonly<{ transferId: string; transferToken: string }>) => TransferPayloadSource | null;
  resolveOnDemandTransfer?: Parameters<typeof createDirectPeerTransferApp>[0]['resolveOnDemandTransfer'];
}>): Promise<Readonly<{ port: number; stop: () => Promise<void> }>> {
  const app = createDirectPeerTransferApp(params);
  await app.ready();
  const address = await app.listen({
    port: readDirectPeerBindPort(),
    host: resolveDirectPeerTransferBindHost(),
  });
  const port = Number.parseInt(String(address).split(':').pop() ?? '', 10);
  if (!Number.isFinite(port) || port <= 0) {
    await app.close();
    throw new Error('Failed to resolve direct peer transfer port');
  }
  return {
    port,
    stop: async () => {
      await app.close();
    },
  };
}

async function requestDirectPeerTransfer<TPayload>(params: Readonly<{
  transferId: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  openBody?: unknown;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxInMemoryPayloadBytes: number;
  onChunk: (chunk: Buffer) => Promise<void> | void;
  onFinish: (manifestHash: string) => Promise<TPayload>;
  onAbort?: () => Promise<void> | void;
}>): Promise<TPayload> {
  if (!Number.isFinite(params.maxInMemoryPayloadBytes) || params.maxInMemoryPayloadBytes <= 0) {
    throw new Error(`Invalid direct peer maxInMemoryPayloadBytes: ${String(params.maxInMemoryPayloadBytes)}`);
  }
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
    const parsedCandidate = TransferEndpointCandidateSchema.safeParse(candidate);
    if (!parsedCandidate.success) continue;
    if (parsedCandidate.data.expiresAt + expirySkewMs < now()) continue;
    if (parsedCandidate.data.kind !== 'http' && parsedCandidate.data.kind !== 'https') {
      continue;
    }
    try {
      const auth = extractDirectPeerRequestAuth(parsedCandidate.data);
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
        lastError = new Error(`Direct peer request failed with status ${openResponse.status}`);
        continue;
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
        // Fail closed before decrypting so untrusted peers can't force huge base64 decodes.
        // Note: decrypting requires decoding both payload bytes and the data-key envelope.
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
        await params.onChunk(decryptEncryptedTransferChunkEnvelope({
          transferId: params.transferId,
          sequence,
          payloadBase64,
          encryptedDataKeyEnvelopeBase64,
          recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
        }));
      }
      return await params.onFinish(parsed.data.manifestHash);
    } catch (error) {
      await params.onAbort?.();
      if (isDirectPeerTransferProtocolError(error)) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error('Direct peer transfer request failed');
    }
  }

  throw lastError ?? new Error(`No reachable direct peer transfer candidate for ${params.transferId}`);
}

export async function requestDirectPeerTransferToFile(params: Readonly<{
  transferId: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  destinationPath: string;
  openBody?: unknown;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}>): Promise<TransferPayloadFileResult> {
  let sink = await createTransferPayloadFileSink({
    destinationPath: params.destinationPath,
  });

  const resetForRetry = async () => {
    await sink.abort().catch(() => undefined);
    sink = await createTransferPayloadFileSink({
      destinationPath: params.destinationPath,
    });
  };

  try {
    return await requestDirectPeerTransfer({
      ...params,
      // File-backed transfers are still bounded per chunk to avoid OOM, but they must not be constrained
      // by the small-only whole-buffer in-memory cap (`HAPPIER_FILES_READ_MAX_BYTES`).
      maxInMemoryPayloadBytes: readDirectPeerChunkBytes(),
      onChunk: async (chunk) => {
        await sink.appendChunk(chunk);
      },
      onFinish: async (manifestHash) => await sink.finalize(manifestHash),
      onAbort: resetForRetry,
    });
  } catch (error) {
    await sink.abort().catch(() => undefined);
    throw error;
  }
}
