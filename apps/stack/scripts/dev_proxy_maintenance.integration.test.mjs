import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { startDevProxy } from './utils/dev/devProxy.mjs';

function request(port, path = '/id') {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: { Connection: 'close' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.once('error', reject);
  });
}

async function startBackend(label) {
  const openResponses = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/stream') {
      openResponses.add(res);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        Connection: 'keep-alive',
      });
      res.write(`${label}:stream\n`);
      res.once('close', () => openResponses.delete(res));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      Connection: 'close',
    });
    res.end(`${label}\n`);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) throw new Error(`failed to start ${label} backend`);

  return {
    port,
    writeToOpenStreams(chunk) {
      for (const res of openResponses) {
        res.write(chunk);
      }
    },
    async stop() {
      for (const res of openResponses) res.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function readNextChunk(socket) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      cleanup();
      resolve(chunk.toString());
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.once('data', onData);
    socket.once('error', onError);
  });
}

async function openStreamingRequest(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.write('GET /stream HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
  const data = await readNextChunk(socket);
  return { socket, data };
}

async function waitForSocketClosed(socket) {
  if (!socket || socket.destroyed) return;
  await new Promise((resolve) => socket.once('close', resolve));
}

test('dev proxy keeps the stable port available through maintenance and planned reconnect drain', { timeout: 10000 }, async () => {
  const oldBackend = await startBackend('old');
  const newBackend = await startBackend('new');
  let proxy;
  let oldStream;
  let newStream;

  try {
    proxy = await startDevProxy({
      stableHost: '127.0.0.1',
      stablePort: 0,
      targetHost: '127.0.0.1',
      targetPort: oldBackend.port,
      label: 'dev-proxy-maintenance-integration',
    });

    assert.equal((await request(proxy.port)).body, 'old\n');

    oldStream = await openStreamingRequest(proxy.port);
    assert.match(oldStream.data, /old:stream/);

    await proxy.enterMaintenance({
      retryAfterMs: 1500,
      message: 'Server reload in progress',
    });

    const maintenance = await request(proxy.port);
    assert.equal(maintenance.statusCode, 503);
    assert.equal(maintenance.headers['retry-after'], '2');
    assert.equal(maintenance.body, 'Server reload in progress\n');

    proxy.flipUpstream({ targetPort: newBackend.port });

    const afterFlip = await request(proxy.port);
    assert.equal(afterFlip.statusCode, 200);
    assert.equal(afterFlip.body, 'new\n');

    newStream = await openStreamingRequest(proxy.port);
    assert.match(newStream.data, /new:stream/);

    await proxy.drainConnections({
      graceMs: 10,
      targetHost: '127.0.0.1',
      targetPort: oldBackend.port,
    });
    await waitForSocketClosed(oldStream.socket);

    newBackend.writeToOpenStreams('new:after-drain\n');
    assert.match(await readNextChunk(newStream.socket), /new:after-drain/);
    assert.equal(newStream.socket.destroyed, false);

    const afterDrain = await request(proxy.port);
    assert.equal(afterDrain.statusCode, 200);
    assert.equal(afterDrain.body, 'new\n');
  } finally {
    oldStream?.socket?.destroy();
    newStream?.socket?.destroy();
    await proxy?.stop();
    await oldBackend.stop();
    await newBackend.stop();
  }
});
