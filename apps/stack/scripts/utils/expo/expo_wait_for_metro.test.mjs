import test from 'node:test';
import assert from 'node:assert/strict';

import { waitForExpoMetroRunning } from './expo.mjs';

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

