import { describe, expect, it, vi } from 'vitest';

import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';

const scope = { accountId: 'account-1', machineId: 'machine-1' } as const;

describe('actionOperationRunner historical execution projection', () => {
  it('wraps the historical execution once while returning its exact value', async () => {
    const store = createActionOperationStore({ now: () => 10 });
    const runner = createActionOperationRunner({ store, createOperationId: () => 'operation-1', now: () => 10 });
    const exact = { ok: true as const, childSessionId: 'child-1' };
    const value = await runner.executeHistorical({
      request: { actionId: 'session.fork', input: {}, requestId: 'request-1', scope: { sessionId: 'parent-1' } },
      scope,
      title: 'Fork session',
      cancellation: 'supported',
      scopeSessionId: 'parent-1',
      execute: async ({ update }) => {
        update({ progress: { kind: 'phase', phase: 'creating', label: 'Creating fork' } });
        return exact;
      },
      projectResult: (result) => ({ ok: true, result }),
    });

    expect(value).toBe(exact);
    expect(store.get('operation-1', scope)).toMatchObject({
      requestId: 'request-1', revision: 4, state: 'succeeded', result: exact,
    });
  });

  it('reuses one projection for repeated delivery of the same scoped Action request', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, createOperationId: vi.fn(() => 'operation-1') });
    const execute = vi.fn(async () => ({ ok: true as const, childSessionId: 'child-1' }));
    const invoke = () => runner.executeHistorical({
      request: { actionId: 'session.fork', input: {}, requestId: 'request-1', scope: {} },
      scope,
      title: 'Fork session',
      cancellation: 'supported' as const,
      execute,
      projectResult: (result: Awaited<ReturnType<typeof execute>>) => ({ ok: true as const, result }),
    });

    await Promise.all([invoke(), invoke()]);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(store.list({}, scope).items).toHaveLength(1);
    expect(store.get('operation-1', scope)).toMatchObject({ state: 'succeeded', revision: 3 });
  });

  it('requests cooperative cancellation and only terminalizes when the owner throws AbortError', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, createOperationId: () => 'operation-cancel' });
    let observedSignal: AbortSignal | null = null;
    const running = runner.executeHistorical({
      request: { actionId: 'session.spawn_new', input: {}, requestId: 'spawn-1', scope: {} },
      scope,
      title: 'Create session',
      cancellation: 'supported',
      execute: async ({ signal }) => {
        observedSignal = signal;
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true }));
        return { type: 'success' as const, sessionId: 'unreachable' };
      },
      projectResult: (result) => ({ ok: true, result }),
    });
    await vi.waitFor(() => expect(observedSignal).not.toBeNull());
    expect(runner.cancel('operation-cancel', scope)).toEqual({ kind: 'requested' });
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.get('operation-cancel', scope)).toMatchObject({ state: 'cancelled' });
  });
});
