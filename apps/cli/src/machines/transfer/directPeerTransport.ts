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
import type { TransferPayloadCodec } from './transferPayloadCodec';
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
  type TransferPayloadSource,
} from './transferPayloadSource';
import { createTransferPayloadFileSink, type TransferPayloadFileResult } from './transferPayloadFileSink';

const DEFAULT_DIRECT_PEER_TTL_MS = 30_000;
const DEFAULT_DIRECT_PEER_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_DIRECT_PEER_CHUNK_BYTES = 256 * 1024;
const DEFAULT_DIRECT_PEER_BIND_HOST = '0.0.0.0';
const DIRECT_PEER_AUTH_SCHEME = 'Bearer';
const DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER = 'x-happier-transfer-recipient-public-key';

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

function safeTokenEquals(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
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
    const transferToken = parsed.searchParams.get('token');
    const authorizationToken = explicitAuthorizationToken || transferToken || '';
    if (!transferToken && !authorizationToken) {
      return { requestUrl: parsed.toString() };
    }
    if (transferToken) {
      parsed.searchParams.delete('token');
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
  return parsePositiveInt(
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES,
    DEFAULT_DIRECT_PEER_CHUNK_BYTES,
  );
}

export type PublishedDirectPeerTransfer = Readonly<{
  transferId: string;
  transferToken: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  expiresAt: number;
}>;

export type TypedDirectPeerTransferHandle<TPayload> = Readonly<{
  publishTransfer: (input: Readonly<{
    transferId: string;
    payload: TPayload;
  }>) => readonly TransferEndpointCandidate[];
  requestPayload?: (input: Readonly<{
    transferId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
  }>) => Promise<TPayload>;
  clearPublishedTransfer: (transferId: string) => void;
}>;

type PublishDirectPeerTransferInput = Readonly<{
  transferId: string;
  payload?: Buffer;
  payloadSource?: TransferPayloadSource;
}>;

type StoredPublishedTransfer = Readonly<{
  transferToken: string;
  expiresAt: number;
  payloadSource: TransferPayloadSource;
}>;

export function createDirectPeerTransferRegistry(params: Readonly<{
  advertisedPort: number;
  now?: () => number;
  networkInterfacesFn?: typeof networkInterfaces;
}>) {
  const now = params.now ?? Date.now;
  const networkInterfacesFn = params.networkInterfacesFn ?? networkInterfaces;
  const publishedTransfers = new Map<string, StoredPublishedTransfer>();

  function publishTransfer(input: PublishDirectPeerTransferInput): PublishedDirectPeerTransfer {
    const payloadSource = input.payloadSource ?? (input.payload ? createBufferTransferPayloadSource(input.payload) : null);
    if (!payloadSource) {
      throw new Error(`Direct peer transfer ${input.transferId} is missing a payload source`);
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
      expiresAt,
      payloadSource,
    });

    return {
      transferId: input.transferId,
      transferToken,
      endpointCandidates,
      expiresAt,
    };
  }

  function readPublishedTransfer(input: Readonly<{ transferId: string; transferToken: string }>): TransferPayloadSource | null {
    const stored = publishedTransfers.get(input.transferId);
    if (!stored) return null;
    if (stored.expiresAt < now()) {
      publishedTransfers.delete(input.transferId);
      return null;
    }
    if (!safeTokenEquals(input.transferToken, stored.transferToken)) {
      return null;
    }
    return stored.payloadSource;
  }

  function clearPublishedTransfer(transferId: string): void {
    publishedTransfers.delete(transferId);
  }

  return {
    publishTransfer,
    readPublishedTransfer,
    clearPublishedTransfer,
  };
}

export function createTypedDirectPeerTransferRegistry<TPayload>(params: Readonly<{
  advertisedPort: number;
  codec: TransferPayloadCodec<TPayload>;
  now?: () => number;
  networkInterfacesFn?: typeof networkInterfaces;
}>) {
  const registry = createDirectPeerTransferRegistry(params);

  return {
    publishTransfer(input: Readonly<{ transferId: string; payload: TPayload }>): PublishedDirectPeerTransfer {
      return registry.publishTransfer({
        transferId: input.transferId,
        payload: params.codec.encode(input.payload),
      });
    },
    readPublishedTransfer(input: Readonly<{ transferId: string; transferToken: string }>): TPayload | null {
      const payloadSource = registry.readPublishedTransfer(input);
      if (payloadSource === null || payloadSource.kind !== 'buffer') {
        return null;
      }
      return params.codec.decode({
        transferId: input.transferId,
        payload: payloadSource.payload,
      });
    },
    clearPublishedTransfer(transferId: string): void {
      registry.clearPublishedTransfer(transferId);
    },
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

export function createDirectPeerTransferApp(params: Readonly<{
  readPublishedTransfer: (input: Readonly<{ transferId: string; transferToken: string }>) => TransferPayloadSource | null;
}>): FastifyInstance {
  const app = fastify({
    logger: false,
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
    const payloadSource = params.readPublishedTransfer({
      transferId,
      transferToken,
    });
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
    const sizeBytes = await resolveTransferPayloadSizeBytes(payloadSource);
    return {
      transferId,
      manifestHash: await resolveTransferPayloadManifestHash(payloadSource),
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
    const payloadSource = params.readPublishedTransfer({
      transferId,
      transferToken,
    });
    if (!payloadSource) {
      const statusCode = transferToken.trim().length > 0 ? 401 : 404;
      reply.code(statusCode);
      return { ok: false as const, error: 'Direct peer transfer not available' };
    }

    const chunkBytes = readDirectPeerChunkBytes();
    const sizeBytes = await resolveTransferPayloadSizeBytes(payloadSource);
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

export async function startTypedDirectPeerTransferServer<TPayload>(params: Readonly<{
  codec: TransferPayloadCodec<TPayload>;
  readPublishedTransfer: (input: Readonly<{ transferId: string; transferToken: string }>) => TPayload | null;
}>): Promise<Readonly<{ port: number; stop: () => Promise<void> }>> {
  return await startDirectPeerTransferServer({
    readPublishedTransfer: (input) => {
      const payload = params.readPublishedTransfer(input);
      return payload === null ? null : createBufferTransferPayloadSource(params.codec.encode(payload));
    },
  });
}

async function requestDirectPeerTransfer<TPayload>(params: Readonly<{
  transferId: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  fetchFn?: typeof fetch;
  now?: () => number;
  onChunk: (chunk: Buffer) => Promise<void> | void;
  onFinish: (manifestHash: string) => Promise<TPayload>;
  onAbort?: () => Promise<void> | void;
}>): Promise<TPayload> {
  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? Date.now;
  let lastError: Error | null = null;

  for (const candidate of params.endpointCandidates) {
    const parsedCandidate = TransferEndpointCandidateSchema.safeParse(candidate);
    if (!parsedCandidate.success) continue;
    if (parsedCandidate.data.expiresAt < now()) continue;
    if (parsedCandidate.data.kind !== 'http' && parsedCandidate.data.kind !== 'https') {
      continue;
    }
    try {
      const recipientKeyPair = createTransferRecipientKeyPair();
      const auth = extractDirectPeerRequestAuth(parsedCandidate.data);
      const openResponse = await fetchFn(`${auth.requestUrl}/open`, {
        method: 'POST',
        ...(auth.authorizationHeader
          ? {
              headers: {
                authorization: auth.authorizationHeader,
                [DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER]: recipientKeyPair.recipientPublicKeyBase64,
              },
            }
          : {}),
        signal: AbortSignal.timeout(readDirectPeerRequestTimeoutMs()),
      });
      if (!openResponse.ok) {
        lastError = new Error(`Direct peer request failed with status ${openResponse.status}`);
        continue;
      }
      let json: unknown;
      try {
        json = await openResponse.json();
      } catch {
        throw createInvalidDirectPeerTransferResponseError(params.transferId);
      }
      const parsed = DirectPeerTransferResponseSchema.safeParse(json);
      if (!parsed.success || parsed.data.transferId !== params.transferId) {
        throw createInvalidDirectPeerTransferResponseError(params.transferId);
      }
      for (let sequence = 0; sequence < parsed.data.totalChunks; sequence += 1) {
        const chunkResponse = await fetchFn(`${auth.requestUrl}/chunks/${sequence}`, {
          method: 'GET',
          ...(auth.authorizationHeader
            ? {
                headers: {
                  authorization: auth.authorizationHeader,
                  [DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER]: recipientKeyPair.recipientPublicKeyBase64,
                },
              }
            : {}),
          signal: AbortSignal.timeout(readDirectPeerRequestTimeoutMs()),
        });
        if (!chunkResponse.ok) {
          throw new Error(`Direct peer request failed with status ${chunkResponse.status}`);
        }
        let chunkJson: unknown;
        try {
          chunkJson = await chunkResponse.json();
        } catch {
          throw createInvalidDirectPeerTransferResponseError(params.transferId);
        }
        const parsedChunk = TransferChunkEnvelopeSchema.safeParse(chunkJson);
        if (
          !parsedChunk.success
          || parsedChunk.data.transferId !== params.transferId
          || parsedChunk.data.sequence !== sequence
          || !parsedChunk.data.encryptedDataKeyEnvelopeBase64
        ) {
          throw createInvalidDirectPeerTransferResponseError(params.transferId);
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

export async function requestDirectPeerTransferPayload(params: Readonly<{
  transferId: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  fetchFn?: typeof fetch;
  now?: () => number;
}>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return await requestDirectPeerTransfer({
    ...params,
    onChunk: async (chunk) => {
      chunks.push(chunk);
    },
    onFinish: async (manifestHash) => {
      const payload = Buffer.concat(chunks);
      if (createTransferManifestHash(payload) !== manifestHash) {
        throw new Error(`Direct peer transfer manifest mismatch for ${params.transferId}`);
      }
      return payload;
    },
  });
}

export async function requestDirectPeerTransferToFile(params: Readonly<{
  transferId: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  destinationPath: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}>): Promise<TransferPayloadFileResult> {
  const sink = await createTransferPayloadFileSink({
    destinationPath: params.destinationPath,
  });
  return await requestDirectPeerTransfer({
    ...params,
    onChunk: async (chunk) => {
      await sink.appendChunk(chunk);
    },
    onFinish: async (manifestHash) => await sink.finalize(manifestHash),
    onAbort: async () => {
      await sink.abort();
    },
  });
}

export async function requestTypedDirectPeerTransferPayload<TPayload>(params: Readonly<{
  transferId: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  codec: TransferPayloadCodec<TPayload>;
  fetchFn?: typeof fetch;
  now?: () => number;
}>): Promise<TPayload> {
  const payload = await requestDirectPeerTransferPayload(params);
  return params.codec.decode({
    transferId: params.transferId,
    payload,
  });
}
