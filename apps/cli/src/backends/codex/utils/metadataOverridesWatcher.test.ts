import { describe, expect, it, vi } from 'vitest';

import { runMetadataOverridesWatcherLoop } from './metadataOverridesWatcher';

describe('runMetadataOverridesWatcherLoop', () => {
  it('backs off when waitForMetadataUpdate returns false for an aborted signal', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      abort.abort();

      let exit = false;
      const waitForMetadataUpdate = vi.fn(async () => false);

      const loopPromise = runMetadataOverridesWatcherLoop({
        shouldExit: () => exit,
        getAbortSignal: () => abort.signal,
        waitForMetadataUpdate,
        onUpdate: () => {},
        abortedBackoffMs: 50,
      });

      // Allow the loop to run at least once.
      await Promise.resolve();
      expect(waitForMetadataUpdate).toHaveBeenCalledTimes(1);

      // With a backoff, the loop should not call again until timers advance.
      await Promise.resolve();
      expect(waitForMetadataUpdate).toHaveBeenCalledTimes(1);

      exit = true;
      await vi.advanceTimersByTimeAsync(50);
      await loopPromise;
    } finally {
      vi.useRealTimers();
    }
  });
});
