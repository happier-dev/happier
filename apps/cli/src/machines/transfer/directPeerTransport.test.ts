import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDirectPeerTransferApp, createDirectPeerTransferRegistry, requestDirectPeerTransferToFile, startDirectPeerTransferServer } from './directPeerTransport';
import { createDirectTransferServerLifecycle } from './directTransferServerLifecycle';
import { createDirectTransferImportSessionManager } from './directTransferImportSession';
import { resolveMachineTransferRuntimeConfig } from './transferRuntimeConfig';
import { createBufferTransferPayloadSource, createFileTransferPayloadSource } from './transferPayloadSource';

const fileOpenBoundary = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    fileOpenBoundary.observe(handle, args[0]);
    return handle;
  } };
});

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
  it.each(['default', 'explicit-zero'] as const)('keeps two daemon publications independently reachable with %s port allocation', async mode => {
    // Exercise real OS listeners and the daemon's config → lifecycle → advertised endpoint path.
    if (mode === 'explicit-zero') process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT = '0';
    else delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT;
    const { bindPort } = resolveMachineTransferRuntimeConfig().directPeer;
    const lifecycles = [0, 1].map(() => createDirectTransferServerLifecycle({ bindPort, listenerClasses: ['loopback_http'] }));
    const directory = await mkdtemp(join(tmpdir(), 'happier-daemon-port-isolation-'));
    try {
      const published = [];
      for (const [index, lifecycle] of lifecycles.entries()) {
        published.push(await lifecycle.publishTransferWhenReady({ transferId: `daemon-${index}`,
          payloadSource: createBufferTransferPayloadSource(Buffer.from(`payload-${index}`)) }));
      }
      const ports = lifecycles.map(lifecycle => lifecycle.getState().port!);
      expect(ports.every(port => port > 0)).toBe(true);
      expect(new Set(ports).size).toBe(2);
      for (const [index, publication] of published.entries()) {
        const endpoint = publication.endpointCandidates.find(candidate => candidate.kind === 'http');
        expect(endpoint).toBeDefined();
        expect(new URL(endpoint!.url).port).toBe(String(ports[index]));
        const destinationPath = join(directory, `payload-${index}`);
        await requestDirectPeerTransferToFile({ transferId: publication.transferId,
          endpointCandidates: publication.endpointCandidates, destinationPath });
        expect(await readFile(destinationPath)).toEqual(Buffer.from(`payload-${index}`));
        expect(lifecycles[index]!.getState().publishedTransferCount).toBe(1);
      }
    } finally {
      await Promise.all(lifecycles.map(lifecycle => lifecycle.stop()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['complete', 'clear', 'expiry', 'stop'] as const)('closes every cached publication handle before captured files are disposed on %s', async (ending) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-export-handle-custody-'));
    const sourcePath = join(directory, 'manifest.bin');
    const blobPath = join(directory, 'blob.bin');
    const bytes = Buffer.from([0, 255, 128, 10]);
    await Promise.all([writeFile(sourcePath, bytes), writeFile(blobPath, bytes)]);
    const handles: FileHandle[] = [];
    // Track real OS handles; all transfer/cache/lifecycle logic remains real.
    fileOpenBoundary.observe.mockImplementation((handle: FileHandle, path: unknown) => {
      if (path === sourcePath || path === blobPath) handles.push(handle);
    });
    let now = Date.now();
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: await reserveFreeTcpPort(), listenerClasses: ['loopback_http'], now: () => now });
    let disposed!: () => void;
    const disposal = new Promise<void>(resolve => { disposed = resolve; });
    let handlesAtDisposal: number[] | undefined;
    const payload = createBufferTransferPayloadSource(bytes);
    const scope = { rootPath: directory, requesterAccountId: 'account-one', destinationId: 'destination-one' };
    try {
      const published = await lifecycle.publishTransferWhenReady({ transferId: 'manifest', filesystemScope: scope,
        payloadSource: createFileTransferPayloadSource({ filePath: sourcePath, sizeBytes: bytes.length, manifestHash: payload.manifestHash,
          dispose: async () => { handlesAtDisposal = handles.map(handle => handle.fd); await rm(directory, { recursive: true, force: true }); disposed(); } }),
        onDemandScope: { allowTransferId: id => id === 'blob', resolvePayloadSourceOnOpen: async () =>
          createFileTransferPayloadSource({ filePath: blobPath, sizeBytes: bytes.length, manifestHash: payload.manifestHash }) } });
      const port = lifecycle.getState().port!;
      const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');
      const headers = { authorization: `Bearer ${published.transferToken}`,
        'x-happier-transfer-recipient-public-key': Buffer.from(deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(7))).toString('base64') };
      const origin = `http://127.0.0.1:${port}`;
      for (const id of ['manifest', 'blob']) {
        expect((await fetch(`${origin}${buildDirectPeerOpenUrl(id)}`, { method: 'POST', headers })).status).toBe(200);
        expect((await fetch(`${origin}${buildDirectPeerChunkUrl(id, 0)}`, { headers })).status).toBe(200);
      }
      expect(handles).toHaveLength(2);
      expect(handles.every(handle => handle.fd >= 0)).toBe(true);
      if (ending === 'complete') {
        const response = await fetch(`${origin}/machine-transfers/direct/${encodeDirectPeerTransferPathKey('manifest')}/complete`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ destinationId: scope.destinationId, success: true, sizeBytes: bytes.length, manifestHash: payload.manifestHash }) });
        expect(response.status).toBe(200);
      } else if (ending === 'clear') {
        expect(lifecycle.clearPublishedTransfer('manifest', scope)).toBe(true);
      } else if (ending === 'expiry') {
        now = published.expiresAt + 1;
        expect(lifecycle.getState().publishedTransferCount).toBe(0);
      } else await lifecycle.stop();
      await disposal;
      expect(handlesAtDisposal).toEqual([-1, -1]);
    } finally {
      await lifecycle.stop();
      fileOpenBoundary.observe.mockReset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps prepared tree payload imports in admitted private staging through the real listener adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-prepared-root-'));
    const staging = await mkdtemp(join(tmpdir(), 'happier-prepared-private-'));
    const server = await startDirectPeerTransferServer({ readPublishedTransfer: () => null, bindPort: await reserveFreeTcpPort(),
      accessPolicy: { kind: 'restrictedRoots', roots: [root] } });
    try {
      const bytes = Buffer.from([0, 255, 128, 10]);
      const path = join(staging, 'payload-0');
      const prepared = await server.openTrustedImportSession({ t: 'session_file_upload_v1', workingDirectory: staging,
        path, sizeBytes: bytes.length, overwrite: false }, { rootPath: root, requesterAccountId: 'account-one' }, staging);
      expect(prepared.success).toBe(true);
      if (!prepared.success) throw new Error(prepared.error);
      const { createEncryptedTransferChunkEnvelope } = await import('@happier-dev/transfers/node');
      const envelope = createEncryptedTransferChunkEnvelope({ transferId: prepared.response.uploadId, sequence: 0,
        payload: bytes, recipientPublicKeyBase64: prepared.response.recipientPublicKeyBase64 });
      const endpoint = `http://127.0.0.1:${server.port}/machine-transfers/direct/imports/${prepared.response.uploadId}`;
      const chunk = await fetch(`${endpoint}/chunks/0`, { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payloadBase64: envelope.payloadBase64, encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64 }) });
      expect(chunk.status).toBe(200);
      const finalized = await fetch(`${endpoint}/finalize`, { method: 'POST' });
      expect(finalized.status).toBe(200);
      expect(await finalized.json()).toMatchObject({ success: true });
      expect(await readFile(path)).toEqual(bytes);
      expect(await readdir(root)).toEqual([]);
    } finally { await server.stop(); await Promise.all([rm(root, { recursive: true, force: true }), rm(staging, { recursive: true, force: true })]); }
  });

  it('never emits an idle gap while disposing an actual published source', async () => {
    const registry = createDirectPeerTransferRegistry({ advertisedPort: 46001 });
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    registry.publishTransfer({ transferId: 'disposing', payloadSource: {
      ...createBufferTransferPayloadSource(Buffer.from('payload')), dispose: () => cleanup,
    } });
    const observations: unknown[] = [];
    const unsubscribe = registry.activity.subscribe(() => observations.push(registry.activity.read()));
    const disposal = registry.dispose();
    try {
      expect(registry.activity.read()).toMatchObject({ items: [expect.objectContaining({ state: 'active' })] });
      expect(observations).not.toContainEqual({ coverage: 'complete', items: [] });
      release();
      await disposal;
      expect(registry.activity.read()).toEqual({ coverage: 'complete', items: [] });
    } finally { release(); unsubscribe(); await disposal; }
  });
  it('retains real outgoing transfer lifetime alongside published source custody', async () => {
    const registry = createDirectPeerTransferRegistry({ advertisedPort: 46001 });
    let release!: (value: import('./transferPayloadFileSink').TransferPayloadFileResult) => void;
    const request = new Promise<import('./transferPayloadFileSink').TransferPayloadFileResult>(resolve => { release = resolve; });
    const observations: unknown[] = [];
    const unsubscribe = registry.activity.subscribe(() => observations.push(registry.activity.read()));
    const held = registry.retainPayloadFileRequest(request);
    try {
      expect(registry.activity.read()).toMatchObject({ coverage: 'complete', items: [
        { category: 'transfer', ownerRef: request, state: 'active' },
      ] });
      release({ destinationPath: '/received', sizeBytes: 0, manifestHash: 'sha256:empty' });
      await held;
      expect(registry.activity.read()).toEqual({ coverage: 'complete', items: [] });
      expect(observations).toContainEqual({ coverage: 'complete', items: [] });
    } finally { release({ destinationPath: '/received', sizeBytes: 0, manifestHash: 'sha256:empty' }); unsubscribe(); await registry.dispose(); }
  });

  it('settles an export only after the owning destination acknowledges verified binary bytes', async () => {
    const registry = createDirectPeerTransferRegistry({ advertisedPort: 46001 });
    const scope = { rootPath: '/repo', requesterAccountId: 'account-one', destinationId: 'destination-one' };
    const payloadSource = createBufferTransferPayloadSource(Buffer.from([0, 255, 128, 10]));
    const published = registry.publishTransfer({ transferId: 'binary-export', payloadSource, filesystemScope: scope });
    expect(registry.activity.read()).toMatchObject({ coverage: 'complete', items: [
      { category: 'transfer', ownerRef: 'binary-export', state: 'active' },
    ] });
    const settlement = registry.waitForFilesystemExportSettlement(published.transferId, scope);
    const app = createDirectPeerTransferApp({ readPublishedTransfer: registry.readPublishedTransfer,
      completeFilesystemExport: registry.completeFilesystemExport });
    try {
      await expect(registry.completeFilesystemExport({ transferId: published.transferId, transferToken: published.transferToken,
        outcome: { destinationId: 'destination-two', success: true, sizeBytes: 4, manifestHash: payloadSource.manifestHash! } }))
        .resolves.toMatchObject({ success: false });
      await expect(registry.completeFilesystemExport({ transferId: published.transferId, transferToken: published.transferToken,
        outcome: { destinationId: 'destination-one', success: true, sizeBytes: 4, manifestHash: 'sha256:wrong' } }))
        .resolves.toMatchObject({ success: false });
      expect(registry.countPublishedTransfers()).toBe(1);
      const completed = await app.inject({ method: 'POST', url: `/machine-transfers/direct/${encodeDirectPeerTransferPathKey(published.transferId)}/complete`,
        headers: { authorization: `Bearer ${published.transferToken}` },
        payload: { destinationId: 'destination-one', success: true, sizeBytes: 4, manifestHash: payloadSource.manifestHash! } });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toEqual({ success: true });
      await expect(settlement).resolves.toEqual({ success: true, sizeBytes: 4, manifestHash: payloadSource.manifestHash });
      expect(registry.countPublishedTransfers()).toBe(0);
    } finally { await app.close(); await registry.dispose(); }
  });
  it('uses the incumbent opaque import capability for HTTP cleanup while raw RPC cancellation remains scoped', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-scoped-http-abort-'));
    const manager = createDirectTransferImportSessionManager();
    const app = createDirectPeerTransferApp({ readPublishedTransfer: () => null, importSessionManager: manager });
    try {
      const opened = await manager.openTrustedImportSession({ workingDirectory,
        t: 'session_file_upload_v1', path: 'binary.dat', sizeBytes: 4, overwrite: false },
      { rootPath: workingDirectory, requesterAccountId: 'account-one' });
      if (!opened.success) throw new Error(opened.error);
      await expect(manager.abortImportTransferSession({ uploadId: opened.response.uploadId }, null))
        .rejects.toMatchObject({ errorCode: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH' });
      const missing = await app.inject({ method: 'POST', url: '/machine-transfers/direct/imports/abort' });
      expect(missing.statusCode).not.toBe(200);
      await app.inject({ method: 'POST', url: '/machine-transfers/direct/imports/not-an-owned-capability/abort' });
      expect(manager.countActiveImportSessions()).toBe(1);
      const response = await app.inject({ method: 'POST',
        url: `/machine-transfers/direct/imports/${opened.response.uploadId}/abort` });
      expect(response.statusCode).toBe(200);
      expect(manager.countActiveImportSessions()).toBe(0);
    } finally {
      await app.close();
      await manager.close();
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
  it('refuses cancellation outside the prepared filesystem requester and root', async () => {
    const registry = createDirectPeerTransferRegistry({ advertisedPort: 46001 });
    const scope = { rootPath: '/repo', requesterAccountId: 'account-one' };
    const published = registry.publishTransfer({ transferId: 'scoped-download',
      payload: Buffer.from([0, 255, 128, 10]), filesystemScope: scope });
    const settlement = registry.waitForFilesystemExportSettlement(published.transferId, scope);
    try {
      expect(() => registry.clearPublishedTransfer(published.transferId, { ...scope, requesterAccountId: 'account-two' }))
        .toThrowError(expect.objectContaining({ errorCode: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH' }));
      expect(() => registry.clearPublishedTransfer(published.transferId, { ...scope, rootPath: '/other' }))
        .toThrowError(expect.objectContaining({ errorCode: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH' }));
      expect(() => registry.clearPublishedTransfer(published.transferId, null))
        .toThrowError(expect.objectContaining({ errorCode: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH' }));
      expect(registry.readPublishedTransfer({ transferId: published.transferId, transferToken: published.transferToken }))
        .not.toBeNull();
      expect(registry.clearPublishedTransfer(published.transferId, scope)).toBe(true);
      expect(registry.clearPublishedTransfer(published.transferId, scope)).toBe(false);
      await expect(settlement).resolves.toMatchObject({ success: false, errorCode: 'cancelled' });
      expect(registry.readPublishedTransfer({ transferId: published.transferId, transferToken: published.transferToken }))
        .toBeNull();
    } finally { await registry.dispose(); }
  });
  afterEach(() => {
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_TTL_MS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_EXPIRY_SKEW_MS;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_OPEN_BODY_MAX_BYTES;
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_MAX_ENTRIES;
    delete process.env.HAPPIER_FILES_READ_MAX_BYTES;
  });

  it('responds to browser preflight requests for published transfer routes with loopback-safe CORS headers', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46001,
      now: () => 1_000,
    });
    const published = registry.publishTransfer({
      transferId: 'transfer_preflight',
      payload: Buffer.from('payload', 'utf8'),
    });

    const app = createDirectPeerTransferApp({
      readPublishedTransfer: registry.readPublishedTransfer,
    });

    try {
      await app.ready();

      const response = await app.inject({
        method: 'OPTIONS',
        url: buildDirectPeerChunkUrl('transfer_preflight', 0),
        headers: {
          origin: 'https://app.happier.dev',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization,x-happier-transfer-recipient-public-key',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('https://app.happier.dev');
      expect(response.headers['access-control-allow-methods']).toContain('GET');
      expect(response.headers['access-control-allow-headers']).toContain('authorization');
      expect(response.headers['access-control-allow-headers']).toContain('x-happier-transfer-recipient-public-key');
      expect(response.headers.vary).toContain('Origin');

      expect(published.endpointCandidates).toEqual([
        expect.objectContaining({
          kind: 'http',
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it('responds to browser preflight requests for direct-open routes with loopback-safe CORS headers', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46001,
      now: () => 1_000,
    });
    registry.publishTransfer({
      transferId: 'transfer_open_preflight',
      payload: Buffer.from('payload', 'utf8'),
    });

    const app = createDirectPeerTransferApp({
      readPublishedTransfer: registry.readPublishedTransfer,
    });

    try {
      await app.ready();

      const response = await app.inject({
        method: 'OPTIONS',
        url: buildDirectPeerOpenUrl('transfer_open_preflight'),
        headers: {
          origin: 'https://app.happier.dev',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,x-happier-transfer-recipient-public-key',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('https://app.happier.dev');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-headers']).toContain('authorization');
      expect(response.headers['access-control-allow-headers']).toContain('x-happier-transfer-recipient-public-key');
      expect(response.headers.vary).toContain('Origin');
    } finally {
      await app.close();
    }
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

  it('coalesces concurrent on-demand opens for one transfer id onto one payload source', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const { createDirectPeerTransferRegistry } = await import('./directPeerTransport');
    const { createFileTransferPayloadSource } = await import('./transferPayloadSource');

    let releaseResolution!: () => void;
    const resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    const dispose = vi.fn(async () => {});
    const resolvePayloadSourceOnOpen = vi.fn(async () => {
      await resolutionGate;
      return createFileTransferPayloadSource({
        filePath: '/tmp/coalesced-on-demand-payload',
        sizeBytes: 7,
        manifestHash: 'sha256:coalesced',
        dispose,
      });
    });
    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46001,
      now: () => 1_000,
    });
    const carrier = registry.publishTransfer({
      transferId: 'scope_carrier_coalesced',
      payload: Buffer.from('carrier', 'utf8'),
      onDemandScope: {
        allowTransferId: (transferId) => transferId === 'dynamic:coalesced',
        resolvePayloadSourceOnOpen,
      },
    });
    const openInput = {
      transferId: 'dynamic:coalesced',
      transferToken: carrier.transferToken,
      requestBody: { path: 'same-resource' },
    };

    const firstOpen = registry.resolveOnDemandTransferOnOpen(openInput);
    const secondOpen = registry.resolveOnDemandTransferOnOpen(openInput);
    await Promise.resolve();

    expect(resolvePayloadSourceOnOpen).toHaveBeenCalledTimes(1);

    releaseResolution();
    const [firstSource, secondSource] = await Promise.all([firstOpen, secondOpen]);
    expect(firstSource).toBe(secondSource);

    registry.clearPublishedTransfer('scope_carrier_coalesced');
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
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

  it('clamps local advertisement config to loopback but rejects explicit nonloopback remote candidates', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '192.168.1.20,10.0.0.8';

    const {
      buildDirectTransferImportOpenEndpointCandidates,
      buildDirectTransferImportSessionEndpointCandidates,
      createDirectPeerTransferRegistry,
    } = await import('./directPeerTransport');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46001,
      now: () => 1_000,
    });
    expect(registry.publishTransfer({
      transferId: 'transfer_nonloopback_advertisement',
      payload: Buffer.from('private payload', 'utf8'),
    }).endpointCandidates).toEqual([
      expect.objectContaining({
        kind: 'http',
        url: 'http://127.0.0.1:46001/machine-transfers/direct/dHJhbnNmZXJfbm9ubG9vcGJhY2tfYWR2ZXJ0aXNlbWVudA',
        expiresAt: 601_000,
      }),
    ]);
    expect(buildDirectTransferImportOpenEndpointCandidates({
      advertisedPort: 46001,
      authorizationToken: 'open-token',
      expiresAt: 2_000,
      advertisedHosts: ['192.168.1.20'],
    })).toEqual([]);
    expect(buildDirectTransferImportSessionEndpointCandidates({
      advertisedPort: 46001,
      uploadId: 'upload-1',
      expiresAt: 2_000,
      advertisedHosts: ['10.0.0.8'],
    })).toEqual([]);
  });

  it('retains loopback HTTP candidates while filtering non-loopback hosts', async () => {
    const {
      buildDirectTransferImportOpenEndpointCandidates,
      buildDirectTransferImportSessionEndpointCandidates,
    } = await import('./directPeerTransport');

    expect(buildDirectTransferImportOpenEndpointCandidates({
      advertisedPort: 46001,
      authorizationToken: 'open-token',
      expiresAt: 2_000,
      advertisedHosts: ['192.168.1.20', '127.0.0.1', '::1'],
    }).map((candidate) => candidate.url)).toEqual([
      'http://127.0.0.1:46001/machine-transfers/direct/imports/open',
      'http://[::1]:46001/machine-transfers/direct/imports/open',
    ]);
    expect(buildDirectTransferImportSessionEndpointCandidates({
      advertisedPort: 46001,
      uploadId: 'upload-1',
      expiresAt: 2_000,
      advertisedHosts: ['10.0.0.8', 'localhost'],
    }).map((candidate) => candidate.url)).toEqual([
      'http://localhost:46001/machine-transfers/direct/imports/upload-1',
    ]);
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

      const headers = {
        authorization: `Bearer ${published.transferToken}`,
        'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
      };
      expect((await app.inject({ method: 'POST', url: buildDirectPeerOpenUrl(published.transferId), headers })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: buildDirectPeerChunkUrl(published.transferId, 0), headers })).statusCode).toBe(200);

      const open = await app.inject({
        method: 'POST',
        url: `${buildDirectPeerOpenUrl(published.transferId)}?token=${published.transferToken}`,
        headers: {
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      const chunk = await app.inject({
        method: 'GET',
        url: `${buildDirectPeerChunkUrl(published.transferId, 0)}?token=${published.transferToken}`,
        headers: {
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect([open.statusCode, chunk.statusCode]).toEqual([404, 404]);
      expect(open.json()).toEqual({ ok: false, error: 'Direct peer transfer not available' });
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
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

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

  it('cancels an in-flight direct-peer download from the caller signal without retrying', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-cancelled-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const cancellation = new AbortController();
    const fetchFn: typeof fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      cancellation.abort();
      init?.signal?.throwIfAborted();
      throw new Error('fetch continued after caller cancellation');
    });

    try {
      await expect(requestDirectPeerTransferToFile({
        transferId: 'transfer_cancelled',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_cancelled',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        }],
        destinationPath,
        fetchFn,
        now: () => 5_000,
        signal: cancellation.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetchFn).toHaveBeenCalledOnce();
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('skips endpoint candidates that are not direct-peer endpoints (no outbound fetch for non-matching paths)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-ssrf-skip-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

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

      expect(url).toBe('https://good.example/machine-transfers/direct/transfer_ssrf_skip/chunks/0');
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
          kind: 'https',
          url: 'https://bad.example/not-a-direct-peer-endpoint',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        },
        {
          kind: 'https',
          url: 'https://good.example/machine-transfers/direct/transfer_ssrf_skip',
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
        kind: 'https',
        url: 'https://example.test/machine-transfers/direct/transfer_oversized_body',
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
        kind: 'https',
        url: 'https://example.test/machine-transfers/direct/transfer_streamed_oversized_body',
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

  it('rejects a route request without an auth token before calling transfer lookup callbacks', async () => {
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

  it('rejects a route request with an oversized auth token before calling transfer lookup callbacks', async () => {
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

  it('rejects an invalid recipient public key before calling route transfer lookup callbacks', async () => {
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
      expect(readPublishedTransfer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('maps a constructed on-demand resolver not-ready rejection to a retryable 503 response', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const { createDirectPeerTransferApp } = await import('./directPeerTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');
    const resolveOnDemandTransfer = vi.fn(async () => {
      throw new Error('Direct peer transfer not ready');
    });

    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
      resolveOnDemandTransfer,
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: buildDirectPeerOpenUrl('transfer_not_ready'),
        headers: {
          authorization: 'Bearer test-token',
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false, error: 'Direct peer transfer not ready' });
      expect(resolveOnDemandTransfer).toHaveBeenCalledTimes(1);
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

  it.each(['provided', 'incorrect', 'omitted'] as const)('does not retain streamed JSON chunks in an array when content-length is %s', async (contentLength) => {
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-json-read-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');
    const transferId = 'transfer_streamed_json';
    const payload = Buffer.from('payload-with-streamed-json-read', 'utf8');
    let recipientPublicKeyBase64 = '';
    const responseChunks = new WeakSet<object>();
    let deliveredChunks = 0;
    const encoder = new TextEncoder();
    const streamJson = (value: unknown): Response => {
      const bytes = encoder.encode(JSON.stringify(value));
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const chunk = bytes.slice(offset, ++offset);
          responseChunks.add(chunk);
          deliveredChunks += 1;
          controller.enqueue(chunk);
        },
      });
      return new Response(body, {
        headers: {
          'content-type': 'application/json',
          ...(contentLength === 'omitted' ? {} : {
            'content-length': contentLength === 'incorrect' ? '1' : String(bytes.byteLength),
          }),
        },
      });
    };
    const fetchFn: typeof fetch = async (input, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (String(input).endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return streamJson({ transferId, manifestHash: createTransferManifestHash(payload), totalChunks: 1 });
      }
      if (String(input).endsWith('/chunks/0')) {
        return streamJson({ transferId, kind: 'chunk', sequence: 0,
          ...createEncryptedTransferChunkEnvelope({ transferId, sequence: 0, payload, recipientPublicKeyBase64,
            randomBytes: length => new Uint8Array(length).fill(9) }),
        });
      }
      throw new Error(`Unexpected fetch URL: ${String(input)}`);
    };

    // Observe actual transport chunks, independent of the consumer's function or file names.
    const originalPush = Array.prototype.push;
    Array.prototype.push = function (...args: unknown[]) {
      if (args.some(value => typeof value === 'object' && value !== null && responseChunks.has(value))) {
        throw new Error('Response chunks must not be retained in an array');
      }
      return originalPush.apply(this, args);
    };
    try {
      const controlChunk = new Uint8Array([1]);
      responseChunks.add(controlChunk);
      expect(() => [].push(controlChunk)).toThrow('Response chunks must not be retained in an array');
      await requestDirectPeerTransferToFile({ transferId,
        endpointCandidates: [{ kind: 'http', url: `http://127.0.0.1:46001/machine-transfers/direct/${transferId}`,
          authorizationToken: 'test-token', expiresAt: 10_000 }],
        fetchFn, now: () => 5_000, destinationPath,
      });
      expect(deliveredChunks).toBeGreaterThan(payload.byteLength);
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      Array.prototype.push = originalPush;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects an oversized direct-peer open body before whole-object JSON serialization or fetch', async () => {
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
      expect(() => JSON.stringify(openBody)).toThrow('JSON.stringify should not be called for an oversized open body');
      await expect(requestDirectPeerTransferToFile({
        transferId: 'transfer_open_body_client_guard',
        endpointCandidates: [{
          kind: 'https',
          url: 'https://example.test/machine-transfers/direct/transfer_open_body_client_guard',
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
          kind: 'https',
          url: 'https://example.test/machine-transfers/direct/transfer_open_body_hard_clamp',
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
          kind: 'https',
          url: 'https://example.test/machine-transfers/direct/transfer_open_body_hard_ceiling',
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
          kind: 'https',
          url: 'https://example.test/machine-transfers/direct/transfer_open_body_tojson_inflation',
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

  it('sends a direct-peer open body as exact JSON accepted by the Fetch Request consumer', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

    const openBody = {
      payload: 'payload-from-bytes-open-body',
    };
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-open-body-bytes-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    let capturedOpenBodyText: string | undefined;
    let recipientPublicKeyBase64 = '';
    const emptyManifestHash = createTransferManifestHash(Buffer.alloc(0));
    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as Request).url ?? '');
      if (url.endsWith('/open')) {
        capturedOpenBodyText = await new Request(url, init).text();
        expect(JSON.parse(capturedOpenBodyText)).toEqual(openBody);
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
          kind: 'https',
          url: 'https://example.test/machine-transfers/direct/transfer_open_body_bytes',
          authorizationToken: 'abc',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 1_000,
        destinationPath,
        openBody,
      });

      expect(capturedOpenBodyText).toBe(JSON.stringify(openBody));
      await expect(readFile(destinationPath)).resolves.toEqual(Buffer.alloc(0));
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

  it('allows on-demand resources and an outer retry to use fresh recipient keys under one scoped token', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const {
      createDirectPeerTransferApp,
      createDirectPeerTransferRegistry,
    } = await import('./directPeerTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');
    const { decryptEncryptedTransferChunkEnvelope } = await import('@happier-dev/transfers/node');
    const { createBufferTransferPayloadSource } = await import('./transferPayloadSource');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46001,
      now: () => 1_000,
    });
    const published = registry.publishTransfer({
      transferId: 'scope_carrier_fresh_keys',
      payload: Buffer.from('token-carrier', 'utf8'),
      onDemandScope: {
        allowTransferId: (transferId) => transferId.startsWith('dynamic:fresh-key:'),
        resolvePayloadSourceOnOpen: async ({ transferId }) =>
          createBufferTransferPayloadSource(Buffer.from(transferId, 'utf8')),
      },
    });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: registry.readPublishedTransfer,
      resolveOnDemandTransfer: registry.resolveOnDemandTransferOnOpen,
    });
    const downloadWithFreshKey = async (transferId: string, seedByte: number) => {
      const recipientSecretKeySeed = new Uint8Array(32).fill(seedByte);
      const headers = {
        authorization: `Bearer ${published.transferToken}`,
        'x-happier-transfer-recipient-public-key': Buffer.from(
          deriveBoxPublicKeyFromSeed(recipientSecretKeySeed),
        ).toString('base64'),
      };
      const open = await app.inject({ method: 'POST', url: buildDirectPeerOpenUrl(transferId), headers });
      expect(open.statusCode).toBe(200);
      const response = await app.inject({ method: 'GET', url: buildDirectPeerChunkUrl(transferId, 0), headers });
      expect(response.statusCode).toBe(200);
      const envelope = response.json();
      const decrypt = (seed: Uint8Array) => decryptEncryptedTransferChunkEnvelope({ transferId, sequence: 0,
        payloadBase64: envelope.payloadBase64, encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64,
        recipientSecretKeySeed: seed });
      expect(decrypt(recipientSecretKeySeed)).toEqual(Buffer.from(transferId, 'utf8'));
      expect(() => decrypt(new Uint8Array(32).fill(11))).toThrow();
    };

    try {
      await app.ready();
      await downloadWithFreshKey('dynamic:fresh-key:manifest', 3);
      await downloadWithFreshKey('dynamic:fresh-key:pack', 5);
      await downloadWithFreshKey('dynamic:fresh-key:manifest', 7);
    } finally {
      await app.close();
    }
  });

  it('retries a retryable 503 direct-peer open response before failing the transfer', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-retry-503-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');
    const payload = Buffer.from('payload-after-503-retry', 'utf8');
    let recipientPublicKeyBase64 = '';
    let openAttempts = 0;

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const url = String(input);
      if (url.endsWith('/open')) {
        openAttempts += 1;
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? recipientPublicKeyBase64;
        if (openAttempts === 1) {
          return new Response(JSON.stringify({
            ok: false,
            error: 'Direct peer transfer not ready',
          }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          transferId: 'transfer_retry_503',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/chunks/0')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_retry_503',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_retry_503',
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

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_retry_503',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_retry_503',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 5_000,
        destinationPath,
      });

      expect(openAttempts).toBe(2);
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await rm(tempDir, { recursive: true }).catch(() => undefined);
    }
  });

  it('writes each direct-peer chunk before requesting the next and resets partial bytes on candidate fallback', async () => {
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-incremental-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');
    const transferId = 'transfer_incremental';
    const chunks = [Buffer.from('first-chunk'), Buffer.from('second-chunk')];
    const payload = Buffer.concat(chunks);
    let recipientPublicKeyBase64 = '';
    let firstChunkCommitted = false;
    const requestedChunks: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      const candidate = url.includes('/fallback/') ? 'fallback' : 'initial';
      if (url.endsWith('/open')) {
        const headers = init?.headers as Record<string, string>;
        recipientPublicKeyBase64 = headers['x-happier-transfer-recipient-public-key'] ?? '';
        firstChunkCommitted = false;
        return Response.json({ transferId, manifestHash: createTransferManifestHash(payload), totalChunks: chunks.length });
      }
      const sequence = Number(url.slice(url.lastIndexOf('/') + 1));
      requestedChunks.push(`${candidate}:${sequence}`);
      if (sequence === 1) {
        // A whole-transfer accumulator or a detached sink write cannot satisfy this real disk boundary.
        expect(firstChunkCommitted).toBe(true);
        const partialFiles = await readdir(tempDir);
        expect(partialFiles).toHaveLength(1);
        expect(await readFile(join(tempDir, partialFiles[0]!))).toEqual(chunks[0]);
        if (candidate === 'initial') return new Response('unavailable', { status: 500 });
      }
      return Response.json({ transferId, kind: 'chunk', sequence,
        ...createEncryptedTransferChunkEnvelope({ transferId, sequence, payload: chunks[sequence]!, recipientPublicKeyBase64,
          randomBytes: length => new Uint8Array(length).fill(9) }),
      });
    };
    try {
      await requestDirectPeerTransferToFile({ transferId,
        endpointCandidates: ['initial', 'fallback'].map(candidate => ({ kind: 'http' as const,
          url: `http://127.0.0.1:46001/${candidate}/machine-transfers/direct/${transferId}`,
          authorizationToken: 'test-token', expiresAt: 10_000 })),
        fetchFn, now: () => 5_000, destinationPath,
        onProgress: async receivedBytes => {
          if (receivedBytes === chunks[0]!.length) {
            const partialFiles = await readdir(tempDir);
            expect(await readFile(join(tempDir, partialFiles[0]!))).toEqual(chunks[0]);
            firstChunkCommitted = true;
          }
        },
      });
      expect(requestedChunks).toEqual(['initial:0', 'initial:1', 'fallback:0', 'fallback:1']);
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
      expect(await readdir(tempDir)).toEqual(['payload-destination.bin']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('accepts direct-peer endpoint candidates with a path prefix (for example Tailscale Serve)', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

    const payload = Buffer.from('payload-from-prefixed-endpoint', 'utf8');
    let recipientPublicKeyBase64 = '';

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;

      if (url === 'https://example.ts.net/__happier/transfer/machine-transfers/direct/transfer_prefixed/open') {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_prefixed',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === 'https://example.ts.net/__happier/transfer/machine-transfers/direct/transfer_prefixed/chunks/0') {
        return new Response(JSON.stringify({
          transferId: 'transfer_prefixed',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_prefixed',
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(7),
          }),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-prefixed-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_prefixed',
        endpointCandidates: [{
          kind: 'https',
          url: 'https://example.ts.net/__happier/transfer/machine-transfers/direct/transfer_prefixed',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 5_000,
        destinationPath,
      });

      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('does not call String.prototype.trim on large base64 chunk fields while fetching a direct-peer payload', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

    const payload = Buffer.from(new Uint8Array(2048).fill(7));
    let recipientPublicKeyBase64 = '';
    const largeChunkFields = new Set<string>();

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
        const chunkBody = {
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
        };
        largeChunkFields.add(chunkBody.payloadBase64);
        expect(() => chunkBody.payloadBase64.trim()).toThrow('String.prototype.trim should not be used for large direct-peer chunk fields');
        return new Response(JSON.stringify(chunkBody), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${String(input)}`);
    });

    const originalTrim = String.prototype.trim;
    String.prototype.trim = function () {
      const value = String(this);
      if (largeChunkFields.has(value)) {
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
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

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

      expect(recipientPublicKeyBase64ByAttempt.length).toBeGreaterThan(1);
      expect(new Set(recipientPublicKeyBase64ByAttempt).size).toBe(1);
      expect(openBodySerializationCount).toBe(1);
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

  it('retries a transiently unavailable direct-peer candidate before failing the transfer', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

    const payload = Buffer.from('payload-for-transient-candidate-retry', 'utf8');
    let openAttempts = 0;
    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      if (url.includes('/candidate-1/open')) {
        openAttempts += 1;
        if (openAttempts === 1) {
          throw new Error('fetch failed');
        }
        return new Response(JSON.stringify({
          transferId: 'transfer_transient_candidate_retry',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/candidate-1/chunks/0')) {
        const recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_transient_candidate_retry',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_transient_candidate_retry',
            sequence: 0,
            payload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(11),
          }),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-transient-retry-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_transient_candidate_retry',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/candidate-1',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 5_000,
        destinationPath,
      });

      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when the direct-peer /open response is 200 but not application/json', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

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
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

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
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

    const payload = Buffer.from('payload-for-streamed-open-body', 'utf8');
    const digests = Array.from({ length: 128 }, (_, index) => `sha256:${String(index).padStart(64, '0')}`);
    let digestReads = 0;
    const openBody = {
      t: 'direct_peer_streamed_open_body',
      packId: 'pack_streamed_open_body',
      get digests() {
        digestReads += 1;
        return digests;
      },
    };
    const expectedBody = JSON.stringify({ t: openBody.t, packId: openBody.packId, digests });
    let recipientPublicKeyBase64 = '';
    const observedBodyKinds: string[] = [];

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const url = String(input);
      if (url.endsWith('/open')) {
        observedBodyKinds.push(Object.prototype.toString.call(init?.body));
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        expect(init?.body).toBeInstanceOf(ReadableStream);
        const body = init?.body as ReadableStream<Uint8Array>;
        const reader = body.getReader();
        const decoder = new TextDecoder();
        const readsBeforeConsumption = digestReads;
        let rawBody = '';
        let chunkCount = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (chunkCount === 0) expect(digestReads).toBe(readsBeforeConsumption);
          expect(value.byteLength).toBeLessThan(Buffer.byteLength(expectedBody));
          rawBody += decoder.decode(value, { stream: true });
          chunkCount += 1;
        }
        rawBody += decoder.decode();
        expect(chunkCount).toBeGreaterThan(1);
        expect(digestReads).toBeGreaterThan(readsBeforeConsumption);
        expect(JSON.parse(rawBody)).toEqual(JSON.parse(expectedBody));
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
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await rm(tempDir, { recursive: true }).catch(() => undefined);
    }
  });

  it('does not preallocate the entire chunk response body when content-length is large', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');
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
    const allocationSizes: Array<number> = [];
    const guardedUint8Array = new Proxy(originalUint8Array, {
      construct(target, args, newTarget) {
        const first = args[0];
        if (typeof first === 'number') allocationSizes.push(first);
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
      expect(allocationSizes.length).toBeGreaterThan(0);
      const transferAllocationSizes = allocationSizes.slice();
      // Positive sensitivity control: the observer must see the allocation this contract forbids.
      new Uint8Array(chunkContentLength);
      expect(allocationSizes.slice(transferAllocationSizes.length)).toEqual([chunkContentLength]);
      expect(transferAllocationSizes).not.toContain(chunkContentLength);
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
    const { createTransferManifestHash } = await import('@happier-dev/transfers/node');

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

  it('rejects a direct endpoint commitment that disagrees with the caller publication before requesting chunks', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-commitment-mismatch-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');
    const publishedPayload = Buffer.from('expected', 'utf8');
    const endpointPayload = Buffer.from('endpoint', 'utf8');
    const publishedManifestHash = createTransferManifestHash(publishedPayload);
    const fetchFn: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/open')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_commitment_mismatch',
          manifestHash: createTransferManifestHash(endpointPayload),
          totalChunks: 1,
          sizeBytes: endpointPayload.byteLength,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected chunk request: ${url}`);
    });

    try {
      await writeFile(destinationPath, 'preserve-existing');
      await expect(requestDirectPeerTransferToFile({
        transferId: 'transfer_commitment_mismatch',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_commitment_mismatch',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        }],
        destinationPath,
        fetchFn,
        now: () => 5_000,
        expectedSizeBytes: publishedPayload.byteLength,
        expectedManifestHash: publishedManifestHash,
      })).rejects.toThrow('Direct peer transfer commitment mismatch for transfer_commitment_mismatch');

      expect(fetchFn).toHaveBeenCalledTimes(1);
      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('preserve-existing');
      await expect(readdir(tempDir)).resolves.toEqual(['payload-destination.bin']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects plaintext beyond the published expected size before writing or promoting it', async () => {
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-size-commitment-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');
    const publishedPayload = Buffer.from('abc', 'utf8');
    const oversizedPayload = Buffer.from('abcd', 'utf8');
    const publishedManifestHash = createTransferManifestHash(publishedPayload);
    let recipientPublicKeyBase64 = '';
    const fetchFn: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      if (url.endsWith('/open')) {
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_expected_size',
          manifestHash: publishedManifestHash,
          totalChunks: 1,
          sizeBytes: publishedPayload.byteLength,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        transferId: 'transfer_expected_size',
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: 'transfer_expected_size',
          sequence: 0,
          payload: oversizedPayload,
          recipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(5),
        }),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      await writeFile(destinationPath, 'preserve-existing');
      await expect(requestDirectPeerTransferToFile({
        transferId: 'transfer_expected_size',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_expected_size',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        }],
        destinationPath,
        fetchFn,
        now: () => 5_000,
        expectedSizeBytes: publishedPayload.byteLength,
        expectedManifestHash: publishedManifestHash,
      })).rejects.toThrow('Direct peer transfer commitment mismatch for transfer_expected_size');

      expect(fetchFn).toHaveBeenCalledTimes(2);
      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('preserve-existing');
      await expect(readdir(tempDir)).resolves.toEqual(['payload-destination.bin']);
    } finally {
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
    const { createTransferManifestHash } = await import('@happier-dev/transfers/node');

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

  it('reuses resolved /open metadata across repeated opens for the same transfer token', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const payloadSourceModule = await import('./transferPayloadSource');
    const { createDirectPeerTransferApp, createDirectPeerTransferRegistry } = await import('./directPeerTransport');
    const { createFileTransferPayloadSource } = payloadSourceModule;
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

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
      const first = await app.inject({
        method: 'POST',
        url: buildDirectPeerOpenUrl('transfer_open_cache'),
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(first.statusCode).toBe(200);
      // Once metadata has been resolved, another open must reuse it rather
      // than accessing the physical source again. A fresh stat/hash would fail.
      await rm(tempPath);

      const second = await app.inject({
        method: 'POST',
        url: buildDirectPeerOpenUrl('transfer_open_cache'),
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(second.statusCode).toBe(200);

      expect(second.json()).toEqual(first.json());
    } finally {
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

    const { createDirectPeerTransferApp, createDirectPeerTransferRegistry } = await import('./directPeerTransport');
    const { createBufferTransferPayloadSource } = await import('./transferPayloadSource');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');
    const payloadSource = createBufferTransferPayloadSource(Buffer.from('hello'));
    const registry = createDirectPeerTransferRegistry({ advertisedPort: 46003, now: () => 7_000 });
    const published = registry.publishTransfer({ transferId: 'transfer_token_hash_cache', payloadSource });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: registry.readPublishedTransfer,
    });

    try {
      await app.ready();

      createHashSpy.mockClear();

      const first = await app.inject({
        method: 'POST',
        url: buildDirectPeerOpenUrl('transfer_token_hash_cache'),
        headers: {
          authorization: `Bearer ${published.transferToken}`,
          'x-happier-transfer-recipient-public-key': recipientPublicKeyBase64,
        },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: buildDirectPeerOpenUrl('transfer_token_hash_cache'),
        headers: {
          authorization: `Bearer ${published.transferToken}`,
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

  it('defaults published direct peer candidates to loopback when no explicit advertised-host override exists', async () => {
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS;

    const { createDirectPeerTransferRegistry } = await import('./directPeerTransport');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46006,
      now: () => 1_000,
    });

    const published = registry.publishTransfer({
      transferId: 'transfer_ipv6_advertise',
      payload: Buffer.from('hello', 'utf8'),
    });
    const urls = published.endpointCandidates.map((candidate) => candidate.url);
    const transferKey = Buffer.from('transfer_ipv6_advertise', 'utf8').toString('base64url');

    expect(urls).toEqual([
      `http://127.0.0.1:46006/machine-transfers/direct/${transferKey}`,
    ]);
    expect(urls.some((url) => url.includes('%'))).toBe(false);
  });

  it('does not widen explicitly configured advertised hosts with discovered NIC addresses', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

    const { createDirectPeerTransferRegistry } = await import('./directPeerTransport');

    const registry = createDirectPeerTransferRegistry({
      advertisedPort: 46007,
      now: () => 1_000,
    });

    const published = registry.publishTransfer({
      transferId: 'transfer_configured_and_detected_advertise',
      payload: Buffer.from('hello', 'utf8'),
    });
    const urls = published.endpointCandidates.map((candidate) => candidate.url);
    const transferKey = Buffer.from('transfer_configured_and_detected_advertise', 'utf8').toString('base64url');

    expect(urls).toEqual([
      `http://127.0.0.1:46007/machine-transfers/direct/${transferKey}`,
    ]);
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
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');
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

    const onProgress = vi.fn();
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
      onProgress,
    });

    await expect(readFile(destinationPath)).resolves.toEqual(payload);
    expect(onProgress).toHaveBeenLastCalledWith(payload.length);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('never fetches a predecessor LAN HTTP candidate and continues with HTTPS', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-safe-candidate-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');
    const payload = Buffer.from('payload-via-https', 'utf8');
    let recipientPublicKeyBase64 = '';
    const fetchFn: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      expect(url).not.toContain('192.168.1.20');
      const headers = init?.headers as Record<string, string> | undefined;
      if (url.endsWith('/open')) {
        expect(url).toBe('https://machine.example.test/machine-transfers/direct/transfer_safe/open');
        recipientPublicKeyBase64 = headers?.['x-happier-transfer-recipient-public-key'] ?? '';
        return new Response(JSON.stringify({
          transferId: 'transfer_safe',
          manifestHash: createTransferManifestHash(payload),
          totalChunks: 1,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      expect(url).toBe('https://machine.example.test/machine-transfers/direct/transfer_safe/chunks/0');
      return new Response(JSON.stringify({
        transferId: 'transfer_safe',
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: 'transfer_safe',
          sequence: 0,
          payload,
          recipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(7),
        }),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    try {
      await requestDirectPeerTransferToFile({
        transferId: 'transfer_safe',
        endpointCandidates: [
          {
            kind: 'http',
            url: 'http://192.168.1.20:46001/machine-transfers/direct/transfer_safe',
            authorizationToken: 'remote-dev-shaped-token',
            expiresAt: 10_000,
          },
          {
            kind: 'https',
            url: 'https://machine.example.test/machine-transfers/direct/transfer_safe',
            authorizationToken: 'https-token',
            expiresAt: 10_000,
          },
        ],
        fetchFn,
        now: () => 5_000,
        destinationPath,
      });

      expect(fetchFn).toHaveBeenCalledTimes(2);
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails direct transfer without fetching when every candidate is non-loopback HTTP', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-insecure-only-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');
    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const fetchFn: typeof fetch = vi.fn(async () => {
      throw new Error('insecure candidate must never be fetched');
    });

    try {
      await expect(requestDirectPeerTransferToFile({
        transferId: 'transfer_insecure_only',
        endpointCandidates: [{
          kind: 'http',
          url: 'http://10.1.2.3:46001/machine-transfers/direct/transfer_insecure_only',
          authorizationToken: 'remote-dev-shaped-token',
          expiresAt: 10_000,
        }],
        fetchFn,
        now: () => 5_000,
        destinationPath,
      })).rejects.toThrow('No reachable direct peer transfer candidate');
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('skips direct-peer endpoint candidates that include extra path segments (prevents auth token leakage to attacker-controlled URLs)', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-ssrf-segments-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

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

      expect(url).toBe('https://good.example/machine-transfers/direct/transfer_ssrf_skip/chunks/0');
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
          kind: 'https',
          // Contains the direct-peer marker but is not a base transfer endpoint.
          url: 'https://bad.example/machine-transfers/direct/transfer_ssrf_skip/open',
          authorizationToken: 'test-token',
          expiresAt: 10_000,
        },
        {
          kind: 'https',
          url: 'https://good.example/machine-transfers/direct/transfer_ssrf_skip',
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
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');

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

      expect(url).toBe('https://good.example/machine-transfers/direct/transfer_oversized_auth_token_skip/chunks/0');
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
            kind: 'https',
            url: 'https://bad.example/machine-transfers/direct/transfer_oversized_auth_token_skip',
            authorizationToken: 'x'.repeat(10_000),
            expiresAt: 10_000,
          },
          {
            kind: 'https',
            url: 'https://good.example/machine-transfers/direct/transfer_oversized_auth_token_skip',
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
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');
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

  it('accepts a constructed open response without sizeBytes while enforcing the supplied commitment', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-expiry-skew-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('@happier-dev/transfers/node');
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
      expectedSizeBytes: payload.byteLength,
      expectedManifestHash: createTransferManifestHash(payload),
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

  it('fails closed before requesting chunks when totalChunks cannot fit the authoritative byte commitment', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-peer-transfer-open-too-many-chunks-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestDirectPeerTransferToFile } = await import('./directPeerTransport');

    const fetchFn: typeof fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/open')) {
        return new Response(JSON.stringify({
          transferId: 'transfer_open_too_many_chunks',
          manifestHash: 'sha256:expected',
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
      expectedSizeBytes: 3,
      expectedManifestHash: 'sha256:expected',
    })).rejects.toThrow('Invalid direct peer transfer response');

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
