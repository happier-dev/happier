import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isStateProcessRunning } from './expo.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('isStateProcessRunning does not treat occupied port as running when /status is not Metro', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-state-running-'));
  const srv = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not-metro');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  try {
    await listen(srv);
    const addr = srv.address();
    assert.ok(addr && typeof addr === 'object' && typeof addr.port === 'number', 'expected server to be listening');
    const port = addr.port;

    const statePath = join(tmp, 'expo.state.json');
    await writeFile(statePath, JSON.stringify({ pid: 999999, port }, null, 2) + '\n', 'utf-8');

    const res = await isStateProcessRunning(statePath);
    assert.equal(res.running, false);
  } finally {
    await close(srv).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
});

