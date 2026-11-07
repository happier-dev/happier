import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';

import { describe, expect, it, vi } from 'vitest';

import { fetchVoiceModelPackManifest, hashVoiceModelPackManifest, installVoiceModelPack, readInstalledVoiceModelPackManifest, removeInstalledVoiceModelPack } from './voiceModelPackInstaller';
import { parseModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import type { NodeModelPackDownloadTransport } from './nodeModelPackInstallerHost';
import { createEphemeralTlsServerFixture } from '../../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';
import { bindProcessLogger, Logger } from '../../ui/logger';

const manifestFixture = (packId: string) => ({
  packId,
  kind: 'tts_sherpa',
  model: 'kokoro',
  version: 'v1',
  files: [{
    path: 'file.bin',
    url: 'https://cdn.example/file.bin',
    sha256: '0'.repeat(64),
    sizeBytes: 1,
  }],
});

async function withLegacyFetchFixture<T>(
  packId: string,
  work: (legacyFetch: ReturnType<typeof vi.fn<typeof fetch>>) => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  const legacyFetch = vi.fn<typeof fetch>(async () => new Response(
    JSON.stringify(manifestFixture(packId)),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  globalThis.fetch = legacyFetch;
  try {
    return await work(legacyFetch);
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('voiceModelPackInstaller packId filesystem safety', () => {
  it('preserves retained daemon manifest hashes and includes runtime metadata', () => {
    const manifest = parseModelPackManifest({ ...manifestFixture('metadata-currentness'),
      voices: [{ id: 'voice-a', title: 'A', sid: 0 }, { id: 'voice-b', title: 'B', sid: 1 }],
      defaultVoiceId: 'voice-a', frontend: { lang: 'en-us' } });
    // The existing daemon receipt identity is SHA-256 of this complete serialization.
    const retainedHash = createHash('sha256').update(JSON.stringify(manifest, null, 2), 'utf8').digest('hex');
    expect(hashVoiceModelPackManifest(manifest)).toBe(retainedHash);
    for (const revision of [
      { ...manifest, voices: [{ id: 'voice-a', title: 'A', sid: 1 }, { id: 'voice-b', title: 'B', sid: 0 }] },
      { ...manifest, defaultVoiceId: 'voice-b' },
      { ...manifest, frontend: { lang: 'fr-fr' } },
    ]) expect(hashVoiceModelPackManifest(revision)).not.toBe(retainedHash);
  });

  it.each(['corrupt', 'unreadable'] as const)('logs %s receipt fallback locally without contents and keeps missing receipts quiet', async (failure) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-receipt-warning-'));
    const packId = 'receipt-warning';
    const logPath = join(root, 'warning.log');
    await writeFile(logPath, '');
    const log = new Logger({ logFilePath: logPath, pruneCurrentProcessLogs: false, allowDangerousRemoteLogging: false });
    const restore = bindProcessLogger(log);
    const privateContents = 'private_receipt_contents';
    try {
      expect(await readInstalledVoiceModelPackManifest({ packsRootDir: root, packId })).toBeNull();
      log.flushSync();
      expect(await readFile(logPath, 'utf8')).toBe('');
      await mkdir(join(root, packId));
      if (failure === 'corrupt') await writeFile(join(root, packId, 'pack.json'), privateContents);
      else await mkdir(join(root, packId, 'pack.json'));
      expect(await readInstalledVoiceModelPackManifest({ packsRootDir: root, packId })).toBeNull();
      log.flushSync();
      const content = await readFile(logPath, 'utf8');
      expect(content).toContain('[WARN]');
      expect(content).not.toContain(privateContents);
    } finally { restore(); await rm(root, { recursive: true, force: true }); }
  });

  it('drops retired installed manifest fields recursively and keeps known frontend validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-stored-voice-manifest-'));
    const packId = 'stored-manifest';
    const path = join(root, packId, 'pack.json');
    const canonical = { ...manifestFixture(packId), frontend: { lang: 'en' } };
    await mkdir(join(root, packId));
    await writeFile(path, JSON.stringify({ ...canonical, retired: true,
      frontend: { ...canonical.frontend, retired: true },
      files: canonical.files.map((file) => ({ ...file, retired: true })) }));
    expect(await readInstalledVoiceModelPackManifest({ packsRootDir: root, packId })).toEqual(canonical);
    await writeFile(path, JSON.stringify({ ...canonical, frontend: { lang: 12 } }));
    expect(await readInstalledVoiceModelPackManifest({ packsRootDir: root, packId })).toBeNull();
  });

  it('rejects pack ids that attempt to escape packsRootDir via path traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-voice-packid-'));
    const packsRootDir = join(root, 'packs');
    const outsideDir = join(root, 'outside');
    await mkdir(packsRootDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const canaryPath = join(outsideDir, 'canary.txt');
    await writeFile(canaryPath, 'still-here', 'utf8');

    await expect(removeInstalledVoiceModelPack({
      packsRootDir,
      packId: '../outside',
    })).rejects.toThrow('voice_inference_invalid_pack_id');

    await expect(readFile(canaryPath, 'utf8')).resolves.toBe('still-here');
  });
});

describe('voiceModelPackInstaller download validation', () => {
  it('removes the live pack and exact retained resumable scratch through the existing remove owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-voice-pack-remove-'));
    const packId = 'discard-me';
    await mkdir(join(root, packId), { recursive: true });
    await mkdir(join(root, `.${packId}.scratch`), { recursive: true });
    await writeFile(join(root, `.${packId}.scratch`, 'partial.bin'), Buffer.from([1, 2, 3]));

    await removeInstalledVoiceModelPack({ packsRootDir: root, packId });

    await expect(stat(join(root, packId))).rejects.toThrow();
    await expect(stat(join(root, `.${packId}.scratch`))).rejects.toThrow();
  });
  it('rejects downloads whose actual size does not match the manifest sizeBytes', async () => {
    const http = await import('node:http');
    const { createHash } = await import('node:crypto');
    const root = await mkdtemp(join(tmpdir(), 'happier-voice-pack-download-'));
    const packsRootDir = join(root, 'packs');
    await mkdir(packsRootDir, { recursive: true });

    const expectedBytes = Buffer.from('a'); // 1 byte
    const expectedSha = createHash('sha256').update(expectedBytes).digest('hex');
    const actualBytes = Buffer.from('aa'); // 2 bytes

    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.url === '/file.bin') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(actualBytes);
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('server_failed_to_bind');
    }

    const fileUrl = `http://127.0.0.1:${address.port}/file.bin`;

    await expect(installVoiceModelPack({
      packsRootDir,
      manifest: {
        packId: 'example-pack',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: 'v1',
        files: [
          {
            path: 'file.bin',
            url: fileUrl,
            sha256: expectedSha,
            sizeBytes: 1,
          },
        ],
      } as any,
    })).rejects.toThrow('model_pack_size_mismatch');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('fetchVoiceModelPackManifest URL policy (LB-M1)', () => {
  it('fetches a manifest through a server-issued signed HTTPS redirect without retaining its query', async () => {
    const packId = 'signed-redirect-pack';
    const manifest = manifestFixture(packId);
    const tls = await createEphemeralTlsServerFixture();
    const ca = await readFile(tls.caCertificatePath);
    let signedUrl = '';
    const received: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const server = createHttpsServer({ key: await readFile(tls.privateKeyPath),
      cert: await readFile(tls.leafCertificatePath) }, (request, response) => {
      received.push({ url: request.url, authorization: request.headers.authorization });
      if (request.url === '/manifest.json') {
        response.writeHead(302, { location: signedUrl });
        response.end();
      } else {
        response.end(JSON.stringify(manifest));
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server_failed_to_bind');
      signedUrl = `https://127.0.0.1:${address.port}/asset.json?sig=transport-secret&jwt=transport-token`;
      // HTTPS system boundary: add the fixture CA while retaining real TLS and ordinary DNS.
      const transport: NodeModelPackDownloadTransport = (input) => new Promise((resolve, reject) => {
        const request = httpsRequest(input.url, { ca, headers: input.headers, signal: input.signal }, (response) => {
          const iterator = response[Symbol.asyncIterator]();
          resolve({
            status: response.statusCode ?? 0,
            headers: { location: response.headers.location },
            contentLength: null,
            read: async () => {
              const next = await iterator.next();
              return next.done ? null : next.value;
            },
            cancel: () => { response.destroy(); },
          });
        });
        request.once('error', reject);
        request.end();
      });
      const result = await fetchVoiceModelPackManifest({ packId,
        env: { HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({ [packId]: `https://localhost:${address.port}/manifest.json` }) },
        network: { transport },
      });
      expect(result).toEqual(manifest);
      expect(JSON.stringify(result)).not.toContain('transport-secret');
      expect(received).toEqual([
        { url: '/manifest.json', authorization: undefined },
        { url: '/asset.json?sig=transport-secret&jwt=transport-token', authorization: undefined },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await tls.cleanup();
    }
  });

  it('still refuses configured signed manifest and asset URLs before using them', async () => {
    const packId = 'configured-credentials-pack';
    const transport = vi.fn<NodeModelPackDownloadTransport>();
    await expect(fetchVoiceModelPackManifest({
      packId,
      env: { HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({ [packId]: 'https://models.example/manifest.json?jwt=configured-secret' }) },
      network: { transport: transport },
    })).rejects.toThrow('model_pack_url_credentials_forbidden');
    expect(transport).not.toHaveBeenCalled();

    const manifest = manifestFixture(packId);
    manifest.files[0].url += '?api_key=configured-secret';
    let sent = false;
    transport.mockResolvedValue({ status: 200, headers: {}, contentLength: null,
      read: async () => { if (sent) return null; sent = true; return Buffer.from(JSON.stringify(manifest)); },
      cancel: () => undefined });
    await expect(fetchVoiceModelPackManifest({
      packId,
      env: { HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({ [packId]: 'https://models.example/manifest.json' }) },
      network: { transport: transport },
    })).rejects.toThrow('model_pack_url_credentials_forbidden');
  });

  it('rejects an insecure (non-loopback http) manifest URL before any network fetch', async () => {
    // Route the manifest map to an http:// host that is NOT loopback. The daemon
    // url policy permits http only on loopback, so this must be refused by the
    // shared url policy owner — not silently fetched.
    await expect(
      fetchVoiceModelPackManifest({
        packId: 'evil-pack',
        env: { HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({ 'evil-pack': 'http://evil.example.com/manifest.json' }) },
      }),
    ).rejects.toThrow('model_pack_url_insecure_scheme');
  });

  it('allows an https manifest URL through the policy', async () => {
    const http = await import('node:http');
    const { createHash } = await import('node:crypto');

    const fileBytes = Buffer.from('hello');
    const fileSha = createHash('sha256').update(fileBytes).digest('hex');

    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/manifest.json')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            packId: 'ok-pack',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: 'v1',
            files: [{ path: 'file.bin', url: 'https://example.com/file.bin', sha256: fileSha, sizeBytes: fileBytes.length }],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('server_failed_to_bind');
    }

    try {
      // Loopback http is permitted by DAEMON_URL_POLICY (dev/self-hosted asset server).
      const manifest = await fetchVoiceModelPackManifest({
        packId: 'ok-pack',
        env: { HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({ 'ok-pack': `http://127.0.0.1:${address.port}/manifest.json` }) },
      });
      expect(manifest.packId).toBe('ok-pack');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fetches a manifest from an HTTPS LAN redirect', async () => {
    const packId = 'private-redirect-pack';
    const transport = vi.fn<NodeModelPackDownloadTransport>().mockResolvedValueOnce({
      status: 302,
      headers: { location: 'https://192.168.1.2/manifest.json' },
      contentLength: 0,
      read: async () => null,
      cancel: () => undefined,
    }).mockImplementationOnce(async () => {
      let sent = false;
      return { status: 200, headers: {}, contentLength: null,
        read: async () => { if (sent) return null; sent = true; return Buffer.from(JSON.stringify(manifestFixture(packId))); },
        cancel: () => undefined };
    });
    const input = {
      packId,
      env: {
        HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({
          [packId]: 'https://models.example/manifest.json',
        }),
      },
      network: {
        transport: transport,
      },
    };

    await withLegacyFetchFixture(packId, async (legacyFetch) => {
      await expect(fetchVoiceModelPackManifest(input))
        .resolves.toMatchObject({ packId });
      expect(transport).toHaveBeenCalledTimes(2);
      expect(legacyFetch).not.toHaveBeenCalled();
    });
  });

  it('preserves the manifest-specific non-success response error contract', async () => {
    const packId = 'missing-manifest-pack';
    const transport = vi.fn<NodeModelPackDownloadTransport>().mockResolvedValue({
      status: 404,
      headers: {},
      contentLength: 0,
      read: async () => null,
      cancel: () => undefined,
    });
    const input = {
      packId,
      env: {
        HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({
          [packId]: 'https://models.example/manifest.json',
        }),
      },
      network: {
        transport: transport,
      },
    };

    await expect(fetchVoiceModelPackManifest(input))
      .rejects.toThrow('model_pack_manifest_download_failed:404');
  });

  it('bounds the manifest response body before JSON parsing', async () => {
    const packId = 'oversized-manifest-pack';
    const transport = vi.fn<NodeModelPackDownloadTransport>().mockResolvedValue({
      status: 200,
      headers: {},
      contentLength: null,
      read: (() => {
        let sent = false;
        return async () => {
          if (sent) return null;
          sent = true;
          return new Uint8Array(8 * 1024 * 1024);
        };
      })(),
      cancel: () => undefined,
    });
    const input = {
      packId,
      env: {
        HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({
          [packId]: 'https://models.example/manifest.json',
        }),
      },
      network: {
        transport: transport,
      },
    };

    await withLegacyFetchFixture(packId, async (legacyFetch) => {
      await expect(fetchVoiceModelPackManifest(input))
        .rejects.toThrow('model_pack_manifest_response_too_large');
      expect(legacyFetch).not.toHaveBeenCalled();
    });
  });

  it('uses the shared cancellable download transport for a public HTTPS manifest', async () => {
    const packId = 'public-https-pack';
    const body = Buffer.from(JSON.stringify(manifestFixture(packId)), 'utf8');
    const transport = vi.fn<NodeModelPackDownloadTransport>(async () => {
      let sent = false;
      return {
        status: 200,
        headers: { 'content-length': String(body.byteLength) },
        contentLength: body.byteLength,
        read: async () => {
          if (sent) return null;
          sent = true;
          return body;
        },
        cancel: () => undefined,
      };
    });
    const input = {
      packId,
      env: {
        HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({
          [packId]: 'https://models.example/manifest.json',
        }),
      },
      network: {
        transport: transport,
      },
    };

    await withLegacyFetchFixture(packId, async (legacyFetch) => {
      await expect(fetchVoiceModelPackManifest(input)).resolves.toMatchObject({ packId });
      expect(transport).toHaveBeenCalledOnce();
      expect(legacyFetch).not.toHaveBeenCalled();
    });
  });
});
