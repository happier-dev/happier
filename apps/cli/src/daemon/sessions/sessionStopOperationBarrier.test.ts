import { describe, expect, it } from 'vitest';

import { createSessionStopOperationBarrier } from './sessionStopOperationBarrier';

describe('createSessionStopOperationBarrier', () => {
  it('deduplicates a stop operation and keeps resume blocked until the entire operation settles', async () => {
    const barrier = createSessionStopOperationBarrier();
    let release!: () => void;
    const disposition = new Promise<{ status: 'stopped' }>((resolve) => {
      release = () => resolve({ status: 'stopped' });
    });
    let calls = 0;

    const first = barrier.run(' sess-1 ', async () => {
      calls += 1;
      return await disposition;
    });
    const second = barrier.run('sess-1', async () => {
      calls += 1;
      return { status: 'not_found' };
    });
    let waitSettled = false;
    const wait = barrier.wait('sess-1').finally(() => {
      waitSettled = true;
    });

    await Promise.resolve();
    expect(calls).toBe(1);
    expect(waitSettled).toBe(false);

    release();
    await expect(first).resolves.toEqual({ status: 'stopped' });
    await expect(second).resolves.toEqual({ status: 'stopped' });
    await wait;
    expect(barrier.has('sess-1')).toBe(false);
  });
});
