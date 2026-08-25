import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { downloadRemoteFileWithLimits, fetchRemoteJsonWithLimits } from './fetch';

const servers: Server[] = [];
const tempDirs: string[] = [];

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(tempDirs.splice(0).map(async (dir) => await removeTempDir(dir)));
});

describe('remote plugin body budget', () => {
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
