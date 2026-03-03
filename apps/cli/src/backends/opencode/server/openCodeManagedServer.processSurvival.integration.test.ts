import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { startManagedOpenCodeServer } from './openCodeManagedServer';

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('startManagedOpenCodeServer', () => {
  it('keeps the managed server alive when it writes to stdout after startup (no SIGPIPE)', async () => {
    const prevCmd = process.env.HAPPIER_OPENCODE_PATH;
    const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-managed-'));
    const scriptPath = join(dir, 'fake-opencode');
    try {
      await writeFile(
        scriptPath,
        `#!/usr/bin/env node
const http = require('http');

function parseArg(name) {
  const prefix = name + '=';
  const raw = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(prefix)) || '';
  return raw.slice(prefix.length);
}

const hostname = parseArg('--hostname') || '127.0.0.1';
const port = Number(parseArg('--port') || '0');
if (!Number.isFinite(port) || port <= 0) {
  console.error('missing --port');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/global/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ healthy: true, version: 'fake' }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, hostname, () => {
  // Keep writing logs after startup; if parent closes stdout, Node will throw EPIPE and exit.
  setInterval(() => {
    process.stdout.write('fake-opencode-log\\n');
  }, 50).unref?.();
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`,
        'utf8',
      );
      await chmod(scriptPath, 0o755);
      process.env.HAPPIER_OPENCODE_PATH = scriptPath;

      const started = await startManagedOpenCodeServer({ timeoutMs: 5_000 });
      expect(started.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(Number.isFinite(started.pid)).toBe(true);
      expect(isPidAlive(started.pid)).toBe(true);

      await new Promise((r) => setTimeout(r, 400));
      expect(isPidAlive(started.pid)).toBe(true);

      started.close();
      await new Promise((r) => setTimeout(r, 250));
      expect(isPidAlive(started.pid)).toBe(false);
    } finally {
      if (prevCmd === undefined) delete process.env.HAPPIER_OPENCODE_PATH;
      else process.env.HAPPIER_OPENCODE_PATH = prevCmd;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

