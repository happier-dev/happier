import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

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
});
