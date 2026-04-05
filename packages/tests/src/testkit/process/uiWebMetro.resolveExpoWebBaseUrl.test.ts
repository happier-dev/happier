import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { __testables } from './uiWebMetro';

describe('uiWebMetro resolveExpoWebBaseUrl', () => {
  it('waits for the dev server url to appear in stdout and then resolves it', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
        return;
      }
      if (req.url === '/app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('console.log("ok");');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr !== 'object') {
      server.close();
      throw new Error('missing server address');
    }

    const port = addr.port;
    const baseUrl = `http://localhost:${port}`;

    const dir = await mkdtemp(join(tmpdir(), 'happier-uiwebmetro-'));
    const stdoutPath = join(dir, 'ui.web.stdout.log');
    await writeFile(stdoutPath, '', 'utf8');

    setTimeout(() => {
      void writeFile(stdoutPath, `Waiting on ${baseUrl}\n`, 'utf8');
    }, 40);

    const resolved = await __testables.resolveExpoWebBaseUrl({
      stdoutPath,
      timeoutMs: 1000,
      expectedPort: 55555,
      env: { NODE_ENV: 'test' },
    });

    expect(resolved.baseUrl).toBe(baseUrl);
    expect(resolved.hasScriptTags).toBe(true);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('does not return the advertised expected port until that port serves a live entry page', async () => {
    const port = await reserveAvailablePort();
    const baseUrl = `http://localhost:${port}`;

    const server = createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
        return;
      }
      if (req.url === '/app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('console.log("ok");');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const dir = await mkdtemp(join(tmpdir(), 'happier-uiwebmetro-'));
    const stdoutPath = join(dir, 'ui.web.stdout.log');
    await writeFile(stdoutPath, `Waiting on ${baseUrl}\n`, 'utf8');

    const startedAtMs = Date.now();
    const startServer = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
      }, 200);
    });

    const resolved = await __testables.resolveExpoWebBaseUrl({
      stdoutPath,
      timeoutMs: 1_000,
      expectedPort: port,
      env: {
        NODE_ENV: 'test',
        HAPPIER_E2E_UI_WEB_ENTRY_PROBE_TIMEOUT_MS: '25',
      },
    });

    const elapsedMs = Date.now() - startedAtMs;
    expect(elapsedMs).toBeGreaterThanOrEqual(180);
    expect(new URL(resolved.baseUrl).port).toBe(String(port));
    expect(resolved.hasScriptTags).toBe(true);

    await startServer;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }, 10_000);
});
