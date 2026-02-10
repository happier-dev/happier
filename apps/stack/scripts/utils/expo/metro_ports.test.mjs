import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

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
