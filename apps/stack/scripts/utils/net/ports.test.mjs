import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { isTcpPortFree } from './ports.mjs';

async function getUnusedLoopbackPort() {
  const srv = net.createServer();
  await new Promise((resolvePromise, reject) => {
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port: 0 }, () => resolvePromise());
  });
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error('failed to allocate a free TCP port');
  await new Promise((resolvePromise) => srv.close(resolvePromise));
  return port;
}

test(
  'isTcpPortFree resolves (fails closed) when the bind-probe cannot close cleanly',
  { timeout: 2000 },
  async (t) => {
    const port = await getUnusedLoopbackPort();

    t.mock.method(net, 'createServer', () => {
      return {
        unref() {},
        on() {
          return this;
        },
        listen(_opts, cb) {
          queueMicrotask(cb);
          return this;
        },
        close() {
          // Simulate a broken/never-closing server.close callback.
        },
      };
    });

    const out = await isTcpPortFree(port, { host: '127.0.0.1', timeoutMs: 25 });
    assert.equal(out, false);
  }
);
