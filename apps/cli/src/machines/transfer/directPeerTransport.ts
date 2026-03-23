import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

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
  decryptEncryptedTransferChunkEnvelope,
} from './transferChunkEncryption';
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
const DEFAULT_DIRECT_PEER_OPEN_BODY_MAX_BYTES = 256 * 1024;
const DEFAULT_DIRECT_PEER_BIND_HOST = '0.0.0.0';
const DEFAULT_DIRECT_PEER_EXPIRY_SKEW_MS = 0;
const DIRECT_PEER_AUTH_SCHEME = 'Bearer';
const DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER = 'x-happier-transfer-recipient-public-key';

const ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES = 1 + 12 + 16; // version + nonce + auth tag
// Encrypted data-key envelopes are small and fixed-size today (~105 bytes for V1), but we still
// cap them independently so hostile peers cannot force large base64 decode allocations.
const ENCRYPTED_TRANSFER_DATA_KEY_ENVELOPE_HARD_MAX_BYTES = 1024;
const DIRECT_PEER_OPEN_BODY_HARD_MAX_BYTES = 1024 * 1024;

function encodeDirectPeerTransferPathKey(transferId: string): string {
  return Buffer.from(transferId, 'utf8').toString('base64url');
}

function decodeDirectPeerTransferPathKey(transferKey: string): string {
  const normalizedTransferKey = transferKey.trim();
  if (normalizedTransferKey.length === 0) {
    return normalizedTransferKey;
  }

  try {
    const decoded = Buffer.from(normalizedTransferKey, 'base64url').toString('utf8');
    if (decoded.length === 0) {
      return normalizedTransferKey;
    }
    return encodeDirectPeerTransferPathKey(decoded) === normalizedTransferKey
      ? decoded
      : normalizedTransferKey;
  } catch {
    return normalizedTransferKey;
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

function estimateJsonStringUtf8BytesBounded(value: string, maxBytes: number): number {
  // Quotes.
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 /* " */ || codeUnit === 0x5c /* \\ */) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      // JSON escapes control chars as \u00XX.
      bytes += 6;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      // Surrogates are uncommon in our payloads; fail closed by assuming an escaped form.
      bytes += 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) {
      return maxBytes + 1;
    }
  }
  return bytes;
}

function estimateJsonUtf8BytesBounded(value: unknown, maxBytes: number): number {
  const seenObjects = new Set<object>();

  const estimateValue = (input: unknown): number => {
    if (input === null) return 4;
    if (typeof input === 'string') return estimateJsonStringUtf8BytesBounded(input, maxBytes);
    if (typeof input === 'boolean') return input ? 4 : 5;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return 4; // null
      return Buffer.byteLength(String(input), 'utf8');
    }
    if (typeof input === 'undefined' || typeof input === 'function' || typeof input === 'symbol') {
      // JSON.stringify omits these in objects and turns them into null in arrays. We overestimate
      // by treating them as null so we fail closed for large request bodies.
      return 4;
    }
    if (typeof input === 'bigint') {
      return maxBytes + 1;
    }

    if (Array.isArray(input)) {
      let bytes = 2; // []
      for (let index = 0; index < input.length; index += 1) {
        if (index > 0) bytes += 1; // comma
        bytes += estimateValue(input[index]);
        if (bytes > maxBytes) return maxBytes + 1;
      }
      return bytes;
    }

    if (typeof input === 'object') {
      const obj = input as object;
      if (seenObjects.has(obj)) {
        return maxBytes + 1;
      }
      seenObjects.add(obj);
      try {
        let bytes = 2; // {}
        const keys = Object.keys(obj as Record<string, unknown>);
        for (let index = 0; index < keys.length; index += 1) {
          if (index > 0) bytes += 1; // comma
          const key = keys[index] ?? '';
          bytes += estimateJsonStringUtf8BytesBounded(key, maxBytes);
          bytes += 1; // colon
          bytes += estimateValue((obj as Record<string, unknown>)[key]);
          if (bytes > maxBytes) return maxBytes + 1;
        }
        return bytes;
      } finally {
        seenObjects.delete(obj);
      }
    }

    return maxBytes + 1;
  };

  return estimateValue(value);
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
    // Direct-peer candidates must not rely on query params for auth or routing. Strip any query/hash.
    parsed.search = '';
    parsed.hash = '';
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
    return {
      requestUrl: candidate.url,
      ...(explicitAuthorizationToken
        ? {
            authorizationHeader: `${DIRECT_PEER_AUTH_SCHEME} ${explicitAuthorizationToken}`,
          }
        : {}),
    };
  }
}

function readAdvertisedHosts(networkInterfacesFn: typeof networkInterfaces): string[] {
  const configuredHosts = String(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (configuredHosts.length > 0) {
    return Array.from(new Set(configuredHosts));
  }

  const hosts = new Set<string>();
  for (const entries of Object.values(networkInterfacesFn())) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal) continue;
      if (String(entry.family) !== 'IPv4') continue;
      if (typeof entry.address === 'string' && entry.address.trim().length > 0) {
        hosts.add(entry.address.trim());
      }
    }
  }
  return Array.from(hosts);
}

function readDirectPeerTtlMs(): number {
  return parsePositiveInt(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_TTL_MS, DEFAULT_DIRECT_PEER_TTL_MS);
}

function readDirectPeerRequestTimeoutMs(): number {
  return parsePositiveInt(
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_REQUEST_TIMEOUT_MS,
    DEFAULT_DIRECT_PEER_REQUEST_TIMEOUT_MS,
  );
}

function readDirectPeerChunkBytes(): number {
  return clampTransferChunkBytes(parsePositiveInt(
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES,
    DEFAULT_DIRECT_PEER_CHUNK_BYTES,
  ));
}

function readDirectPeerExpirySkewMs(): number {
  // Clock skew tolerance used only for candidate selection and local cleanup, not as an auth bypass.
  return parseNonNegativeInt(
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_EXPIRY_SKEW_MS,
    DEFAULT_DIRECT_PEER_EXPIRY_SKEW_MS,
  );
}

function readDirectPeerOpenBodyMaxBytes(): number {
  return Math.min(
    parsePositiveInt(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_OPEN_BODY_MAX_BYTES, DEFAULT_DIRECT_PEER_OPEN_BODY_MAX_BYTES),
    DIRECT_PEER_OPEN_BODY_HARD_MAX_BYTES,
  );
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
    // Avoid buffering an extra array of chunks when the peer provides a valid content-length.
    const buffer = new Uint8Array(expectedBytes);
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

      // If the peer lies about content-length, switch to the same bounded growing-buffer strategy
      // we use when content-length is omitted.
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

    // If we never triggered the mismatch fallback, use the filled prefix (may be shorter than content-length).
    if (!bytes) bytes = buffer.subarray(0, offset);
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

  if (!bytes) {
    throw params.onInvalidJson();
  }
  const text = decoder.decode(bytes);
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

function serializeDirectPeerOpenRequestBody(params: Readonly<{ openBody: unknown }>): string {
  const maxBodyBytes = readDirectPeerOpenBodyMaxBytes();
  const estimatedBytes = estimateJsonUtf8BytesBounded(params.openBody, maxBodyBytes);
  if (estimatedBytes > maxBodyBytes) {
    throw new Error(`Direct peer transfer open request body exceeds the configured body-limit (${maxBodyBytes} bytes)`);
  }

  try {
    const encoded = JSON.stringify(params.openBody);
    if (typeof encoded !== 'string') {
      throw new Error('Invalid direct peer transfer request');
    }
    if (Buffer.byteLength(encoded, 'utf8') > maxBodyBytes) {
      throw new Error(`Direct peer transfer open request body exceeds the configured body-limit (${maxBodyBytes} bytes)`);
    }
    return encoded;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Direct peer transfer open request body exceeds the configured body-limit')) {
      throw error;
    }
    throw new Error('Invalid direct peer transfer request');
  }
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
  const expirySkewMs = readDirectPeerExpirySkewMs();

  const disposePayloadSourceBestEffort = (source: TransferPayloadSource) => {
    void disposeTransferPayloadSource(source).catch(() => undefined);
  };

  function publishTransfer(input: PublishDirectPeerTransferInput): PublishedDirectPeerTransfer {
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
    if (stored.expiresAt + expirySkewMs < now()) {
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
    const scope = onDemandScopesByToken.get(input.transferToken);
    if (!scope) {
      return null;
    }
    if (scope.expiresAt + expirySkewMs < now()) {
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
    const token = stored.transferToken;
    onDemandScopesByToken.delete(token);

    for (const [candidateId, entry] of publishedTransfers.entries()) {
      if (entry.transferToken !== token) {
        continue;
      }
      publishedTransfers.delete(candidateId);
      disposePayloadSourceBestEffort(entry.payloadSource);
    }
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
  const raw = value.trim();
  if (raw.length === 0) return 0;
  const paddingBytes = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((raw.length * 3) / 4) - paddingBytes);
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
  const openSizeBytesCache = new Map<string, Promise<number>>();
  const openManifestHashCache = new Map<string, Promise<string>>();

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

  typed.post('/machine-transfers/direct/:transferId/open', {
    schema: {
      params: z.object({ transferId: z.string().min(1) }),
      querystring: z.object({ token: z.string().min(1).optional() }),
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
    const transferToken = readDirectPeerAuthorizationToken(request.headers.authorization) ?? request.query.token ?? '';
    const transferTokenDigest = hashTransferToken(transferToken);
    let payloadSource = params.readPublishedTransfer({
      transferId,
      transferToken,
      transferTokenDigest,
    });
    if (!payloadSource && params.resolveOnDemandTransfer) {
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
      const statusCode = transferToken.trim().length > 0 ? 401 : 404;
      reply.code(statusCode);
      return { ok: false as const, error: 'Direct peer transfer not available' };
    }
    try {
      createEncryptedTransferChunkEnvelope({
        transferId,
        sequence: 0,
        payload: Buffer.alloc(0),
        recipientPublicKeyBase64: request.headers[DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER],
      });
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
      querystring: z.object({ token: z.string().min(1).optional() }),
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
    const transferToken = readDirectPeerAuthorizationToken(request.headers.authorization) ?? request.query.token ?? '';
    const transferTokenDigest = hashTransferToken(transferToken);
    const payloadSource = params.readPublishedTransfer({
      transferId,
      transferToken,
      transferTokenDigest,
    });
    if (!payloadSource) {
      const statusCode = transferToken.trim().length > 0 ? 401 : 404;
      reply.code(statusCode);
      return { ok: false as const, error: 'Direct peer transfer not available' };
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
        payload: await readTransferPayloadChunk({
          source: payloadSource,
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
    port: 0,
    host: process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_HOST ?? DEFAULT_DIRECT_PEER_BIND_HOST,
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
  let lastError: Error | null = null;

  for (const candidate of params.endpointCandidates) {
    const parsedCandidate = TransferEndpointCandidateSchema.safeParse(candidate);
    if (!parsedCandidate.success) continue;
    if (parsedCandidate.data.expiresAt + expirySkewMs < now()) continue;
    if (parsedCandidate.data.kind !== 'http' && parsedCandidate.data.kind !== 'https') {
      continue;
    }
    try {
      const recipientKeyPair = createTransferRecipientKeyPair();
      const auth = extractDirectPeerRequestAuth(parsedCandidate.data);
      const openBodyJson = params.openBody !== undefined
        ? serializeDirectPeerOpenRequestBody({ openBody: params.openBody })
        : undefined;
      const headers: Record<string, string> = {
        [DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER]: recipientKeyPair.recipientPublicKeyBase64,
      };
      if (auth.authorizationHeader) {
        headers.authorization = auth.authorizationHeader;
      }
      if (openBodyJson !== undefined) {
        headers['content-type'] = 'application/json';
      }
      const openResponse = await fetchFn(`${auth.requestUrl}/open`, {
        method: 'POST',
        headers,
        ...(openBodyJson !== undefined
          ? { body: openBodyJson }
          : {}),
        signal: AbortSignal.timeout(readDirectPeerRequestTimeoutMs()),
      });
      if (!openResponse.ok) {
        lastError = new Error(`Direct peer request failed with status ${openResponse.status}`);
        continue;
      }
      let json: unknown;
      json = await readJsonResponseWithBodyLimit({
        response: openResponse,
        maxBodyBytes: Math.min(
          64 * 1024,
          resolveDirectPeerJsonBodyMaxBytes(params.maxInMemoryPayloadBytes),
        ),
        onInvalidJson: () => createInvalidDirectPeerTransferResponseError(params.transferId),
        onOverLimit: () => new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${params.maxInMemoryPayloadBytes}`),
      });
      const parsed = DirectPeerTransferResponseSchema.safeParse(json);
      if (!parsed.success || parsed.data.transferId !== params.transferId) {
        throw createInvalidDirectPeerTransferResponseError(params.transferId);
      }
      for (let sequence = 0; sequence < parsed.data.totalChunks; sequence += 1) {
        const chunkResponse = await fetchFn(`${auth.requestUrl}/chunks/${sequence}`, {
          method: 'GET',
          headers: {
            ...headers,
            ...(auth.authorizationHeader ? { authorization: auth.authorizationHeader } : {}),
          },
          signal: AbortSignal.timeout(readDirectPeerRequestTimeoutMs()),
        });
        if (!chunkResponse.ok) {
          throw new Error(`Direct peer request failed with status ${chunkResponse.status}`);
        }
        let chunkJson: unknown;
        chunkJson = await readJsonResponseWithBodyLimit({
          response: chunkResponse,
          maxBodyBytes: resolveDirectPeerJsonBodyMaxBytes(params.maxInMemoryPayloadBytes),
          onInvalidJson: () => createInvalidDirectPeerTransferResponseError(params.transferId),
          onOverLimit: () => new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${params.maxInMemoryPayloadBytes}`),
        });
        const parsedChunk = TransferChunkEnvelopeSchema.safeParse(chunkJson);
        if (
          !parsedChunk.success
          || parsedChunk.data.transferId !== params.transferId
          || parsedChunk.data.sequence !== sequence
          || !parsedChunk.data.encryptedDataKeyEnvelopeBase64
        ) {
          throw createInvalidDirectPeerTransferResponseError(params.transferId);
        }
        const rawPayloadBase64 = parsedChunk.data.payloadBase64.trim();
        const rawDataKeyEnvelopeBase64 = parsedChunk.data.encryptedDataKeyEnvelopeBase64.trim();
        const estimatedEncryptedPayloadBytes = estimateBase64DecodedBytes(rawPayloadBase64);
        const estimatedDataKeyEnvelopeBytes = estimateBase64DecodedBytes(rawDataKeyEnvelopeBase64);

        const maxEncryptedBytes = params.maxInMemoryPayloadBytes + ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES;
        // Fail closed before decrypting so untrusted peers can't force huge base64 decodes.
        // Note: decrypting requires decoding both payload bytes and the data-key envelope.
        const maxEncodedChars = Math.ceil(maxEncryptedBytes / 3) * 4;
        if (
          rawPayloadBase64.length > maxEncodedChars
          || estimatedEncryptedPayloadBytes > maxEncryptedBytes
          || estimatedDataKeyEnvelopeBytes > ENCRYPTED_TRANSFER_DATA_KEY_ENVELOPE_HARD_MAX_BYTES
        ) {
          throw new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${params.maxInMemoryPayloadBytes}`);
        }
        await params.onChunk(decryptEncryptedTransferChunkEnvelope({
          transferId: params.transferId,
          sequence,
          payloadBase64: parsedChunk.data.payloadBase64,
          encryptedDataKeyEnvelopeBase64: parsedChunk.data.encryptedDataKeyEnvelopeBase64,
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
