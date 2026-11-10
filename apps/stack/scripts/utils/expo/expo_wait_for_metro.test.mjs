import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { looksLikeExpoMetro, waitForExpoMetroRunning } from './expo.mjs';

test('Metro status permits a loaded response beyond the private 800ms probe cutoff', async () => {
  const server = createServer((_req, res) => {
    setTimeout(() => res.end('packager-status:running'), 950);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal(await looksLikeExpoMetro({ port: server.address().port }), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('waitForExpoMetroRunning waits until Metro reports running', async () => {
  let probes = 0;
  const result = await waitForExpoMetroRunning({
    port: 8081,
  }, {
    looksLikeExpoMetroImpl: async () => {
      probes += 1;
      return probes >= 3;
    },
    delayImpl: async () => {},
    nowMsImpl: (() => {
      let now = 0;
      return () => {
        now += 10;
        return now;
      };
    })(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.probes, 3);
});

test('waitForExpoMetroRunning returns a non-ok result when the timeout elapses', async () => {
  const result = await waitForExpoMetroRunning({
    port: 8081,
    timeoutMs: 25,
    intervalMs: 10,
    continueOnTimeout: false,
  }, {
    looksLikeExpoMetroImpl: async () => false,
    delayImpl: async () => {},
    nowMsImpl: (() => {
      let now = 0;
      return () => {
        now += 10;
        return now;
      };
    })(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.probes >= 2, true);
});

test('waitForExpoMetroRunning treats attended TUI deadlines as checkpoints until its caller cancels', async () => {
  let probes = 0;
  let checkpoints = 0;
  const result = await waitForExpoMetroRunning({
    port: 8081,
    timeoutMs: 25,
    intervalMs: 10,
    env: { HAPPIER_STACK_TUI: '1' },
    onTimeoutCheckpoint: () => { checkpoints += 1; },
  }, {
    looksLikeExpoMetroImpl: async () => {
      probes += 1;
      return probes >= 5;
    },
    delayImpl: async () => {},
    nowMsImpl: (() => {
      let now = 0;
      return () => { now += 10; return now; };
    })(),
  });

  assert.equal(result.ok, true);
  assert.equal(checkpoints >= 1, true);
});

test('waitForExpoMetroRunning owns its default polling delay', async () => {
  let probes = 0;
  const result = await waitForExpoMetroRunning({
    port: 8081,
    timeoutMs: 100,
    intervalMs: 1,
  }, {
    looksLikeExpoMetroImpl: async () => {
      probes += 1;
      return probes >= 2;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.probes, 2);
});

test('waitForExpoMetroRunning stops before probing when its caller cancels readiness', async () => {
  const controller = new AbortController();
  controller.abort(new Error('replacement lifecycle won'));
  let probes = 0;
  const result = await waitForExpoMetroRunning({
    port: 8081,
    timeoutMs: 100,
    intervalMs: 1,
    signal: controller.signal,
  }, {
    looksLikeExpoMetroImpl: async () => {
      probes += 1;
      return false;
    },
    delayImpl: async () => {},
    nowMsImpl: (() => {
      let now = 0;
      return () => {
        now += 10;
        return now;
      };
    })(),
  });

  assert.deepEqual(result, { ok: false, reason: 'aborted', probes: 0 });
  assert.equal(probes, 0);
});

async function serve(t, handler, host = '127.0.0.1') {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, host, resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

test('Metro readiness cancellation wins while an otherwise healthy response body is pending', async t => {
  const controller = new AbortController();
  const port = await serve(t, (_request, response) => {
    response.writeHead(200, { 'x-react-native-project-root': '/fixture/project' });
    response.write('packager-status:');
    controller.abort(new Error('target closed'));
  });
  assert.deepEqual(await waitForExpoMetroRunning({ port, signal: controller.signal }),
    { ok: false, reason: 'aborted', probes: 1 });
});

test('looksLikeExpoMetro falls back to the root document when /status is unavailable', async t => {
  const port = await serve(t, (request, response) => {
    if (request.url === '/status') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><html><div id="root"></div></html>');
  });
  assert.equal(await looksLikeExpoMetro({ port, timeoutMs: 1000 }), true);
});

test('looksLikeExpoMetro falls back to IPv6 localhost', async t => {
  const port = await serve(t, (_request, response) => response.end('packager-status:running'), '::1');
  assert.equal(await looksLikeExpoMetro({ port, timeoutMs: 1000 }), true);
});

test('looksLikeExpoMetro accepts the Expo project-root header even if the body stalls', async t => {
  const port = await serve(t, (_request, response) => {
    response.writeHead(200, { 'x-react-native-project-root': '/fixture/project' });
    response.write('packager-status:');
  });
  assert.equal(await looksLikeExpoMetro({ port, timeoutMs: 50 }), true);
});
