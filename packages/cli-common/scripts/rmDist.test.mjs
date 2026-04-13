import { describe, expect, it, vi } from 'vitest';
import * as buildScript from './build.mjs';

describe('cli-common dist cleanup contract', () => {
  it('retries transient ENOTEMPTY errors before removing dist', () => {
    expect(typeof buildScript.cleanPackageDistSync).toBe('function');

    const rmSyncImpl = vi
      .fn()
      .mockImplementationOnce(() => {
        const error = new Error('busy');
        error.code = 'ENOTEMPTY';
        throw error;
      })
      .mockImplementationOnce(() => {});

    buildScript.cleanPackageDistSync({
      rmSyncImpl,
      retries: 1,
      delayMs: 0,
      targetDir: 'dist',
    });

    expect(rmSyncImpl).toHaveBeenCalledTimes(2);
    expect(rmSyncImpl).toHaveBeenNthCalledWith(1, 'dist', { recursive: true, force: true });
    expect(rmSyncImpl).toHaveBeenNthCalledWith(2, 'dist', { recursive: true, force: true });
  });
});
