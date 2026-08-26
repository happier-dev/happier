import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveManagedLimaPressureProfile,
} from './pressure_profiles.mjs';

test('managed Lima pressure profiles keep swap as an explicit survival experiment', () => {
  assert.deepEqual(resolveManagedLimaPressureProfile('none'), {
    name: 'none',
    swapGiB: 0,
    zswap: false,
    freeSpaceReserveGiB: 32,
  });
  assert.deepEqual(resolveManagedLimaPressureProfile('swap64'), {
    name: 'swap64',
    swapGiB: 64,
    zswap: false,
    freeSpaceReserveGiB: 32,
  });
  assert.deepEqual(resolveManagedLimaPressureProfile('swap128-zswap'), {
    name: 'swap128-zswap',
    swapGiB: 128,
    zswap: true,
    freeSpaceReserveGiB: 32,
  });
});

test('managed Lima pressure profiles reject unbounded or implicit swap policy', () => {
  assert.throws(() => resolveManagedLimaPressureProfile('swap256'), /unknown managed Lima pressure profile/);
  assert.throws(() => resolveManagedLimaPressureProfile(''), /unknown managed Lima pressure profile/);
});
