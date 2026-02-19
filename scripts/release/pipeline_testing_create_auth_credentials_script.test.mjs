import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'testing', 'create-auth-credentials.mjs');

/**
 * @param {{ token: string }} opts
 * @returns {Promise<{ url: string; close: () => Promise<void>; requests: any[] }>}
 */
function startAuthServer({ token }) {
  return new Promise((resolvePromise) => {
    /** @type {any[]} */
    const requests = [];

    /** @type {Set<import('node:net').Socket>} */
    const sockets = new Set();

    const server = http.createServer((req, res) => {
      const { method, url } = req;
      if (method !== 'POST' || url !== '/v1/auth') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        requests.push({ headers: req.headers, body: parsed });
        res.setHeader('content-type', 'application/json');
        res.setHeader('connection', 'close');
        res.end(JSON.stringify({ token }));
      });
    });

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object', 'server should have a bound address');
      const url = `http://127.0.0.1:${address.port}`;

      resolvePromise({
        url,
        requests,
        close: () =>
          new Promise((r) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

/**
 * @param {string[]} args
 * @returns {Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>}
 */
function runScript(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('close', (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

test('create-auth-credentials writes access.key for repo root and server-scoped path', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'happier-auth-creds-'));
  const server = await startAuthServer({ token: 'test-token-123' });

  try {
    const res = await runScript([
      '--server-url',
      server.url,
      '--home-dir',
      homeDir,
      '--secret-base64',
      Buffer.alloc(32, 7).toString('base64'),
    ]);

    assert.equal(res.code, 0, `expected exit 0, got ${res.code} stderr=${res.stderr}`);
    assert.ok(server.requests.length === 1, 'script should call /v1/auth exactly once');
    assert.ok(server.requests[0]?.body?.publicKey, 'request should include publicKey');
    assert.ok(server.requests[0]?.body?.challenge, 'request should include challenge');
    assert.ok(server.requests[0]?.body?.signature, 'request should include signature');

    const rootCredsPath = path.join(homeDir, 'access.key');
    const rootStat = await stat(rootCredsPath);
    assert.equal(rootStat.mode & 0o777, 0o600, 'root access.key should be chmod 600');

    const rootCreds = JSON.parse(await readFile(rootCredsPath, 'utf8'));
    assert.equal(rootCreds.token, 'test-token-123');
    assert.equal(rootCreds.secret, Buffer.alloc(32, 7).toString('base64'));

    const serversDir = path.join(homeDir, 'servers');
    const entries = await readdir(serversDir);
    assert.ok(entries.length >= 1, 'script should create a server-scoped credentials directory');

    const scopedCredsPath = path.join(serversDir, entries[0], 'access.key');
    const scopedStat = await stat(scopedCredsPath);
    assert.equal(scopedStat.mode & 0o777, 0o600, 'scoped access.key should be chmod 600');

    const scopedCreds = JSON.parse(await readFile(scopedCredsPath, 'utf8'));
    assert.equal(scopedCreds.token, 'test-token-123');
    assert.equal(scopedCreds.secret, Buffer.alloc(32, 7).toString('base64'));
  } finally {
    await server.close();
  }
});
