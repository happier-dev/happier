import { describe, expect, it } from 'vitest';

import { createSwitchToLocalAbortPromise } from '../createSwitchToLocalAbortPromise';

describe('createSwitchToLocalAbortPromise', () => {
  it('rejects with the provided abort error after the barrier resolves', async () => {
    let resolveBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });

    const promise = createSwitchToLocalAbortPromise({
      barrier,
      createAbortError: () => {
        const error = new Error('Switched to local');
        error.name = 'AbortError';
        return error;
      },
    });

    resolveBarrier();

    await expect(promise).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Switched to local',
    });
  });
});
