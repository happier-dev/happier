import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { startTcpForwarder, stopTcpForwarder } from './tcp_forward.mjs';

async function startEchoServer(label) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('data', (chunk) => socket.write(`${label}:${chunk.toString()}`));
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  return {
    port: server.address().port,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function connect(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function writeRead(socket, text) {
  return new Promise((resolve, reject) => {
    socket.once('data', (chunk) => resolve(chunk.toString()));
    socket.once('error', reject);
    socket.write(text);
  });
}

async function waitClosed(socket) {
  if (socket.destroyed) return;
  await new Promise((resolve) => socket.once('close', resolve));
}

test('upstream flip affects new connections and drain closes active sockets', { timeout: 5000 }, async () => {
  const oldUpstream = await startEchoServer('old');
  const newUpstream = await startEchoServer('new');
  const sockets = [];
  let forwarder = null;
  try {
    forwarder = await startTcpForwarder({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: oldUpstream.port,
      label: 'tcp-forward-test',
    });

    assert.equal(typeof forwarder.server.setUpstream, 'function');
    assert.equal(typeof forwarder.server.closeIdleOrAllConnectionsAfterGrace, 'function');
    assert.equal(typeof forwarder.server.getActiveConnectionCount, 'function');

    const existing = await connect(forwarder.port);
    sockets.push(existing);
    assert.equal(await writeRead(existing, 'one'), 'old:one');

    forwarder.server.setUpstream({ targetHost: '127.0.0.1', targetPort: newUpstream.port });
    const fresh = await connect(forwarder.port);
    sockets.push(fresh);
    assert.equal(await writeRead(fresh, 'two'), 'new:two');
    assert.equal(await writeRead(existing, 'three'), 'old:three');

    await Promise.all([
      forwarder.server.closeIdleOrAllConnectionsAfterGrace({ graceMs: 0 }),
      waitClosed(existing),
      waitClosed(fresh),
    ]);
    assert.equal(forwarder.server.getActiveConnectionCount(), 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await stopTcpForwarder(forwarder?.server, 'tcp-forward-test');
    await oldUpstream.stop();
    await newUpstream.stop();
  }
});

test('targeted drain closes only connections bound to the selected upstream', { timeout: 5000 }, async () => {
  const oldUpstream = await startEchoServer('old');
  const newUpstream = await startEchoServer('new');
  const sockets = [];
  let forwarder = null;
  try {
    forwarder = await startTcpForwarder({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: oldUpstream.port,
      label: 'tcp-forward-target-drain-test',
    });

    assert.equal(typeof forwarder.server.closeConnectionsAfterGrace, 'function');

    const existing = await connect(forwarder.port);
    sockets.push(existing);
    assert.equal(await writeRead(existing, 'one'), 'old:one');

    forwarder.server.setUpstream({ targetHost: '127.0.0.1', targetPort: newUpstream.port });
    const fresh = await connect(forwarder.port);
    sockets.push(fresh);
    assert.equal(await writeRead(fresh, 'two'), 'new:two');

    await Promise.all([
      forwarder.server.closeConnectionsAfterGrace({
        graceMs: 0,
        target: { targetHost: '127.0.0.1', targetPort: oldUpstream.port },
      }),
      waitClosed(existing),
    ]);

    assert.equal(await writeRead(fresh, 'three'), 'new:three');
    assert.equal(forwarder.server.getActiveConnectionCount(), 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await stopTcpForwarder(forwarder?.server, 'tcp-forward-target-drain-test');
    await oldUpstream.stop();
    await newUpstream.stop();
  }
});
