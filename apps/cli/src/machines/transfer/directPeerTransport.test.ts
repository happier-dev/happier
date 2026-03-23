import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('direct peer machine transfer', () => {
  afterEach(() => {
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_TTL_MS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_EXPIRY_SKEW_MS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_OPEN_BODY_MAX_BYTES;
    delete process.env.HAPPIER_FILES_READ_MAX_BYTES;
  });

  it('hard-clamps the direct peer chunk-bytes env override to a bounded ceiling', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    // Intentionally larger than the hard max. This must be clamped to avoid huge per-chunk allocations.
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES = '10000000';

    const {
      createDirectPeerTransferApp,
      createDirectPeerTransferRegistry,
    } = await import('./directPeerTransport');
    const { createFileTransferPayloadSource } = await import('./transferPayloadSource');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46002,
      now: () => 1_000,
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-chunk-bytes-'));
    const tempPath = join(tempDir, 'payload.bin');
    // Slightly over 1 MiB so the clamped chunk size yields >1 chunk.
    await writeFile(tempPath, Buffer.alloc(1_048_577, 7));

    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

    const published = registry.publishTransfer({
      transferId: 'transfer_chunk_bytes_clamped',
      payloadSource: createFileTransferPayloadSource({ filePath: tempPath }),
    });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: registry.readPublishedTransfer,
    });

    try {
      await app.ready();

      const open = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/transfer_chunk_bytes_clamped/open',
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(open.statusCode).toBe(200);
      expect(open.json()).toMatchObject({
        transferId: 'transfer_chunk_bytes_clamped',
        manifestHash: expect.stringMatching(/^sha256:/),
      });
      expect(open.json().totalChunks).toBe(2);
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('serves a published payload as an encrypted chunk session only when the transfer token matches', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const {
      createDirectPeerTransferApp,
      createDirectPeerTransferRegistry,
    } = await import('./directPeerTransport');
    const { createFileTransferPayloadSource } = await import('./transferPayloadSource');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');
    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46001,
      now: () => 1_000,
    });
    const payload = Buffer.from('direct-peer-payload', 'utf8');
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-'));
    const tempPath = join(tempDir, 'payload.bin');
    await writeFile(tempPath, payload);
    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

    const published = registry.publishTransfer({
      transferId: 'transfer_1',
      payloadSource: createFileTransferPayloadSource({ filePath: tempPath }),
    });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: registry.readPublishedTransfer,
    });

    try {
      await app.ready();

      const success = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/transfer_1/open',
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(success.statusCode).toBe(200);
      expect(success.json()).toMatchObject({
        transferId: 'transfer_1',
        totalChunks: 1,
        manifestHash: expect.stringMatching(/^sha256:/),
      });
      expect(success.json()).not.toHaveProperty('payloadBase64');

      const chunk = await app.inject({
        method: 'GET',
        url: '/machine-transfers/direct/transfer_1/chunks/0',
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(chunk.statusCode).toBe(200);
      expect(chunk.json()).toMatchObject({
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 0,
        encryptedDataKeyEnvelopeBase64: expect.any(String),
      });
      expect(chunk.json().payloadBase64).not.toBe(payload.toString('base64'));

      const unauthorized = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/transfer_1/open',
        headers: {
          authorization: 'Bearer wrong-token',
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(unauthorized.statusCode).toBe(401);
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fetches a live published payload from the advertised endpoint candidates', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const {
      createDirectPeerTransferRegistry,
      requestDirectPeerTransferToFile,
      startDirectPeerTransferServer,
    } = await import('./directPeerTransport');

    let registry: ReturnType<typeof createDirectPeerTransferRegistry> | null = null;
    const server = await startDirectPeerTransferServer({
      readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
    });
    registry = createDirectPeerTransferRegistry({
      advertisedPort: server.port,
      now: () => 2_000,
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-live-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      const payload = Buffer.from('payload-from-live-server', 'utf8');
      const published = registry.publishTransfer({
        transferId: 'transfer_2',
        payload,
      });

      await requestDirectPeerTransferToFile({
        transferId: 'transfer_2',
        endpointCandidates: published.endpointCandidates,
        destinationPath,
        now: () => 2_000,
      });

      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await server.stop();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when a peer advertises an oversized chunk response body before JSON parsing', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES = '8';

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-oversized-body-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as Request).url ?? '');
      if (url.endsWith('/open')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_oversized_body',
          totalChunks: 1,
          manifestHash: 'sha256:abc',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/chunks/0')) {
        return new Response('not-json', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            // Must be checked before attempting chunkResponse.json(), otherwise an untrusted peer can OOM us.
            'content-length': String(1024 * 1024),
          },
        });
      }
      return new Response('not-found', { status: 404 });
    });

    await expect(requestDirectPeerTransferToFile({
      transferId: 'transfer_oversized_body',
      endpointCandidates: [{
        kind: 'http',
        url: 'http://example.test/machine-transfers/direct/transfer_oversized_body',
        authorizationToken: 'abc',
        expiresAt: 10_000,
      }],
      fetchFn,
      now: () => 1_000,
      destinationPath,
    })).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');

    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('fails closed when a peer streams an oversized chunk response body without content-length (bounded incremental read)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES = '8';

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-streamed-oversized-body-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as Request).url ?? '');
      if (url.endsWith('/open')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_streamed_oversized_body',
          totalChunks: 1,
          manifestHash: 'sha256:abc',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/chunks/0')) {
        const encoder = new TextEncoder();
        const chunk = encoder.encode('A'.repeat(1024));
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            // Intentionally exceed the transport's bounded JSON read cap without supplying content-length.
            for (let i = 0; i < 32; i += 1) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      return new Response('not-found', { status: 404 });
    });

    await expect(requestDirectPeerTransferToFile({
      transferId: 'transfer_streamed_oversized_body',
      endpointCandidates: [{
        kind: 'http',
        url: 'http://example.test/machine-transfers/direct/transfer_streamed_oversized_body',
        authorizationToken: 'abc',
        expiresAt: 10_000,
      }],
      fetchFn,
      now: () => 1_000,
      destinationPath,
    })).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');

    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('fails closed before parsing when a direct-peer /open request body exceeds the configured body-limit', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_OPEN_BODY_MAX_BYTES = '32';

    const {
      createDirectPeerTransferApp,
      createDirectPeerTransferRegistry,
    } = await import('./directPeerTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46001,
      now: () => 1_000,
    });

    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

    const published = registry.publishTransfer({
      transferId: 'transfer_open_body_limit',
      payload: Buffer.from('payload', 'utf8'),
    });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: registry.readPublishedTransfer,
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/transfer_open_body_limit/open',
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
          'content-type': 'application/json',
        },
        payload: {
          payload: 'x'.repeat(256),
        },
      });

      expect(response.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });

  it('does not accumulate streamed JSON chunks in memory when content-length is provided (preallocated read)', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-json-prealloc-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const payload = Buffer.from('payload-with-preallocated-json-read', 'utf8');
    let recipientPublicKeyBase64 = '';

    const encoder = new TextEncoder();
    const streamJson = (value: unknown, chunkSize: number): ReadableStream<Uint8Array> => {
      const bytes = encoder.encode(JSON.stringify(value));
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(bytes.length, offset + chunkSize);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
      });
    };

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const url = String(input);
      if (url.endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        const openBody = {
          transferId: 'transfer_prealloc_json',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        };
        const openText = JSON.stringify(openBody);
        return new Response(streamJson(openBody, 1), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(encoder.encode(openText).byteLength),
          },
        });
      }
      if (url.endsWith('/chunks/0')) {
        const chunkBody = {
          transferId: 'transfer_prealloc_json',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_prealloc_json',
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(9),
          }),
        };
        const chunkText = JSON.stringify(chunkBody);
        return new Response(streamJson(chunkBody, 1), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(encoder.encode(chunkText).byteLength),
          },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const originalPush = Array.prototype.push;
    Array.prototype.push = function (...args: unknown[]) {
      const stack = new Error().stack ?? '';
      if (stack.includes('readJsonResponseWithBodyLimit') && stack.includes('directPeerTransport.ts')) {
        throw new Error('readJsonResponseWithBodyLimit should not push streamed chunks when content-length is provided');
      }
      return originalPush.apply(this, args as any);
    };

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_prealloc_json',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_prealloc_json',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 5_000,
        destinationPath,
      });

      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      Array.prototype.push = originalPush;
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed before serializing an oversized direct-peer /open request body (avoids whole-buffer JSON assembly)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_OPEN_BODY_MAX_BYTES = '32';

    const openBody = {
      payload: 'x'.repeat(256),
    };

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const fetchFn: typeof fetch = vi.fn(async () => {
      throw new Error('fetch should not be called');
    });

    const originalStringify = JSON.stringify;
    JSON.stringify = ((value: unknown, replacer?: unknown, space?: unknown) => {
      if (value === openBody) {
        throw new Error('JSON.stringify should not be called for an oversized open body');
      }
      return originalStringify(value as any, replacer as any, space as any);
    }) as unknown as typeof JSON.stringify;

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-open-body-client-guard-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await expect(requestDirectPeerTransferToFile({
        transferId: 'transfer_open_body_client_guard',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://example.test/machine-transfers/direct/transfer_open_body_client_guard',
          authorizationToken: 'abc',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 1_000,
        destinationPath,
        openBody,
      })).rejects.toThrow('Direct peer transfer open request body exceeds the configured body-limit');

      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      JSON.stringify = originalStringify;
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('supports on-demand transfers authorized by a scoped token and open-request body', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const {
      createDirectPeerTransferRegistry,
      requestDirectPeerTransferToFile,
      startDirectPeerTransferServer,
    } = await import('./directPeerTransport');
    const { createBufferTransferPayloadSource } = await import('./transferPayloadSource');

    let registry: ReturnType<typeof createDirectPeerTransferRegistry> | null = null;
    const server = await startDirectPeerTransferServer({
      readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
      resolveOnDemandTransfer: async (input) => await registry?.resolveOnDemandTransferOnOpen(input) ?? null,
    });
    registry = createDirectPeerTransferRegistry({
      advertisedPort: server.port,
      now: () => 3_000,
    });

    const tokenCarrierTransferId = 'scope_carrier';
    const published = registry.publishTransfer({
      transferId: tokenCarrierTransferId,
      payload: Buffer.from('token-carrier', 'utf8'),
      onDemandScope: {
        allowTransferId: (transferId) => transferId.startsWith('dynamic:'),
        resolvePayloadSourceOnOpen: async ({ requestBody }) => {
          if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
            throw new Error('invalid request body');
          }
          const payload = (requestBody as { payload?: unknown }).payload;
          if (typeof payload !== 'string') {
            throw new Error('invalid request body');
          }
          return createBufferTransferPayloadSource(Buffer.from(payload, 'utf8'));
        },
      },
    });

    const encodeKey = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
    const tokenCarrierKey = encodeKey(tokenCarrierTransferId);
    const dynamicTransferId = 'dynamic:transfer_1';
    const dynamicKey = encodeKey(dynamicTransferId);

    const dynamicCandidates = published.endpointCandidates.map((candidate) => ({
      ...candidate,
      url: candidate.url.replace(tokenCarrierKey, dynamicKey),
    }));

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-on-demand-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    await requestDirectPeerTransferToFile({
      transferId: dynamicTransferId,
      endpointCandidates: dynamicCandidates,
      destinationPath,
      now: () => 3_000,
      openBody: {
        payload: 'payload-from-on-demand-scope',
      },
    });

    await expect(readFile(destinationPath)).resolves.toEqual(Buffer.from('payload-from-on-demand-scope', 'utf8'));

    await server.stop();
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('does not use Buffer.concat while fetching a direct-peer payload (small-only API must stay bounded)', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const payload = Buffer.from('payload-without-buffer-concat', 'utf8');
    let recipientPublicKeyBase64 = '';

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (String(input).endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_no_concat',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(input).endsWith('/chunks/0')) {
        if (String(input).includes('transfer_no_concat/chunks/0')) {
          return new Response('nope', { status: 500 });
        }
        return new Response(JSON.stringify({
          transferId: 'transfer_no_concat',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_no_concat',
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(9),
          }),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${String(input)}`);
    });

    const originalConcat = Buffer.concat;
    Buffer.concat = ((chunks: readonly Uint8Array[], totalLength?: number) => {
      const stack = new Error().stack ?? '';
      const callerLine = stack.split('\n')[2] ?? '';
      if (callerLine.includes('directPeerTransport.ts')) {
        throw new Error('Buffer.concat should not be used');
      }
      return originalConcat(chunks as any, totalLength as any);
    }) as unknown as typeof Buffer.concat;

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-no-concat-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_no_concat',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_no_concat',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        }, {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_no_concat_fallback',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 5_000,
        destinationPath,
      });

      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      Buffer.concat = originalConcat;
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects publishing buffer-backed payloads larger than the in-memory max-bytes limit', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_FILES_READ_MAX_BYTES = '8';

    const { createDirectPeerTransferRegistry } = await import('./directPeerTransport');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46001,
      now: () => 2_200,
    });

    expect(() => registry.publishTransfer({
      transferId: 'transfer_publish_oversized',
      payload: Buffer.from('payload-too-large', 'utf8'), // > 8 bytes
    })).toThrow('Transfer exceeds the in-memory transfer size limit');
  });

  it('fetches a live published payload directly into a destination file with verified manifest metadata', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    // File-backed transfers must not be constrained by the small-only in-memory transfer cap.
    process.env.HAPPIER_FILES_READ_MAX_BYTES = '8';

    const {
      createDirectPeerTransferRegistry,
      requestDirectPeerTransferToFile,
      startDirectPeerTransferServer,
    } = await import('./directPeerTransport');
    const { createTransferManifestHash } = await import('./transferChunkEncryption');

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-file-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    let registry: ReturnType<typeof createDirectPeerTransferRegistry> | null = null;
    const server = await startDirectPeerTransferServer({
      readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
    });
    registry = createDirectPeerTransferRegistry({
      advertisedPort: server.port,
      now: () => 2_500,
    });

    try {
      const payload = Buffer.from('payload-from-live-server-file', 'utf8'); // > 8 bytes
      const sourcePath = join(tempDir, 'payload-source.bin');
      await writeFile(sourcePath, payload);
      const { createFileTransferPayloadSource } = await import('./transferPayloadSource');
      const published = registry.publishTransfer({
        transferId: 'transfer_to_file',
        payloadSource: createFileTransferPayloadSource({ filePath: sourcePath }),
      });

      const received = await requestDirectPeerTransferToFile({
        transferId: 'transfer_to_file',
        endpointCandidates: published.endpointCandidates,
        destinationPath,
        now: () => 2_500,
      });

      expect(received).toEqual({
        destinationPath,
        manifestHash: createTransferManifestHash(payload),
        sizeBytes: payload.length,
      });
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await server.stop();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('streams file-backed transfers when the configured chunk-bytes value is smaller than the encrypted data-key envelope', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES = '8';
    // Keep the in-memory max-bytes cap tiny to ensure we do not rely on whole-buffer paths.
    process.env.HAPPIER_FILES_READ_MAX_BYTES = '8';

    const {
      createDirectPeerTransferRegistry,
      requestDirectPeerTransferToFile,
      startDirectPeerTransferServer,
    } = await import('./directPeerTransport');
    const { createTransferManifestHash } = await import('./transferChunkEncryption');

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-tiny-chunks-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    let registry: ReturnType<typeof createDirectPeerTransferRegistry> | null = null;
    const server = await startDirectPeerTransferServer({
      readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
    });
    registry = createDirectPeerTransferRegistry({
      advertisedPort: server.port,
      now: () => 2_600,
    });

    try {
      const payload = Buffer.from('payload-from-live-server-tiny-chunks', 'utf8');
      const sourcePath = join(tempDir, 'payload-source.bin');
      await writeFile(sourcePath, payload);
      const { createFileTransferPayloadSource } = await import('./transferPayloadSource');
      const published = registry.publishTransfer({
        transferId: 'transfer_to_file_tiny_chunks',
        payloadSource: createFileTransferPayloadSource({ filePath: sourcePath }),
      });

      const received = await requestDirectPeerTransferToFile({
        transferId: 'transfer_to_file_tiny_chunks',
        endpointCandidates: published.endpointCandidates,
        destinationPath,
        now: () => 2_600,
      });

      expect(received).toEqual({
        destinationPath,
        manifestHash: createTransferManifestHash(payload),
        sizeBytes: payload.length,
      });
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await server.stop();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed before decrypting when a file-backed direct peer transfer chunk response exceeds the configured per-chunk envelope bound', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES = '8';

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/open')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_oversized_chunk',
          manifestHash: 'sha256:ignored',
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/chunks/0')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_oversized_chunk',
          kind: 'chunk',
          sequence: 0,
          // Deliberately oversized (valid base64 characters, but not a valid encrypted payload).
          payloadBase64: 'A'.repeat(80),
          encryptedDataKeyEnvelopeBase64: 'A'.repeat(80),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-oversized-chunk-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await expect(requestDirectPeerTransferToFile({
        transferId: 'transfer_oversized_chunk',
        endpointCandidates: [
          {
            kind: 'http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_oversized_chunk',
            authorizationToken: 'test-token',
            expiresAt: 10_000,
          },
        ],
        destinationPath,
        fetchFn: fetchFn as typeof fetch,
        now: () => 5_000,
      })).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('caches expensive /open metadata resolution across repeated opens for the same transfer token', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const payloadSourceModule = await import('./transferPayloadSource');
    const { createDirectPeerTransferApp, createDirectPeerTransferRegistry } = await import('./directPeerTransport');
    const { createFileTransferPayloadSource } = payloadSourceModule;
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const resolveSizeSpy = vi.spyOn(payloadSourceModule, 'resolveTransferPayloadSizeBytes');
    const resolveHashSpy = vi.spyOn(payloadSourceModule, 'resolveTransferPayloadManifestHash');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46003,
      now: () => 7_000,
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-open-cache-'));
    const tempPath = join(tempDir, 'payload.bin');
    await writeFile(tempPath, Buffer.alloc(64, 7));

    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

    const published = registry.publishTransfer({
      transferId: 'transfer_open_cache',
      payloadSource: createFileTransferPayloadSource({ filePath: tempPath }),
    });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: registry.readPublishedTransfer,
    });

    try {
      await app.ready();
      resolveSizeSpy.mockClear();
      resolveHashSpy.mockClear();

      const first = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/transfer_open_cache/open',
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/transfer_open_cache/open',
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(second.statusCode).toBe(200);

      expect(resolveSizeSpy).toHaveBeenCalledTimes(1);
      expect(resolveHashSpy).toHaveBeenCalledTimes(1);
    } finally {
      resolveSizeSpy.mockRestore();
      resolveHashSpy.mockRestore();
      await app.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('publishes advertised http candidates for loading', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    // Keep this test stable even if the default TTL changes for long-running transfers.
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_TTL_MS = '30000';

    const {
      createDirectPeerTransferRegistry,
      requestDirectPeerTransferToFile,
      startDirectPeerTransferServer,
    } = await import('./directPeerTransport');

    let registry: ReturnType<typeof createDirectPeerTransferRegistry> | null = null;
    const server = await startDirectPeerTransferServer({
      readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
    });
    registry = createDirectPeerTransferRegistry({
      advertisedPort: server.port,
      now: () => 3_000,
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-advertised-http-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      const payload = Buffer.from('payload-from-http-fallback', 'utf8');
      const published = registry.publishTransfer({
        transferId: 'transfer_3',
        payload,
      });

      expect(published.endpointCandidates).toEqual([
        {
          kind: 'http',
          url: `http://127.0.0.1:${server.port}/machine-transfers/direct/${Buffer.from('transfer_3', 'utf8').toString('base64url')}`,
          authorizationToken: published.transferToken,
          expiresAt: 33_000,
        },
      ]);

      await requestDirectPeerTransferToFile({
        transferId: 'transfer_3',
        endpointCandidates: published.endpointCandidates,
        now: () => 3_000,
        destinationPath,
      });

      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await server.stop();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('keeps published transfers available beyond 30s by default (handoff-sized transfers)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const {
      createDirectPeerTransferRegistry,
      requestDirectPeerTransferToFile,
      startDirectPeerTransferServer,
    } = await import('./directPeerTransport');

    let nowMs = 0;
    let registry: ReturnType<typeof createDirectPeerTransferRegistry> | null = null;
    const server = await startDirectPeerTransferServer({
      readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
    });
    registry = createDirectPeerTransferRegistry({
      advertisedPort: server.port,
      now: () => nowMs,
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-ttl-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      const payload = Buffer.from('payload-after-30s', 'utf8');
      const published = registry.publishTransfer({
        transferId: 'transfer_ttl_default',
        payload,
      });

      nowMs = 35_000;
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_ttl_default',
        endpointCandidates: published.endpointCandidates,
        now: () => nowMs,
        destinationPath,
      });

      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await server.stop();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('moves the direct-peer auth token from the candidate authorization field into an authorization header on fetch', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-auth-header-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');
    const payload = Buffer.from('payload-via-header', 'utf8');
    let recipientPublicKeyBase64 = '';
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers).toMatchObject({
        authorization: 'Bearer test-token',
        'x-happier-transfer-recipient-public-key': expect.any(String),
      });
      if (String(input).endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_4',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      expect(String(input)).toBe('http://127.0.0.1:46001/machine-transfers/direct/transfer_4/chunks/0');
      return new Response(JSON.stringify({
        transferId: 'transfer_4',
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: 'transfer_4',
          sequence: 0,
          payload,
          recipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(9),
        }),
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    };

    await requestDirectPeerTransferToFile({
      transferId: 'transfer_4',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_4',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        },
      ],
      fetchFn: fetchFn as typeof fetch,
      now: () => 5_000,
      destinationPath,
    });

    await expect(readFile(destinationPath)).resolves.toEqual(payload);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('still accepts legacy query-token candidates during the migration', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-legacy-token-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');
    const payload = Buffer.from('payload-via-legacy-token', 'utf8');
    let recipientPublicKeyBase64 = '';
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers).toMatchObject({
        authorization: 'Bearer legacy-token',
        'x-happier-transfer-recipient-public-key': expect.any(String),
      });
      if (String(input).endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_legacy',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      expect(String(input)).toBe('http://127.0.0.1:46001/machine-transfers/direct/transfer_legacy/chunks/0');
      return new Response(JSON.stringify({
        transferId: 'transfer_legacy',
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: 'transfer_legacy',
          sequence: 0,
          payload,
          recipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(11),
        }),
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    };

    await requestDirectPeerTransferToFile({
      transferId: 'transfer_legacy',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_legacy',
          authorizationToken: 'legacy-token',
          expiresAt: 10_000,
        },
      ],
      fetchFn: fetchFn as typeof fetch,
      now: () => 5_000,
      destinationPath,
    });

    await expect(readFile(destinationPath)).resolves.toEqual(payload);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('tolerates small endpoint expiry clock skew when selecting direct-peer candidates', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_EXPIRY_SKEW_MS = '2000';

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-expiry-skew-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');
    const payload = Buffer.from('payload-via-expired-candidate', 'utf8');
    let recipientPublicKeyBase64 = '';
    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      if (url.endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_clock_skew',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/chunks/0')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_clock_skew',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_clock_skew',
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(3),
          }),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    await requestDirectPeerTransferToFile({
      transferId: 'transfer_clock_skew',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_clock_skew',
          authorizationToken: 'test-token',
          // Slightly "expired" relative to the requester clock, but within the configured skew.
          expiresAt: 9_000,
        },
      ],
      fetchFn,
      now: () => 10_000,
      destinationPath,
    });

    await expect(readFile(destinationPath)).resolves.toEqual(payload);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('fails closed before decrypting when a peer returns an oversized chunk envelope for a direct-peer transfer request', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES = '8';

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-chunk-oversized-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const fetchFn = async (input: string | URL | Request) => {
      if (String(input).endsWith('/open')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_chunk_oversized',
          manifestHash: 'sha256:ignored',
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        transferId: 'transfer_chunk_oversized',
        kind: 'chunk',
        sequence: 0,
        payloadBase64: 'A'.repeat(128),
        encryptedDataKeyEnvelopeBase64: 'AA==',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await expect(requestDirectPeerTransferToFile({
      transferId: 'transfer_chunk_oversized',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_chunk_oversized',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        },
      ],
      fetchFn: fetchFn as typeof fetch,
      now: () => 5_000,
      destinationPath,
    })).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');

    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('fails closed before decrypting when a peer returns an oversized data-key envelope for a direct-peer transfer request', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES = '8';

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-key-envelope-oversized-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const fetchFn = async (input: string | URL | Request) => {
      if (String(input).endsWith('/open')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_key_envelope_oversized',
          manifestHash: 'sha256:ignored',
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        transferId: 'transfer_key_envelope_oversized',
        kind: 'chunk',
        sequence: 0,
        payloadBase64: 'AA==',
        // Intentionally oversized relative to the in-memory budget. This must be rejected before
        // we attempt any base64 decode/decrypt work.
        encryptedDataKeyEnvelopeBase64: 'A'.repeat(2048),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await expect(requestDirectPeerTransferToFile({
      transferId: 'transfer_key_envelope_oversized',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_key_envelope_oversized',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        },
      ],
      fetchFn: fetchFn as typeof fetch,
      now: () => 5_000,
      destinationPath,
    })).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });
});
