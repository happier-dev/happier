import { describe, expect, it } from 'vitest';

import { createActionOperationStore } from './actionOperationStore';

const ACCOUNT_SCOPE = { accountId: 'account-1', machineId: 'machine-1' } as const;

describe('action operation store', () => {
  it('keeps revisions monotonic, terminalizes once, and scopes get/list', () => {
    let now = 1_000;
    const store = createActionOperationStore({ now: () => now });
    const accepted = store.create({
      operationId: 'operation-1',
      actionId: 'session.fork',
      scope: { ...ACCOUNT_SCOPE, sessionId: 'session-1' },
      title: 'Fork session',
      cancellation: 'unsupported',
    });

    expect(accepted).toMatchObject({ state: 'accepted', revision: 1, createdAt: 1_000 });
    expect(store.get(ACCOUNT_SCOPE, 'operation-1')).toEqual(accepted);
    expect(store.get({ accountId: 'account-2', machineId: 'machine-1' }, 'operation-1')).toBeNull();
    expect(store.list({ ...ACCOUNT_SCOPE, sessionId: 'session-2' }).items).toEqual([]);

    now = 1_100;
    const running = store.markRunning('operation-1');
    expect(running).toMatchObject({ state: 'running', revision: 2, startedAt: 1_100 });

    now = 1_200;
    const succeeded = store.succeed('operation-1', { childSessionId: 'session-2' });
    expect(succeeded).toMatchObject({ state: 'succeeded', revision: 3, settledAt: 1_200 });
    now = 1_300;
    expect(store.fail('operation-1', { errorCode: 'late', error: 'late' })).toEqual(succeeded);
    expect(store.markRunning('operation-1')).toEqual(succeeded);

    expect(store.list(ACCOUNT_SCOPE).items[0]).not.toHaveProperty('result');
    expect(store.get(ACCOUNT_SCOPE, 'operation-1')).toEqual(succeeded);
  });

  it('has no polling observation API', () => {
    expect(createActionOperationStore()).not.toHaveProperty('wait');
  });

  it('retains active rows and only the newest 50 settled rows within 24 hours', () => {
    let now = 100_000_000;
    const store = createActionOperationStore({ now: () => now });

    store.create({
      operationId: 'active-old',
      actionId: 'session.fork',
      scope: ACCOUNT_SCOPE,
      title: 'Active',
      cancellation: 'unsupported',
    });

    for (let index = 0; index < 52; index += 1) {
      const operationId = `settled-${index}`;
      store.create({
        operationId,
        actionId: 'session.fork',
        scope: ACCOUNT_SCOPE,
        title: `Settled ${index}`,
        cancellation: 'unsupported',
      });
      store.markRunning(operationId);
      now += 1;
      store.succeed(operationId, { index });
    }

    const bounded = store.list(ACCOUNT_SCOPE).items;
    expect(bounded).toHaveLength(51);
    expect(bounded[0]).toMatchObject({ operationId: 'active-old', state: 'accepted' });
    expect(bounded.some((item) => item.operationId === 'settled-0')).toBe(false);
    expect(bounded.some((item) => item.operationId === 'settled-1')).toBe(false);

    now += 24 * 60 * 60 * 1_000 + 1;
    expect(store.list(ACCOUNT_SCOPE).items).toEqual([
      expect.objectContaining({ operationId: 'active-old', state: 'accepted' }),
    ]);
  });
});
