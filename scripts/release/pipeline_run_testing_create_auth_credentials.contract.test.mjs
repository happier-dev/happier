import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>}
 */
function run(args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'), ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
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

test('pipeline run exposes testing-create-auth-credentials and writes access keys', async () => {
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/auth') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        JSON.parse(raw);
      } catch {
        res.statusCode = 400;
        res.end('bad json');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.setHeader('connection', 'close');
      res.end(JSON.stringify({ token: 'test-token' }));
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  await new Promise((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => resolvePromise());
    server.on('error', reject);
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object', 'expected server.address() to be an object');
  const serverUrl = `http://127.0.0.1:${address.port}`;

  const homeDir = await mkdtemp(path.join(tmpdir(), 'happier-auth-'));
  const secretBase64 = Buffer.alloc(32, 7).toString('base64');

  try {
    const res = await run(
      [
        'testing-create-auth-credentials',
        '--server-url',
        serverUrl,
        '--home-dir',
        homeDir,
        '--secret-base64',
        secretBase64,
      ],
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code} stderr=${res.stderr}`);

    const rootKeyPath = join(homeDir, 'access.key');
    const rootData = JSON.parse(await readFile(rootKeyPath, 'utf8'));
    assert.equal(rootData.token, 'test-token');
    assert.equal(rootData.secret, secretBase64);

    assert.ok(typeof rootData === 'object');
    const serversDir = join(homeDir, 'servers');
    const entries = await readdir(serversDir, { withFileTypes: true });
    const serverEntry = entries.find((e) => e.isDirectory());
    assert.ok(serverEntry, 'expected an active server id directory under homeDir/servers');

    const scopedData = JSON.parse(await readFile(join(serversDir, serverEntry.name, 'access.key'), 'utf8'));
    assert.equal(scopedData.token, 'test-token');
    assert.equal(scopedData.secret, secretBase64);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }
});
