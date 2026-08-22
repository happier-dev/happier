import test from 'node:test';
import assert from 'node:assert/strict';

import { enableTuiRescuePriority } from './rescue_priority.mjs';

test('enableTuiRescuePriority elevates only the current control process', async () => {
  const calls = [];
  const result = await enableTuiRescuePriority({ pid: 123, platform: 'darwin' }, {
    runPrivilegedReniceImpl: async (input) => {
      calls.push(input);
      return { ok: true };
    },
  });

  assert.deepEqual(calls, [{ pid: 123, nice: -5 }]);
  assert.deepEqual(result, { nice: -5, platform: 'darwin' });
});

test('enableTuiRescuePriority rejects unsupported platforms instead of silently degrading', async () => {
  await assert.rejects(
    enableTuiRescuePriority({ pid: 123, platform: 'win32' }),
    /not supported on win32/i,
  );
});
