import assert from 'node:assert/strict';
import test from 'node:test';

import { configureManagedLimaGuestPressure } from './guest_pressure.mjs';

test('managed Lima pressure configuration sends only a validated bounded policy to the guest', async () => {
  const calls = [];
  const executor = {
    async capture(command, args, options) {
      calls.push({ command, args, options });
      return {
        exitCode: 0,
        out: '{"swapGiB":64,"zswap":true,"active":true}\n',
        err: '',
      };
    },
  };

  const result = await configureManagedLimaGuestPressure({
    executor,
    instance: 'primary',
    profile: { name: 'swap64-zswap' },
    scriptSource: '#!/usr/bin/env bash\nexit 0\n',
  });

  assert.deepEqual(result, {
    profile: 'swap64-zswap',
    swapGiB: 64,
    zswap: true,
    active: true,
  });
  assert.deepEqual(calls[0].args.slice(0, 4), ['shell', 'primary', '--', 'env']);
  assert.ok(calls[0].args.includes('HAPPIER_SWAP_GIB=64'));
  assert.ok(calls[0].args.includes('HAPPIER_ZSWAP=1'));
  assert.ok(calls[0].args.includes('HAPPIER_SWAP_FREE_RESERVE_GIB=32'));
  assert.equal(calls[0].options.input, '#!/usr/bin/env bash\nexit 0\n');
});

test('managed Lima pressure configuration rejects unknown policies before guest execution', async () => {
  let called = false;
  await assert.rejects(
    configureManagedLimaGuestPressure({
      executor: { async capture() { called = true; } },
      instance: 'primary',
      profile: 'swap999',
      scriptSource: 'exit 0',
    }),
    /unknown managed Lima pressure profile/,
  );
  assert.equal(called, false);
});
