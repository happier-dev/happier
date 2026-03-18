import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { isTcpPortFree, pickNextFreeTcpPort } from './ports.mjs';

function listenOnPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => resolve(server));
  });
}

test('isTcpPortFree reports a listening port as occupied', async () => {
  const server = await listenOnPort(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object', 'expected a listening TCP server');
    assert.equal(await isTcpPortFree(address.port, { host: '127.0.0.1' }), false);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test('pickNextFreeTcpPort skips reserved and occupied ports', async () => {
  const server = await listenOnPort(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object', 'expected a listening TCP server');
    const reserved = new Set([address.port, address.port + 1]);
    const picked = await pickNextFreeTcpPort(address.port, {
      reservedPorts: reserved,
      host: '127.0.0.1',
      tries: 25,
    });
    assert.ok(picked > address.port, 'expected a port greater than the occupied start port');
    assert.equal(reserved.has(picked), false);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});
