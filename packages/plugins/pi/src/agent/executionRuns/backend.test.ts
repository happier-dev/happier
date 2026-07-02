import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import type { InternalRuntimeTurnOperationsV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';
import { describe, expect, it, vi } from 'vitest';

import { createPiExecutionRunBackend } from './backend.js';

const createPiRuntimeOperationsMock = vi.hoisted(() => vi.fn());

vi.mock('../runtime/rpc/operations.js', () => ({
  createPiRuntimeOperations: createPiRuntimeOperationsMock,
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRuntimeOperations(params: Readonly<{
  resetOrDisposeRuntime: () => Promise<void>;
}>): InternalRuntimeTurnOperationsV1 {
  return {
    beginTurnLifecycle: vi.fn(),
    startOrLoadSession: vi.fn(async () => ({ sessionId: 'pi-session-1' })),
    sendTurnPrompt: vi.fn(async () => undefined),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
    respondToPermission: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'pi-session-1' })),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(params.resetOrDisposeRuntime),
  };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe('createPiExecutionRunBackend', () => {
  it('awaits runtime cleanup when disposed while runtime creation is in flight', async () => {
    const runtimeCreation = createDeferred<Readonly<{
      operations: InternalRuntimeTurnOperationsV1;
      nativeRuntime: InternalRuntimeTurnOperationsV1;
    }>>();
    const resetComplete = createDeferred<void>();
    let resetStarted = false;
    let disposeSettled = false;
    createPiRuntimeOperationsMock.mockReturnValue(runtimeCreation.promise);
    const operations = createRuntimeOperations({
      async resetOrDisposeRuntime() {
        resetStarted = true;
        await resetComplete.promise;
      },
    });
    const backend = createPiExecutionRunBackend({
      ctx: {} as PluginContextV1,
      executionRunParams: {
        backendId: 'pi',
        cwd: process.cwd(),
      },
    });

    const provisionResult = backend.provisionSession().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await flushMicrotasks();

    expect(createPiRuntimeOperationsMock).toHaveBeenCalledTimes(1);

    const disposePromise = backend.dispose();
    disposePromise.then(() => {
      disposeSettled = true;
    });
    runtimeCreation.resolve({ operations, nativeRuntime: operations });
    await flushMicrotasks();

    expect(operations.resetOrDisposeRuntime).toHaveBeenCalledTimes(1);
    expect(resetStarted).toBe(true);
    expect(disposeSettled).toBe(false);

    resetComplete.resolve();
    await expect(disposePromise).resolves.toBeUndefined();
    await expect(provisionResult).resolves.toMatchObject({ ok: false });
    expect(disposeSettled).toBe(true);
  });
});
