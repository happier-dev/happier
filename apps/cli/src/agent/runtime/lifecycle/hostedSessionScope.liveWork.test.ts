import { expect, it } from 'vitest';

import { bindHostedSessionLiveWork, readHostedSessionScope, runInHostedSessionScope } from './hostedSessionScope';

it('releases live-work readers from a scope still held by asynchronous resources', async () => {
  const state = { session: 'settled', input: 'settled', agents: 'settled', attention: 'settled', settledAt: 1 } as const;
  await runInHostedSessionScope({ environment: {} }, async () => {
    const previous = bindHostedSessionLiveWork(async () => state);
    const dispose = bindHostedSessionLiveWork(async () => state);
    try {
      previous();
      await expect(readHostedSessionScope()?.readLiveWork?.()).resolves.toEqual(state);
    } finally {
      dispose();
    }
    expect(readHostedSessionScope()?.readLiveWork).toBeUndefined();
  });
});
