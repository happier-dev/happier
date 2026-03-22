import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionHandoffTransferredBundles } from '../../session/handoff/transfer/sessionHandoffTransferredBundles';

describe('direct peer machine transfer', () => {
  afterEach(() => {
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS;
    delete process.env.HAPPIER_FILES_READ_MAX_BYTES;
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
      requestDirectPeerTransferPayload,
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

    try {
      const payload = Buffer.from('payload-from-live-server', 'utf8');
      const published = registry.publishTransfer({
        transferId: 'transfer_2',
        payload,
      });

      const loaded = await requestDirectPeerTransferPayload({
        transferId: 'transfer_2',
        endpointCandidates: published.endpointCandidates,
        now: () => 2_000,
      });

      expect(loaded.equals(payload)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('fails closed when the transfer payload exceeds the in-memory max-bytes limit', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';
    process.env.HAPPIER_FILES_READ_MAX_BYTES = '8';

    const {
      createDirectPeerTransferRegistry,
      requestDirectPeerTransferPayload,
      startDirectPeerTransferServer,
    } = await import('./directPeerTransport');

    let registry: ReturnType<typeof createDirectPeerTransferRegistry> | null = null;
    const server = await startDirectPeerTransferServer({
      readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
    });
    registry = createDirectPeerTransferRegistry({
      advertisedPort: server.port,
      now: () => 2_100,
    });

    try {
      const payload = Buffer.from('payload-too-large', 'utf8'); // > 8 bytes
      const published = registry.publishTransfer({
        transferId: 'transfer_oversized',
        payload,
      });

      await expect(requestDirectPeerTransferPayload({
        transferId: 'transfer_oversized',
        endpointCandidates: published.endpointCandidates,
        now: () => 2_100,
      })).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');
    } finally {
      await server.stop();
    }
  });

  it('fetches a live published payload directly into a destination file with verified manifest metadata', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

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
      const payload = Buffer.from('payload-from-live-server-file', 'utf8');
      const published = registry.publishTransfer({
        transferId: 'transfer_to_file',
        payload,
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

  it('publishes advertised http candidates for loading', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const {
      createDirectPeerTransferRegistry,
      requestDirectPeerTransferPayload,
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

      const loaded = await requestDirectPeerTransferPayload({
        transferId: 'transfer_3',
        endpointCandidates: published.endpointCandidates,
        now: () => 3_000,
      });

      expect(loaded.equals(payload)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('moves the direct-peer auth token from the candidate authorization field into an authorization header on fetch', async () => {
    const { requestDirectPeerTransferPayload } = await import('./directPeerTransport');
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

    const loaded = await requestDirectPeerTransferPayload({
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
    });

    expect(loaded.equals(payload)).toBe(true);
  });

  it('still accepts legacy query-token candidates during the migration', async () => {
    const { requestDirectPeerTransferPayload } = await import('./directPeerTransport');
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

    const loaded = await requestDirectPeerTransferPayload({
      transferId: 'transfer_legacy',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_legacy?token=legacy-token',
          expiresAt: 10_000,
        },
      ],
      fetchFn: fetchFn as typeof fetch,
      now: () => 5_000,
    });

    expect(loaded.equals(payload)).toBe(true);
  });

  it('roundtrips a handoff transferred-bundles payload through the typed direct-peer carrier', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const {
      createTypedDirectPeerTransferRegistry,
      requestTypedDirectPeerTransferPayload,
      startTypedDirectPeerTransferServer,
    } = await import('./directPeerTransport');
    const {
      createSessionHandoffTransferredBundlesCodec,
    } = await import('../../session/handoff/transfer/sessionHandoffTransferredBundles');

    const codec = createSessionHandoffTransferredBundlesCodec({
      mapDecodeError: ({ transferId }) => new Error(`Invalid direct peer transfer response for ${transferId}`),
    });

    let registry: ReturnType<typeof createTypedDirectPeerTransferRegistry<SessionHandoffTransferredBundles>> | null = null;
    const server = await startTypedDirectPeerTransferServer({
      codec,
      readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
    });
    registry = createTypedDirectPeerTransferRegistry({
      advertisedPort: server.port,
      codec,
      now: () => 4_000,
    });

    try {
      const published = registry.publishTransfer({
        transferId: 'handoff_live_typed_roundtrip',
        payload: {},
      });

      const loaded = await requestTypedDirectPeerTransferPayload({
        transferId: 'handoff_live_typed_roundtrip',
        endpointCandidates: published.endpointCandidates,
        codec,
        now: () => 4_000,
      });

      expect(loaded).toEqual({});
    } finally {
      await server.stop();
    }
  });

  it('rejects legacy json handoff transferred-bundle payloads through the typed direct-peer carrier', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const {
      createDirectPeerTransferRegistry,
      requestTypedDirectPeerTransferPayload,
      startDirectPeerTransferServer,
    } = await import('./directPeerTransport');
    const {
      createSessionHandoffTransferredBundlesCodec,
    } = await import('../../session/handoff/transfer/sessionHandoffTransferredBundles');

    const codec = createSessionHandoffTransferredBundlesCodec({
      mapDecodeError: ({ transferId }) => new Error(`Invalid direct peer transfer response for ${transferId}`),
    });

    let registry: ReturnType<typeof createDirectPeerTransferRegistry> | null = null;
    const server = await startDirectPeerTransferServer({
      readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
    });
    registry = createDirectPeerTransferRegistry({
      advertisedPort: server.port,
      now: () => 4_500,
    });

    try {
      const published = registry.publishTransfer({
        transferId: 'handoff_legacy_json',
        payload: Buffer.from(JSON.stringify({
          providerBundle: {
            providerId: 'claude',
            remoteSessionId: 'session_123',
            transcriptBase64: 'e30K',
          },
        }), 'utf8'),
      });

      await expect(requestTypedDirectPeerTransferPayload({
        transferId: 'handoff_legacy_json',
        endpointCandidates: published.endpointCandidates,
        codec,
        now: () => 4_500,
      })).rejects.toThrow('Invalid direct peer transfer response for handoff_legacy_json');
    } finally {
      await server.stop();
    }
  });
});
