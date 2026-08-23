import { describe, expect, it, vi } from 'vitest';

import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';

const scope = { accountId: 'account-1', machineId: 'machine-1' } as const;

describe('action operation canonical execution observer', () => {
  it('publishes every revision while returning the canonical result unchanged exactly once', async () => {
    const published: unknown[] = [];
    const store = createActionOperationStore({ onSnapshot: (snapshot) => published.push(snapshot) });
    const execute = vi.fn(async ({ updateProgress }: { updateProgress: (value: { phase: string; label: string }) => void }) => {
      updateProgress({ phase: 'working', label: 'Working' });
      return { ok: true as const, result: { childSessionId: 'child-1' } };
    });
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId,
        title: 'Fork session',
        operation: {
          version: 1,
          visibility: 'activity',
          progress: 'reported',
          presentation: { onStart: 'current' },
        },
      }),
      generateOperationId: () => 'operation-1',
    });

    const result = await runner.observe({
      actionId: 'session.fork',
      requestId: 'request-1',
      scope,
      execute,
    });

    expect(result).toEqual({ ok: true, result: { childSessionId: 'child-1' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(published).toMatchObject([
      { revision: 1, state: 'accepted', requestId: 'request-1' },
      { revision: 2, state: 'running' },
      { revision: 3, state: 'running', progress: { kind: 'phase', phase: 'working' } },
      { revision: 4, state: 'succeeded' },
    ]);
  });

  it('does not observe an Action without a tracked declaration', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({ actionId, title: actionId }),
    });
    const execute = vi.fn(async () => ({ ok: true as const, result: 'historical' }));
    await expect(runner.observe({ actionId: 'memory.search', scope, execute }))
      .resolves.toEqual({ ok: true, result: 'historical' });
    expect(store.list(scope).items).toEqual([]);
  });

  it('reuses one projection for a retry while still entering the canonical coalescer', async () => {
    const published: Array<{ operationId: string }> = [];
    const store = createActionOperationStore({ onSnapshot: (snapshot) => published.push(snapshot) });
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId, title: 'Spawn',
        operation: {
          version: 1, visibility: 'activity', progress: 'indeterminate',
          presentation: { onStart: 'current' },
        },
      }),
      generateOperationId: vi.fn(() => 'operation-1'),
    });
    const execute = vi.fn(async () => ({ ok: true as const, result: { type: 'success' } }));

    await runner.observe({ actionId: 'session.spawn_new', requestId: 'creation-1', scope, execute });
    await runner.observe({ actionId: 'session.spawn_new', requestId: 'creation-1', scope, execute });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(store.list(scope).items).toHaveLength(1);
    expect(new Set(published.map((snapshot) => snapshot.operationId))).toEqual(new Set(['operation-1']));
  });

  it('does not fail canonical execution when snapshot publication throws', async () => {
    const store = createActionOperationStore({ onSnapshot: () => { throw new Error('socket unavailable'); } });
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId, title: 'Fork',
        operation: {
          version: 1, visibility: 'activity', progress: 'indeterminate',
          presentation: { onStart: 'current' },
        },
      }),
    });
    await expect(runner.observe({
      actionId: 'session.fork', scope,
      execute: async () => ({ ok: true, result: 'historical' }),
    })).resolves.toEqual({ ok: true, result: 'historical' });
  });
});
