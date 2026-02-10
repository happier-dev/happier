import { describe, expect, it } from 'vitest';

import { rmDirSafeSync } from './rmDirSafe.mjs';

function enotempty(): NodeJS.ErrnoException {
  const err = new Error('ENOTEMPTY') as NodeJS.ErrnoException;
  err.code = 'ENOTEMPTY';
  return err;
}

describe('rmDirSafeSync', () => {
  it('retries on ENOTEMPTY and eventually succeeds', () => {
    let calls = 0;
    rmDirSafeSync('dist', {
      rmSyncImpl() {
        calls++;
        if (calls <= 2) throw enotempty();
      },
      retries: 5,
      delayMs: 0,
    });

    expect(calls).toBe(3);
  });
});
