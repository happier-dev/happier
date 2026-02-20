import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from 'node:http';

import { pickMetroPort } from './metro_ports.mjs';

function listenEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('failed to allocate port')));
        return;
      }
      const port = Number(addr.port);
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

test('pickMetroPort does not reuse forced port when it is reserved', async () => {
  const forced = await listenEphemeralPort();
  const picked = await pickMetroPort({
    startPort: forced,
    forcedPort: String(forced),
    reservedPorts: new Set([forced]),
    host: '127.0.0.1',
  });
  assert.notEqual(picked, forced);
});

test('pickMetroPort does not reuse forced port when it is occupied by a non-metro process', async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/status') {
      res.statusCode = 200;
      res.end('nope');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolvePromise) => srv.listen(0, '127.0.0.1', resolvePromise));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error('failed to bind test server');
  try {
    const picked = await pickMetroPort({
      startPort: port,
      forcedPort: String(port),
      reservedPorts: new Set(),
      host: '127.0.0.1',
    });
    assert.notEqual(picked, port);
  } finally {
    await new Promise((resolvePromise) => srv.close(resolvePromise));
  }
});

test('pickMetroPort does not reuse forced port when it is occupied by a Metro-like /status responder', async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/status') {
      res.statusCode = 200;
      res.end('packager-status:running');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolvePromise) => srv.listen(0, '127.0.0.1', resolvePromise));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error('failed to bind test server');
  try {
    const picked = await pickMetroPort({
      startPort: port,
      forcedPort: String(port),
      reservedPorts: new Set(),
      host: '127.0.0.1',
    });
    assert.notEqual(picked, port);
  } finally {
    await new Promise((resolvePromise) => srv.close(resolvePromise));
  }
});
