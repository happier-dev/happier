import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function encodeDirectPeerTransferPathKey(transferId: string): string {
  return Buffer.from(transferId, 'utf8').toString('base64url');
}

function buildDirectPeerOpenUrl(transferId: string): string {
  return `/machine-transfers/direct/${encodeDirectPeerTransferPathKey(transferId)}/open`;
}

function buildDirectPeerChunkUrl(transferId: string, sequence: number): string {
  return `/machine-transfers/direct/${encodeDirectPeerTransferPathKey(transferId)}/chunks/${sequence}`;
}

async function reserveFreeTcpPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string' || address.port <= 0) {
        server.close(() => reject(new Error('Failed to reserve a free TCP port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

describe('direct peer machine transfer', () => {
  afterEach(() => {
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_TTL_MS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_EXPIRY_SKEW_MS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_OPEN_BODY_MAX_BYTES;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_MAX_TOTAL_CHUNKS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_MAX_ENTRIES;
    delete process.env.HAPPIER_FILES_READ_MAX_BYTES;
  });

  it('rejects publish when the published transfer registry max-entries cap is exceeded', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_MAX_ENTRIES = '1';

    const { createDirectPeerTransferRegistry } = await import('./directPeerTransport');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46001,
      now: () => 1_000,
    });

    registry.publishTransfer({
      transferId: 'transfer_registry_cap_1',
      payload: Buffer.from('{}', 'utf8'),
    });

    expect(() => registry.publishTransfer({
      transferId: 'transfer_registry_cap_2',
      payload: Buffer.from('{}', 'utf8'),
    })).toThrow('Direct peer published transfer registry is full');
  });

  it('prunes expired published transfers on publish so max-entries caps do not stall after TTL', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_MAX_ENTRIES = '1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_TTL_MS = '1';

    const { createDirectPeerTransferRegistry } = await import('./directPeerTransport');

    let nowMs = 1_000;
    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46001,
      now: () => nowMs,
    });

    registry.publishTransfer({
      transferId: 'transfer_registry_prune_1',
      payload: Buffer.from('{}', 'utf8'),
    });

    nowMs += 10;

    expect(() => registry.publishTransfer({
      transferId: 'transfer_registry_prune_2',
      payload: Buffer.from('{}', 'utf8'),
    })).not.toThrow();
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
        url: buildDirectPeerOpenUrl('transfer_chunk_bytes_clamped'),
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
      expect(open.json().totalChunks).toBe(3);
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
        url: buildDirectPeerOpenUrl('transfer_1'),
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
        url: buildDirectPeerChunkUrl('transfer_1', 0),
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
        url: buildDirectPeerOpenUrl('transfer_1'),
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

  it('fails closed when a transfer token is supplied only via query params (no query-token auth)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const { createDirectPeerTransferApp, createDirectPeerTransferRegistry } = await import('./directPeerTransport');
    const { createFileTransferPayloadSource } = await import('./transferPayloadSource');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46005,
      now: () => 1_000,
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-query-token-'));
    const tempPath = join(tempDir, 'payload.bin');
    await writeFile(tempPath, Buffer.from('direct-peer-query-token-payload', 'utf8'));

    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

    const published = registry.publishTransfer({
      transferId: 'transfer_query_token',
      payloadSource: createFileTransferPayloadSource({ filePath: tempPath }),
    });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: registry.readPublishedTransfer,
    });

    try {
      await app.ready();

      const open = await app.inject({
        method: 'POST',
        url: `/machine-transfers/direct/transfer_query_token/open?token=${published.transferToken}`,
        headers: {
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(open.statusCode).toBe(404);
      expect(open.json()).toEqual({ ok: false, error: 'Direct peer transfer not available' });

      const chunk = await app.inject({
        method: 'GET',
        url: `/machine-transfers/direct/transfer_query_token/chunks/0?token=${published.transferToken}`,
        headers: {
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(chunk.statusCode).toBe(404);
      expect(chunk.json()).toEqual({ ok: false, error: 'Direct peer transfer not available' });
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the direct-peer transfer path key is not base64url encoded (no legacy raw transferId in URL)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const { createDirectPeerTransferApp, createDirectPeerTransferRegistry } = await import('./directPeerTransport');
    const { createFileTransferPayloadSource } = await import('./transferPayloadSource');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46005,
      now: () => 1_000,
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-raw-path-key-'));
    const tempPath = join(tempDir, 'payload.bin');
    await writeFile(tempPath, Buffer.from('direct-peer-raw-path-key-payload', 'utf8'));

    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

    const published = registry.publishTransfer({
      transferId: 'transfer_raw_key',
      payloadSource: createFileTransferPayloadSource({ filePath: tempPath }),
    });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: registry.readPublishedTransfer,
    });

    try {
      await app.ready();

      const rawOpen = await app.inject({
        method: 'POST',
        url: `/machine-transfers/direct/transfer_raw_key/open`,
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(rawOpen.statusCode).toBe(404);
      expect(rawOpen.json()).toEqual({ ok: false, error: 'Direct peer transfer not available' });

      const encodedTransferKey = Buffer.from('transfer_raw_key', 'utf8').toString('base64url');
      const encodedOpen = await app.inject({
        method: 'POST',
        url: `/machine-transfers/direct/${encodedTransferKey}/open`,
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(encodedOpen.statusCode).toBe(200);
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reuses an open file handle across chunk requests for large file-backed transfers (avoids per-chunk open/close)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES = '64';

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

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-file-handle-cache-'));
    const tempPath = join(tempDir, 'payload.bin');
    await writeFile(tempPath, Buffer.from('x'.repeat(256), 'utf8'));

    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

    const published = registry.publishTransfer({
      transferId: 'transfer_file_handle_cache',
      payloadSource: createFileTransferPayloadSource({ filePath: tempPath }),
    });

    const app = createDirectPeerTransferApp({
      readPublishedTransfer: registry.readPublishedTransfer,
    });

    try {
      await app.ready();

      const open = await app.inject({
        method: 'POST',
        url: buildDirectPeerOpenUrl('transfer_file_handle_cache'),
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(open.statusCode).toBe(200);
      expect(open.json().totalChunks).toBeGreaterThan(1);

      const chunk0 = await app.inject({
        method: 'GET',
        url: buildDirectPeerChunkUrl('transfer_file_handle_cache', 0),
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(chunk0.statusCode).toBe(200);

      // If we keep a single FileHandle open per active transfer, we can still serve subsequent chunks
      // even if the backing temp file has been unlinked (common for temp-file backed transfers).
      //
      // If we open/close for each chunk, the follow-up read will fail once the file is removed.
      await rm(tempPath, { force: true });

      const chunk1 = await app.inject({
        method: 'GET',
        url: buildDirectPeerChunkUrl('transfer_file_handle_cache', 1),
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(chunk1.statusCode).toBe(200);
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

  it('honors caller-supplied timeoutMs for both open and chunk direct-peer fetches', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-timeout-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const payload = Buffer.from('payload-from-timeout-override', 'utf8');
    const timeoutSignals: AbortSignal[] = [];
    const fetchSignals: Array<AbortSignal | null | undefined> = [];
    let recipientPublicKeyBase64 = '';
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((_timeoutMs) => {
      const controller = new AbortController();
      timeoutSignals.push(controller.signal);
      return controller.signal;
    });
    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchSignals.push(init?.signal);

      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers).toMatchObject({
        authorization: 'Bearer timeout-token',
        'x-happier-transfer-recipient-public-key': expect.any(String),
      });

      if (url.endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_timeout_override',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/chunks/0')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_timeout_override',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_timeout_override',
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(4),
          }),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const requestParams: Parameters<typeof requestDirectPeerTransferToFile>[0] & { timeoutMs: number } = {
      transferId: 'transfer_timeout_override',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_timeout_override',
          authorizationToken: 'timeout-token',
          expiresAt: 10_000,
        },
      ],
      destinationPath,
      fetchFn,
      now: () => 5_000,
      timeoutMs: 12_345,
    };

    try {
      await requestDirectPeerTransferToFile(requestParams);

      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      expect(timeoutSpy.mock.calls).toEqual([[12_345], [12_345]]);
      expect(fetchSignals).toEqual(timeoutSignals);
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      timeoutSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('skips endpoint candidates that are not direct-peer endpoints (no outbound fetch for non-matching paths)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-ssrf-skip-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const payload = Buffer.from('payload-from-good-candidate', 'utf8');
    let recipientPublicKeyBase64 = '';
    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('bad.example')) {
        throw new Error(`Unexpected fetch to non-direct-peer endpoint: ${url}`);
      }

      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers).toMatchObject({
        authorization: 'Bearer test-token',
        'x-happier-transfer-recipient-public-key': expect.any(String),
      });

      if (url.endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_ssrf_skip',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      expect(url).toBe('http://good.example/machine-transfers/direct/transfer_ssrf_skip/chunks/0');
      return new Response(JSON.stringify({
        transferId: 'transfer_ssrf_skip',
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: 'transfer_ssrf_skip',
          sequence: 0,
          payload,
          recipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(9),
        }),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await requestDirectPeerTransferToFile({
      transferId: 'transfer_ssrf_skip',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://bad.example/not-a-direct-peer-endpoint',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        },
        {
          kind: 'http',
          url: 'http://good.example/machine-transfers/direct/transfer_ssrf_skip',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        },
      ],
      fetchFn,
      now: () => 5_000,
      destinationPath,
    });

    const calledUrls = (fetchFn as any).mock.calls.map((call: any[]) => String(call[0]));
    expect(calledUrls.some((url: string) => url.includes('bad.example'))).toBe(false);
    await expect(readFile(destinationPath)).resolves.toEqual(payload);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
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
        url: buildDirectPeerOpenUrl('transfer_open_body_limit'),
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

  it('fails closed without hashing when a direct-peer request omits the auth token (does not call published/on-demand resolvers)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const {
      createDirectPeerTransferApp,
    } = await import('./directPeerTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

    const readPublishedTransfer = vi.fn(() => {
      throw new Error('readPublishedTransfer must not be called without a token');
    });
    const resolveOnDemandTransfer = vi.fn(async () => {
      throw new Error('resolveOnDemandTransfer must not be called without a token');
    });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer,
      resolveOnDemandTransfer,
    });

    try {
      await app.ready();
      const open = await app.inject({
        method: 'POST',
        url: buildDirectPeerOpenUrl('transfer_missing_token'),
        headers: {
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(open.statusCode).toBe(404);
      expect(readPublishedTransfer).not.toHaveBeenCalled();
      expect(resolveOnDemandTransfer).not.toHaveBeenCalled();

      const chunk = await app.inject({
        method: 'GET',
        url: buildDirectPeerChunkUrl('transfer_missing_token', 0),
        headers: {
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(chunk.statusCode).toBe(404);
      expect(readPublishedTransfer).not.toHaveBeenCalled();
      expect(resolveOnDemandTransfer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('fails closed without hashing when a direct-peer request uses an oversized auth token (does not call published/on-demand resolvers)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const {
      createDirectPeerTransferApp,
    } = await import('./directPeerTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

    const readPublishedTransfer = vi.fn(() => {
      throw new Error('readPublishedTransfer must not be called for oversized tokens');
    });
    const resolveOnDemandTransfer = vi.fn(async () => {
      throw new Error('resolveOnDemandTransfer must not be called for oversized tokens');
    });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer,
      resolveOnDemandTransfer,
    });
    const oversizedToken = 'a'.repeat(10_000);

    try {
      await app.ready();
      const open = await app.inject({
        method: 'POST',
        url: buildDirectPeerOpenUrl('transfer_oversized_token'),
        headers: {
          authorization: `Bearer ${oversizedToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(open.statusCode).toBe(401);
      expect(readPublishedTransfer).not.toHaveBeenCalled();
      expect(resolveOnDemandTransfer).not.toHaveBeenCalled();

      const chunk = await app.inject({
        method: 'GET',
        url: buildDirectPeerChunkUrl('transfer_oversized_token', 0),
        headers: {
          authorization: `Bearer ${oversizedToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(chunk.statusCode).toBe(401);
      expect(readPublishedTransfer).not.toHaveBeenCalled();
      expect(resolveOnDemandTransfer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('fails closed before resolving on-demand transfers when the recipient public key is invalid (avoids wasted work)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const {
      createDirectPeerTransferApp,
    } = await import('./directPeerTransport');

    const readPublishedTransfer = vi.fn(() => null);
    const resolveOnDemandTransfer = vi.fn(async () => {
      throw new Error('resolveOnDemandTransfer must not be called when the recipient key is invalid');
    });

    const app = createDirectPeerTransferApp({
      readPublishedTransfer,
      resolveOnDemandTransfer,
    });

    try {
      await app.ready();
      const open = await app.inject({
        method: 'POST',
        url: buildDirectPeerOpenUrl('transfer_invalid_recipient_key'),
        headers: {
          authorization: 'Bearer test-token',
          // Base64-decodes to far more than a Curve25519 public key; should fail before any on-demand resolution.
          'x-happier-transfer-recipient-public-key': 'A'.repeat(2048),
        },
      });
      expect(open.statusCode).toBe(400);
      expect(resolveOnDemandTransfer).not.toHaveBeenCalled();
      expect(readPublishedTransfer).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not extend direct-peer transfer TTL via expiry skew (skew is requester-only)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_TTL_MS = '10';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_EXPIRY_SKEW_MS = '1000';

    const { createDirectPeerTransferRegistry } = await import('./directPeerTransport');

    let nowMs = 1_000;
    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46001,
      now: () => nowMs,
    });

    const published = registry.publishTransfer({
      transferId: 'transfer_expiry_skew_ttl',
      payload: Buffer.from('payload', 'utf8'),
    });

    // Advance to just after expiry, but still within skew.
    nowMs = 1_011;

    expect(registry.readPublishedTransfer({
      transferId: 'transfer_expiry_skew_ttl',
      transferToken: published.transferToken,
    })).toBeNull();
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

  it('does not accumulate streamed JSON chunks in memory when a peer lies about content-length (bounded growing buffer)', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-json-lie-len-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const payload = Buffer.from('payload-with-content-length-lie', 'utf8');
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
          transferId: 'transfer_json_lie_len',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        };
        return new Response(streamJson(openBody, 1), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            // Intentionally lie (too small) to force the mismatch branch.
            'content-length': '1',
          },
        });
      }
      if (url.endsWith('/chunks/0')) {
        const chunkBody = {
          transferId: 'transfer_json_lie_len',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_json_lie_len',
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(9),
          }),
        };
        return new Response(streamJson(chunkBody, 1), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            // Intentionally lie (too small) to force the mismatch branch.
            'content-length': '1',
          },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const originalPush = Array.prototype.push;
    Array.prototype.push = function (...args: unknown[]) {
      const stack = new Error().stack ?? '';
      if (stack.includes('readJsonResponseWithBodyLimit') && stack.includes('directPeerTransport.ts')) {
        throw new Error('readJsonResponseWithBodyLimit should not push streamed chunks when content-length is incorrect');
      }
      return originalPush.apply(this, args as any);
    };

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_json_lie_len',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_json_lie_len',
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

  it('does not accumulate streamed JSON chunks in memory when content-length is omitted (bounded growing buffer)', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-json-grow-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const payload = Buffer.from('payload-with-growing-json-read', 'utf8');
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
          transferId: 'transfer_grow_json',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        };
        return new Response(streamJson(openBody, 1), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      if (url.endsWith('/chunks/0')) {
        const chunkBody = {
          transferId: 'transfer_grow_json',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_grow_json',
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(9),
          }),
        };
        return new Response(streamJson(chunkBody, 1), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const originalPush = Array.prototype.push;
    Array.prototype.push = function (...args: unknown[]) {
      const stack = new Error().stack ?? '';
      if (stack.includes('readJsonResponseWithBodyLimit') && stack.includes('directPeerTransport.ts')) {
        throw new Error('readJsonResponseWithBodyLimit should not push streamed chunks when content-length is omitted');
      }
      return originalPush.apply(this, args as any);
    };

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_grow_json',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_grow_json',
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

    const originalObjectKeys = Object.keys;
    const originalStringify = JSON.stringify;
    Object.keys = ((value: object) => {
      if (value === openBody) {
        throw new Error('Object.keys should not be called for an oversized open body');
      }
      return originalObjectKeys(value);
    }) as typeof Object.keys;
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
      Object.keys = originalObjectKeys;
      JSON.stringify = originalStringify;
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('honors a larger direct-peer /open request body limit when configured (streams instead of failing pre-fetch)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_OPEN_BODY_MAX_BYTES = '1048576';

    const openBody = {
      payload: 'x'.repeat(80_000),
    };

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const fetchFn: typeof fetch = vi.fn(async () => {
      return new Response('fail', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-open-body-hard-clamp-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await expect(requestDirectPeerTransferToFile({
        transferId: 'transfer_open_body_hard_clamp',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://example.test/machine-transfers/direct/transfer_open_body_hard_clamp',
          authorizationToken: 'abc',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 1_000,
        destinationPath,
        openBody,
      })).rejects.toThrow('Direct peer request failed with status 500');

      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('hard-clamps the direct-peer /open request body limit to a bounded ceiling even when the env override is absurd', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_OPEN_BODY_MAX_BYTES = '999999999';

    const openBody = {
      payload: 'x'.repeat(1_100_000),
    };

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const fetchFn: typeof fetch = vi.fn(async () => {
      throw new Error('fetch should not be called');
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-open-body-hard-ceiling-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await expect(requestDirectPeerTransferToFile({
        transferId: 'transfer_open_body_hard_ceiling',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://example.test/machine-transfers/direct/transfer_open_body_hard_ceiling',
          authorizationToken: 'abc',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 1_000,
        destinationPath,
        openBody,
      })).rejects.toThrow('body-limit (1048576 bytes)');

      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed before fetch when openBody toJSON inflates beyond the configured body-limit (no large-buffer assembly)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_OPEN_BODY_MAX_BYTES = '1024';

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const fetchFn: typeof fetch = vi.fn(async () => {
      throw new Error('fetch should not be called');
    });

    let toJsonCalls = 0;
    const openBody = {
      toJSON() {
        toJsonCalls += 1;
        return {
          payload: 'x'.repeat(50_000),
        };
      },
    };

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-open-body-tojson-inflation-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await expect(requestDirectPeerTransferToFile({
        transferId: 'transfer_open_body_tojson_inflation',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://example.test/machine-transfers/direct/transfer_open_body_tojson_inflation',
          authorizationToken: 'abc',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 1_000,
        destinationPath,
        openBody,
      })).rejects.toThrow('Direct peer transfer open request body exceeds the configured body-limit');

      expect(fetchFn).not.toHaveBeenCalled();
      expect(toJsonCalls).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when a streamed openBody toJSON inflates beyond the configured body-limit', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_OPEN_BODY_MAX_BYTES = '20000';

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const openBody: Record<string, unknown> = {};
    for (let index = 0; index < 650; index += 1) {
      openBody[`k_${String(index).padStart(4, '0')}`] = 'v';
    }
    openBody.toJSON = () => ({
      payload: 'x'.repeat(50_000),
    });

    const readBodyBytes = async (body: unknown): Promise<number> => {
      if (body instanceof Uint8Array) {
        return body.byteLength;
      }
      if (body && typeof body === 'object' && 'getReader' in body && typeof (body as any).getReader === 'function') {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) total += value.byteLength;
        }
        return total;
      }
      return 0;
    };

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as Request).url ?? '');
      if (!url.endsWith('/open')) {
        throw new Error(`Unexpected fetch URL: ${url}`);
      }
      await readBodyBytes(init?.body);
      return new Response('fail', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-open-body-tojson-stream-limit-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await expect(requestDirectPeerTransferToFile({
        transferId: 'transfer_open_body_tojson_stream_limit',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_open_body_tojson_stream_limit',
          authorizationToken: 'abc',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 1_000,
        destinationPath,
        openBody,
      })).rejects.toThrow('Direct peer transfer open request body exceeds the configured body-limit');

      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('sends direct-peer /open request bodies as bytes rather than re-encoding a JSON string for fetch', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const openBody = {
      payload: 'payload-from-bytes-open-body',
    };
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-open-body-bytes-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    let capturedOpenBody: unknown = null;
    let recipientPublicKeyBase64 = '';
    const emptyManifestHash = createTransferManifestHash(Buffer.alloc(0));
    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as Request).url ?? '');
      if (url.endsWith('/open')) {
        capturedOpenBody = init?.body;
        const headers = init?.headers as Record<string, string> | undefined;
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_open_body_bytes',
          totalChunks: 1,
          manifestHash: emptyManifestHash,
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      if (url.endsWith('/chunks/0')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_open_body_bytes',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_open_body_bytes',
            sequence: 0,
            payload: Buffer.alloc(0),
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(1),
          }),
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      return new Response('not-found', { status: 404 });
    });

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_open_body_bytes',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://example.test/machine-transfers/direct/transfer_open_body_bytes',
          authorizationToken: 'abc',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 1_000,
        destinationPath,
        openBody,
      });

      expect(capturedOpenBody).toBeInstanceOf(Uint8Array);
      const openBodyText = Buffer.from(capturedOpenBody as Uint8Array).toString('utf8');
      expect(JSON.parse(openBodyText)).toEqual(openBody);
    } finally {
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
      networkInterfacesFn: () => ({}),
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

  it('does not call String.prototype.trim on large base64 chunk fields while fetching a direct-peer payload', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const payload = Buffer.from(new Uint8Array(2048).fill(7));
    let recipientPublicKeyBase64 = '';

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (String(input).endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_no_large_trim',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(input).endsWith('/chunks/0')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_no_large_trim',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_no_large_trim',
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(8),
          }),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${String(input)}`);
    });

    const originalTrim = String.prototype.trim;
    String.prototype.trim = function () {
      const value = String(this);
      const stack = new Error().stack ?? '';
      const callerLine = stack.split('\n')[2] ?? '';
      if (value.length > 1024 && callerLine.includes('directPeerTransport.ts')) {
        throw new Error('String.prototype.trim should not be used for large direct-peer chunk fields');
      }
      return originalTrim.call(this);
    };

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-no-large-trim-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_no_large_trim',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://127.0.0.1:46002/machine-transfers/direct/transfer_no_large_trim',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 5_000,
        destinationPath,
      });

      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      String.prototype.trim = originalTrim;
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('reuses the same recipient key pair across direct-peer candidate retries', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const payload = Buffer.from('payload-for-candidate-retry-key-reuse', 'utf8');
    const recipientPublicKeyBase64ByAttempt: string[] = [];
    let openBodySerializationCount = 0;
    const openBody = {
      t: 'direct_peer_retry_body',
      toJSON() {
        openBodySerializationCount += 1;
        return { hello: 'world' };
      },
    };

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const url = String(input);
      if (url.includes('/candidate-1/open')) {
        recipientPublicKeyBase64ByAttempt.push(headers?.['x-happier-transfer-recipient-public-key'] ?? '');
        return new Response('try next candidate', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        });
      }
      if (url.includes('/candidate-2/open')) {
        recipientPublicKeyBase64ByAttempt.push(headers?.['x-happier-transfer-recipient-public-key'] ?? '');
        return new Response(JSON.stringify({
          transferId: 'transfer_candidate_retry_key_reuse',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/candidate-2/chunks/0')) {
        const recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_candidate_retry_key_reuse',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_candidate_retry_key_reuse',
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
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-candidate-key-reuse-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_candidate_retry_key_reuse',
        endpointCandidates: [
          {
            kind: 'http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/candidate-1',
            authorizationToken: 'test-token',
            expiresAt: 10_000,
          },
          {
            kind: 'http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/candidate-2',
            authorizationToken: 'test-token',
            expiresAt: 10_000,
          },
        ],
        fetchFn,
        openBody,
        now: () => 5_000,
        destinationPath,
      });

      expect(recipientPublicKeyBase64ByAttempt).toHaveLength(2);
      expect(recipientPublicKeyBase64ByAttempt[0]).toBe(recipientPublicKeyBase64ByAttempt[1]);
      expect(openBodySerializationCount).toBe(1);
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when the direct-peer /open response is 200 but not application/json', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const transferId = 'transfer_open_non_json_content_type';
    const payload = Buffer.from('payload-for-open-non-json-content-type', 'utf8');
    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const url = String(input);
      if (url.endsWith(buildDirectPeerOpenUrl(transferId))) {
        return new Response(JSON.stringify({
          transferId,
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      if (url.endsWith(buildDirectPeerChunkUrl(transferId, 0))) {
        const recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId,
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId,
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(1),
          }),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-open-non-json-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');
    try {
      await expect(requestDirectPeerTransferToFile({
        transferId,
        endpointCandidates: [{
          kind: 'http',
          url: `http://127.0.0.1:46001/machine-transfers/direct/${encodeDirectPeerTransferPathKey(transferId)}`,
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 5_000,
        destinationPath,
      })).rejects.toThrow(`Invalid direct peer transfer response for ${transferId}`);
    } finally {
      await rm(tempDir, { recursive: true }).catch(() => undefined);
    }
  });

  it('fails closed when the direct-peer chunk response is 200 but not application/json', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const transferId = 'transfer_chunk_non_json_content_type';
    const payload = Buffer.from('payload-for-chunk-non-json-content-type', 'utf8');
    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const url = String(input);
      if (url.endsWith(buildDirectPeerOpenUrl(transferId))) {
        return new Response(JSON.stringify({
          transferId,
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith(buildDirectPeerChunkUrl(transferId, 0))) {
        const recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId,
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId,
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(2),
          }),
        }), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-chunk-non-json-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');
    try {
      await expect(requestDirectPeerTransferToFile({
        transferId,
        endpointCandidates: [{
          kind: 'http',
          url: `http://127.0.0.1:46001/machine-transfers/direct/${encodeDirectPeerTransferPathKey(transferId)}`,
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 5_000,
        destinationPath,
      })).rejects.toThrow(`Invalid direct peer transfer response for ${transferId}`);
    } finally {
      await rm(tempDir, { recursive: true }).catch(() => undefined);
    }
  });

  it('does not serialize an openBody when all direct-peer candidates are already expired', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    let openBodySerializationCount = 0;
    const openBody = {
      t: 'direct_peer_expired_body',
      toJSON() {
        openBodySerializationCount += 1;
        return { hello: 'expired' };
      },
    };

    const fetchFn: typeof fetch = vi.fn(async () => {
      throw new Error('fetch should not be called when every candidate is expired');
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-expired-candidate-open-body-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await expect(requestDirectPeerTransferToFile({
        transferId: 'transfer_expired_candidate_open_body',
        endpointCandidates: [
          {
            kind: 'http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_expired_candidate_open_body',
            authorizationToken: 'test-token',
            expiresAt: 1_000,
          },
        ],
        openBody,
        fetchFn,
        now: () => 5_000,
        destinationPath,
      })).rejects.toThrow('No reachable direct peer transfer candidate');

      expect(openBodySerializationCount).toBe(0);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('streams large direct-peer open bodies instead of materializing them into one request buffer', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const payload = Buffer.from('payload-for-streamed-open-body', 'utf8');
    const openBody = {
      t: 'direct_peer_streamed_open_body',
      packId: 'pack_streamed_open_body',
      digests: Array.from({ length: 128 }, (_, index) => `sha256:${String(index).padStart(64, '0')}`),
    };
    let recipientPublicKeyBase64 = '';
    const observedBodyKinds: string[] = [];

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const url = String(input);
      if (url.endsWith('/open')) {
        observedBodyKinds.push(Object.prototype.toString.call(init?.body));
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        const rawBody = await new Response(init?.body as never).text();
        expect(rawBody).toContain('"pack_streamed_open_body"');
        expect(rawBody).toContain('"sha256:');
        return new Response(JSON.stringify({
          transferId: 'transfer_streamed_open_body',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/chunks/0')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_streamed_open_body',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_streamed_open_body',
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(13),
          }),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const originalStringify = JSON.stringify;
    const stringifyCalls: unknown[] = [];
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      const stack = new Error().stack ?? '';
      const callerLine = stack.split('\n')[2] ?? '';
      if (callerLine.includes('directPeerTransport.ts')) {
        stringifyCalls.push(args[0]);
      }
      return originalStringify(...args);
    }) as typeof JSON.stringify;

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-streamed-open-body-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_streamed_open_body',
        endpointCandidates: [
          {
            kind: 'http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_streamed_open_body',
            authorizationToken: 'test-token',
            expiresAt: 10_000,
          },
        ],
        fetchFn,
        openBody,
        now: () => 5_000,
        destinationPath,
      });

      expect(observedBodyKinds).toEqual(['[object ReadableStream]']);
      expect(stringifyCalls).toHaveLength(0);
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      JSON.stringify = originalStringify;
      await rm(tempDir, { recursive: true }).catch(() => undefined);
    }
  });

  it('does not preallocate the entire chunk response body when content-length is large', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES = String(512 * 1024);

    const payload = Buffer.alloc(400 * 1024, 7);
    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    let recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');
    let chunkContentLength = 0;
    const fetchFn: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const url = String(input);
      if (url.endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? recipientPublicKeyBase64;
        return new Response(JSON.stringify({
          transferId: 'transfer_large_content_length',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/chunks/0')) {
        const chunkText = JSON.stringify({
          transferId: 'transfer_large_content_length',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_large_content_length',
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(5),
          }),
        });
        chunkContentLength = Buffer.byteLength(chunkText, 'utf8');
        return new Response(chunkText, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            // Large (but still within the protocol-derived max body bytes): the client must not
            // allocate a same-sized response buffer purely because a peer claimed this header.
            'content-length': String(chunkContentLength),
          },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const originalUint8Array = globalThis.Uint8Array;
    const helperAllocationArgs: Array<number> = [];
    const guardedUint8Array = new Proxy(originalUint8Array, {
      construct(target, args, newTarget) {
        const stack = new Error().stack ?? '';
        if (stack.includes('readJsonResponseWithBodyLimit') && stack.includes('directPeerTransport.ts')) {
          const first = args[0];
          if (typeof first === 'number') {
            helperAllocationArgs.push(first);
          }
        }
        return Reflect.construct(target, args, newTarget);
      },
    });

    Object.defineProperty(globalThis, 'Uint8Array', {
      configurable: true,
      writable: true,
      value: guardedUint8Array,
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-large-open-response-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_large_content_length',
        endpointCandidates: [
          {
            kind: 'http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_large_content_length',
            authorizationToken: 'test-token',
            expiresAt: 10_000,
          },
        ],
        fetchFn: fetchFn as typeof fetch,
        now: () => 5_000,
        destinationPath,
      });

      expect(chunkContentLength).toBeGreaterThan(0);
      // We should never preallocate a buffer exactly equal to an untrusted content-length for
      // large bodies; this is a memory spike footgun.
      expect(helperAllocationArgs).not.toContain(chunkContentLength);
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      Object.defineProperty(globalThis, 'Uint8Array', {
        configurable: true,
        writable: true,
        value: originalUint8Array,
      });
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
        url: buildDirectPeerOpenUrl('transfer_open_cache'),
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: buildDirectPeerOpenUrl('transfer_open_cache'),
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

  it('caches direct-peer bearer token hashing across repeated opens for the same transfer token', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    await vi.resetModules();
    const actualCrypto = await vi.importActual<typeof import('node:crypto')>('node:crypto');
    const createHashSpy = vi.fn(actualCrypto.createHash);

    vi.doMock('node:crypto', () => ({
      ...actualCrypto,
      createHash: createHashSpy,
    }));

    const { createDirectPeerTransferApp } = await import('./directPeerTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');
    const payloadSource = {
      kind: 'file' as const,
      filePath: '/virtual/direct-peer-cache.bin',
      sizeBytes: 5,
      manifestHash: 'sha256:'.padEnd(71, '1'),
    };

    const app = createDirectPeerTransferApp({
      readPublishedTransfer: ({ transferId, transferToken }) =>
        transferId === 'transfer_token_hash_cache' && transferToken === 'shared-token'
          ? payloadSource
          : null,
    });

    try {
      await app.ready();

      createHashSpy.mockClear();

      const first = await app.inject({
        method: 'POST',
        url: buildDirectPeerOpenUrl('transfer_token_hash_cache'),
        headers: {
          authorization: 'Bearer shared-token',
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: buildDirectPeerOpenUrl('transfer_token_hash_cache'),
        headers: {
          authorization: 'Bearer shared-token',
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(second.statusCode).toBe(200);

      expect(createHashSpy).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      vi.doUnmock('node:crypto');
      vi.resetModules();
    }
  });

  it('includes IPv6 hosts discovered from network interfaces when no explicit advertised-host override exists', async () => {
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS;

    const { createDirectPeerTransferRegistry } = await import('./directPeerTransport');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46006,
      now: () => 1_000,
      networkInterfacesFn: () => ({
        eth0: [
          { address: '10.0.0.2', family: 'IPv4', internal: false } as any,
          { address: '2001:db8::1', family: 'IPv6', internal: false } as any,
          // Zone-qualified addresses must not be advertised because they produce invalid URLs.
          { address: 'fe80::1%en0', family: 'IPv6', internal: false } as any,
        ],
      }),
    });

    const published = registry.publishTransfer({
      transferId: 'transfer_ipv6_advertise',
      payload: Buffer.from('hello', 'utf8'),
    });
    const urls = published.endpointCandidates.map((candidate) => candidate.url);

    expect(urls).toContain(`http://10.0.0.2:46006/machine-transfers/direct/${Buffer.from('transfer_ipv6_advertise', 'utf8').toString('base64url')}`);
    expect(urls).toContain(`http://[2001:db8::1]:46006/machine-transfers/direct/${Buffer.from('transfer_ipv6_advertise', 'utf8').toString('base64url')}`);
    expect(urls.some((url) => url.includes('%'))).toBe(false);
  });

  it('merges configured advertised hosts with discovered NIC addresses', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const { createDirectPeerTransferRegistry } = await import('./directPeerTransport');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46007,
      now: () => 1_000,
      networkInterfacesFn: () => ({
        eth0: [
          { address: '10.0.0.2', family: 'IPv4', internal: false } as any,
          { address: '2001:db8::1', family: 'IPv6', internal: false } as any,
          { address: 'fe80::1%en0', family: 'IPv6', internal: false } as any,
        ],
      }),
    });

    const published = registry.publishTransfer({
      transferId: 'transfer_configured_and_detected_advertise',
      payload: Buffer.from('hello', 'utf8'),
    });
    const urls = published.endpointCandidates.map((candidate) => candidate.url);
    const transferKey = Buffer.from('transfer_configured_and_detected_advertise', 'utf8').toString('base64url');

    expect(urls).toContain(`http://127.0.0.1:46007/machine-transfers/direct/${transferKey}`);
    expect(urls).toContain(`http://10.0.0.2:46007/machine-transfers/direct/${transferKey}`);
    expect(urls).toContain(`http://[2001:db8::1]:46007/machine-transfers/direct/${transferKey}`);
    expect(urls.some((url) => url.includes('%'))).toBe(false);
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
      networkInterfacesFn: () => ({}),
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

  it('honors HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT when starting the direct-peer server', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT = String(await reserveFreeTcpPort());

    const {
      createDirectPeerTransferRegistry,
      startDirectPeerTransferServer,
    } = await import('./directPeerTransport');

    let registry: ReturnType<typeof createDirectPeerTransferRegistry> | null = null;
    const server = await startDirectPeerTransferServer({
      readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
    });
    registry = createDirectPeerTransferRegistry({
      advertisedPort: server.port,
      now: () => 3_000,
      networkInterfacesFn: () => ({}),
    });

    try {
      const expectedPort = Number(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT);
      expect(server.port).toBe(expectedPort);

      const published = registry.publishTransfer({
        transferId: 'transfer_bind_port',
        payload: Buffer.from('payload-from-bind-port', 'utf8'),
      });

      expect(published.endpointCandidates).toEqual([
        {
          kind: 'http',
          url: `http://127.0.0.1:${expectedPort}/machine-transfers/direct/${Buffer.from('transfer_bind_port', 'utf8').toString('base64url')}`,
          authorizationToken: published.transferToken,
          expiresAt: 603_000,
        },
      ]);
    } finally {
      await server.stop();
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

  it('skips direct-peer endpoint candidates that include extra path segments (prevents auth token leakage to attacker-controlled URLs)', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-ssrf-segments-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const payload = Buffer.from('payload-from-good-candidate', 'utf8');
    let recipientPublicKeyBase64 = '';
    let fetchedBadEndpoint = false;
    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('bad.example')) {
        fetchedBadEndpoint = true;
        throw new Error(`Unexpected fetch to direct-peer candidate with extra path segments: ${url}`);
      }

      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers).toMatchObject({
        authorization: 'Bearer test-token',
        'x-happier-transfer-recipient-public-key': expect.any(String),
      });

      if (url.endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_ssrf_skip',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      expect(url).toBe('http://good.example/machine-transfers/direct/transfer_ssrf_skip/chunks/0');
      return new Response(JSON.stringify({
        transferId: 'transfer_ssrf_skip',
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: 'transfer_ssrf_skip',
          sequence: 0,
          payload,
          recipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(9),
        }),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await requestDirectPeerTransferToFile({
      transferId: 'transfer_ssrf_skip',
      endpointCandidates: [
        {
          kind: 'http',
          // Contains the direct-peer marker but is not a base transfer endpoint.
          url: 'http://bad.example/machine-transfers/direct/transfer_ssrf_skip/open',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        },
        {
          kind: 'http',
          url: 'http://good.example/machine-transfers/direct/transfer_ssrf_skip',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        },
      ],
      fetchFn,
      now: () => 1_000,
      destinationPath,
    });

    expect(fetchedBadEndpoint).toBe(false);
    await expect(readFile(destinationPath)).resolves.toEqual(payload);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('skips endpoint candidates with an oversized authorizationToken (does not send huge auth headers)', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-oversized-auth-token-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');

    const payload = Buffer.from('payload-via-oversized-auth-token-skip', 'utf8');
    let recipientPublicKeyBase64 = '';
    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('bad.example')) {
        throw new Error(`Unexpected fetch to candidate with oversized auth token: ${url}`);
      }

      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers).toMatchObject({
        authorization: 'Bearer ok-token',
        'x-happier-transfer-recipient-public-key': expect.any(String),
      });

      if (url.endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_oversized_auth_token_skip',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      expect(url).toBe('http://good.example/machine-transfers/direct/transfer_oversized_auth_token_skip/chunks/0');
      return new Response(JSON.stringify({
        transferId: 'transfer_oversized_auth_token_skip',
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: 'transfer_oversized_auth_token_skip',
          sequence: 0,
          payload,
          recipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(9),
        }),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_oversized_auth_token_skip',
        endpointCandidates: [
          {
            kind: 'http',
            url: 'http://bad.example/machine-transfers/direct/transfer_oversized_auth_token_skip',
            authorizationToken: 'x'.repeat(10_000),
            expiresAt: 10_000,
          },
          {
            kind: 'http',
            url: 'http://good.example/machine-transfers/direct/transfer_oversized_auth_token_skip',
            authorizationToken: 'ok-token',
            expiresAt: 10_000,
          },
        ],
        fetchFn,
        now: () => 1_000,
        destinationPath,
      });

      const calledUrls = (fetchFn as any).mock.calls.map((call: any[]) => String(call[0]));
      expect(calledUrls.some((url: string) => url.includes('bad.example'))).toBe(false);
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('accepts endpoint candidates with explicit authorizationToken (no query-token auth)', async () => {
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

  it('fails closed before parsing when a direct-peer /open response body exceeds the bounded JSON limit', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-open-response-overlimit-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/open')) {
        const openText = JSON.stringify({
          transferId: 'transfer_open_response_overlimit',
          manifestHash: `sha256:${'a'.repeat(16 * 1024)}`,
          totalChunks: 1,
        });
        return new Response(openText, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            // Ensure we reject before buffering/parsing.
            'content-length': String(openText.length),
          },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    await expect(requestDirectPeerTransferToFile({
      transferId: 'transfer_open_response_overlimit',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_open_response_overlimit',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        },
      ],
      fetchFn,
      now: () => 5_000,
      destinationPath,
    })).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');

    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('fails closed before requesting chunks when a peer returns an absurd totalChunks value', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_MAX_TOTAL_CHUNKS = '3';

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-open-too-many-chunks-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/open')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_open_too_many_chunks',
          manifestHash: 'sha256:ignored',
          totalChunks: 10,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    await expect(requestDirectPeerTransferToFile({
      transferId: 'transfer_open_too_many_chunks',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_open_too_many_chunks',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        },
      ],
      fetchFn,
      now: () => 5_000,
      destinationPath,
    })).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');

    expect(fetchFn).toHaveBeenCalledTimes(1);
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
