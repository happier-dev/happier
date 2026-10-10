import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import { downloadRemoteFileWithLimits, fetchRemoteJsonWithLimits, resolvePluginRemoteArchiveMaxBytes, resolvePluginRemoteCatalogMaxBytes } from './fetch';

const servers: Server[] = [];
const tempDirs: string[] = [];
const archiveEnv = createEnvKeyScope(['HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES', 'HAPPIER_PLUGIN_REMOTE_CATALOG_MAX_BYTES']);

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  archiveEnv.restore();
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(tempDirs.splice(0).map(async (dir) => await removeTempDir(dir)));
});

describe('remote plugin body budget', () => {
  it('reads a valid catalog beyond the former implicit JSON ceiling without an operator budget', async () => {
    archiveEnv.patch({ HAPPIER_PLUGIN_REMOTE_CATALOG_MAX_BYTES: undefined });
    const padding = 'x'.repeat(2 * 1024 * 1024);
    await expect(fetchRemoteJsonWithLimits({
      url: 'https://catalog.example.test/index.json', errorLabel: 'Marketplace catalog',
      network: {
        resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async () => new Response(JSON.stringify({ padding })),
      },
    })).resolves.toEqual({ padding });
  });

  it('streams a valid archive beyond the former implicit byte ceiling', async () => {
    archiveEnv.patch({ HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES: undefined });
    const dir = await createTempDir('happier-remote-streamed-archive-');
    tempDirs.push(dir);
    const destinationPath = join(dir, 'archive.tgz');
    const chunk = new Uint8Array(1024 * 1024);
    let remainingChunks = 257;
    await downloadRemoteFileWithLimits({
      url: 'https://archives.example.test/plugin.tgz', destinationPath, errorLabel: 'Remote plugin archive',
      network: {
        resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async () => new Response(new ReadableStream({
          pull(controller) {
            if (remainingChunks-- > 0) controller.enqueue(chunk);
            else controller.close();
          },
        })),
      },
    });
    expect((await stat(destinationPath)).size).toBe(257 * chunk.byteLength);
  });

  it('honors an explicit archive storage budget without the former one-GiB clamp', () => {
    archiveEnv.patch({ HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES: String(2 * 1024 * 1024 * 1024) });
    expect(resolvePluginRemoteArchiveMaxBytes()).toBe(2 * 1024 * 1024 * 1024);
  });

  it('honors an explicit catalog buffer budget without the former 32-MiB clamp', () => {
    archiveEnv.patch({ HAPPIER_PLUGIN_REMOTE_CATALOG_MAX_BYTES: String(64 * 1024 * 1024) });
    expect(resolvePluginRemoteCatalogMaxBytes()).toBe(64 * 1024 * 1024);
  });

  it('accepts discovery that settles after the former acquisition cutoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let resolveDns!: (answers: readonly { address: string; family: 4 }[]) => void;
    const operation = fetchRemoteJsonWithLimits({
      url: 'https://catalog.example.test/index.json', errorLabel: 'Marketplace catalog',
      network: {
        resolveAddresses: () => new Promise((resolve) => { resolveDns = resolve; }),
        fetchImpl: async () => new Response('{"ok":true}'),
      },
    });
    let settled = false;
    void operation.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(300_001);
    expect(settled).toBe(false);
    resolveDns([{ address: '93.184.216.34', family: 4 }]);
    await expect(operation).resolves.toEqual({ ok: true });
  });

  it('cancels the exact pending DNS acquisition before opening a connection', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response('{}'));
    let resolveDns!: (answers: readonly { address: string; family: 4 }[]) => void;
    const operation = fetchRemoteJsonWithLimits({
      url: 'https://catalog.example.test/index.json', errorLabel: 'Marketplace catalog', signal: controller.signal,
      network: { resolveAddresses: () => new Promise((resolve) => { resolveDns = resolve; }), fetchImpl },
    });
    const rejected = expect(operation).rejects.toThrow('discovery cancelled');
    controller.abort(new Error('discovery cancelled'));
    await rejected;
    resolveDns([{ address: '93.184.216.34', family: 4 }]);
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels a pending body and keeps genuine transport errors', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const operation = fetchRemoteJsonWithLimits({
      url: 'https://catalog.example.test/index.json', errorLabel: 'Marketplace catalog', signal: controller.signal,
      network: {
        resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rejected = expect(operation).rejects.toThrow('body cancelled');
    controller.abort(new Error('body cancelled'));
    await rejected;
    expect(cancelled).toBe(true);
    await expect(fetchRemoteJsonWithLimits({
      url: 'https://catalog.example.test/index.json', errorLabel: 'Marketplace catalog',
      network: {
        resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async () => { throw new Error('connection refused'); },
      },
    })).rejects.toThrow('connection refused');
  });

  it('stops a chunked archive that never declares its length once the budget is spent', async () => {
    const port = await startServer((_request, response) => {
      // No content-length: the byte budget is the only bound on this body.
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let chunk = 0; chunk < 64; chunk += 1) response.write('x'.repeat(1024));
      response.end();
    });
    const dir = await createTempDir('happier-remote-body-budget-');
    tempDirs.push(dir);
    const destinationPath = join(dir, 'archive.tgz');

    await expect(downloadRemoteFileWithLimits({
      url: `http://127.0.0.1:${port}/plugin.tgz`,
      destinationPath,
      maxBytes: 2048,
      errorLabel: 'Remote plugin archive',
    })).rejects.toThrow('Remote plugin archive exceeds the configured size limit (2048 bytes)');

    const written = await readFile(destinationPath).catch(() => Buffer.alloc(0));
    expect(written.byteLength).toBeLessThanOrEqual(2048 + 1024);
  });

  it('writes a chunked archive that stays inside its budget', async () => {
    const port = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write('archive-');
      response.end('bytes');
    });
    const dir = await createTempDir('happier-remote-body-budget-');
    tempDirs.push(dir);
    const destinationPath = join(dir, 'archive.tgz');

    await downloadRemoteFileWithLimits({
      url: `http://127.0.0.1:${port}/plugin.tgz`,
      destinationPath,
      maxBytes: 2048,
      errorLabel: 'Remote plugin archive',
    });

    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('archive-bytes');
  });

  it('applies the same budget to a chunked catalog document', async () => {
    const port = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('[');
      for (let chunk = 0; chunk < 64; chunk += 1) response.write(`"${'x'.repeat(1022)}",`);
      response.end('""]');
    });

    await expect(fetchRemoteJsonWithLimits({
      url: `http://127.0.0.1:${port}/catalog.json`,
      maxBytes: 2048,
      errorLabel: 'Marketplace catalog',
    })).rejects.toThrow('Marketplace catalog exceeds the configured size limit (2048 bytes)');
  });
});
