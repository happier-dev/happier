import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { fetchVoiceModelPackManifest, installVoiceModelPack, removeInstalledVoiceModelPack } from './voiceModelPackInstaller';
import type { PinnedHttpStreamTransport } from '../../network/pinnedHttp';

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

  it('rejects a public hostname whose fresh DNS evidence resolves to cloud metadata before connecting', async () => {
    const packId = 'private-dns-pack';
    const transport = vi.fn<PinnedHttpStreamTransport>();
    const input = {
      packId,
      env: {
        HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({
          [packId]: 'https://models.example/manifest.json',
        }),
      },
      network: {
        resolveAddresses: async () => ['169.254.169.254'],
        pinnedTransport: transport,
      },
    };

    await withLegacyFetchFixture(packId, async (legacyFetch) => {
      await expect(fetchVoiceModelPackManifest(input))
        .rejects.toThrow('model_pack_url_private_destination');
      expect(transport).not.toHaveBeenCalled();
      expect(legacyFetch).not.toHaveBeenCalled();
    });
  });

  it('rejects a redirect to a private literal before opening the redirected socket', async () => {
    const packId = 'private-redirect-pack';
    const transport = vi.fn<PinnedHttpStreamTransport>().mockResolvedValue({
      status: 302,
      headers: { location: 'https://169.254.169.254/latest/meta-data' },
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
        resolveAddresses: async () => ['93.184.216.34'],
        pinnedTransport: transport,
      },
    };

    await withLegacyFetchFixture(packId, async (legacyFetch) => {
      await expect(fetchVoiceModelPackManifest(input))
        .rejects.toThrow('model_pack_url_private_destination');
      expect(transport).toHaveBeenCalledTimes(1);
      expect(legacyFetch).not.toHaveBeenCalled();
    });
  });

  it('preserves the manifest-specific non-success response error contract', async () => {
    const packId = 'missing-manifest-pack';
    const transport = vi.fn<PinnedHttpStreamTransport>().mockResolvedValue({
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
        resolveAddresses: async () => ['93.184.216.34'],
        pinnedTransport: transport,
      },
    };

    await expect(fetchVoiceModelPackManifest(input))
      .rejects.toThrow('model_pack_manifest_download_failed:404');
  });

  it('bounds the manifest response body before JSON parsing', async () => {
    const packId = 'oversized-manifest-pack';
    const transport = vi.fn<PinnedHttpStreamTransport>().mockResolvedValue({
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
        resolveAddresses: async () => ['93.184.216.34'],
        pinnedTransport: transport,
      },
    };

    await withLegacyFetchFixture(packId, async (legacyFetch) => {
      await expect(fetchVoiceModelPackManifest(input))
        .rejects.toThrow('model_pack_manifest_response_too_large');
      expect(legacyFetch).not.toHaveBeenCalled();
    });
  });

  it('uses the bounded pinned transport timeout for a legitimate public HTTPS manifest', async () => {
    const packId = 'public-https-pack';
    const body = Buffer.from(JSON.stringify(manifestFixture(packId)), 'utf8');
    const transport = vi.fn<PinnedHttpStreamTransport>(async (request) => {
      if (request.wallTimeMs === undefined || request.idleTimeMs === undefined) {
        throw new Error('expected bounded manifest transport timeouts');
      }
      expect(request.wallTimeMs).toBeGreaterThan(0);
      expect(request.wallTimeMs).toBeLessThanOrEqual(60_000);
      expect(request.idleTimeMs).toBeGreaterThan(0);
      expect(request.idleTimeMs).toBeLessThanOrEqual(request.wallTimeMs);
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
        resolveAddresses: async () => ['93.184.216.34'],
        pinnedTransport: transport,
      },
    };

    await withLegacyFetchFixture(packId, async (legacyFetch) => {
      await expect(fetchVoiceModelPackManifest(input)).resolves.toMatchObject({ packId });
      expect(transport).toHaveBeenCalledOnce();
      expect(legacyFetch).not.toHaveBeenCalled();
    });
  });
});
