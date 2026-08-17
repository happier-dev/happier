import test from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeExpoMetro, waitForExpoMetroRunning } from './expo.mjs';

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

test('looksLikeExpoMetro falls back to the root document when /status is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];

  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith('/status')) {
      throw new Error('status unavailable');
    }

    return new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
    });
  };

  try {
    const ok = await looksLikeExpoMetro({ port: 8081, timeoutMs: 25 });
    assert.equal(ok, true);
    assert.deepEqual(urls, [
      'http://127.0.0.1:8081/status',
      'http://localhost:8081/status',
      'http://[::1]:8081/status',
      'http://127.0.0.1:8081/',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('looksLikeExpoMetro falls back to localhost when the Expo web runtime is only reachable on IPv6 localhost', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];

  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).startsWith('http://127.0.0.1:8081/')) {
      throw new Error('connect ECONNREFUSED 127.0.0.1');
    }

    if (String(url) === 'http://localhost:8081/status') {
      return new Response('packager-status:running', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
        },
      });
    }

    throw new Error(`unexpected url: ${String(url)}`);
  };

  try {
    const ok = await looksLikeExpoMetro({ port: 8081, timeoutMs: 25 });
    assert.equal(ok, true);
    assert.deepEqual(urls, [
      'http://127.0.0.1:8081/status',
      'http://localhost:8081/status',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('looksLikeExpoMetro treats a 200 /status response with the Expo project-root header as healthy even if the body stalls', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];

  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url) !== 'http://127.0.0.1:8081/status') {
      throw new Error(`unexpected url: ${String(url)}`);
    }

    return {
      ok: true,
      headers: {
        get(name) {
          if (String(name).toLowerCase() === 'x-react-native-project-root') {
            return '/tmp/happier/apps/ui';
          }
          return null;
        },
      },
      text: async () => {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        throw error;
      },
    };
  };

  try {
    const ok = await looksLikeExpoMetro({ port: 8081, timeoutMs: 25 });
    assert.equal(ok, true);
    assert.deepEqual(urls, ['http://127.0.0.1:8081/status']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
