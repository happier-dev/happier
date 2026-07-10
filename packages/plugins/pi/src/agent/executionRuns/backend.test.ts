import type { PluginContextV1, SessionRuntimeV1 } from '@happier-dev/plugin-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPiExecutionRunBackend } from './backend.js';

const createPiRuntimeOperationsMock = vi.hoisted(() => vi.fn());

vi.mock('../runtime/rpc/operations.js', () => ({
  createPiRuntimeOperations: createPiRuntimeOperationsMock,
}));

beforeEach(() => {
  createPiRuntimeOperationsMock.mockReset();
});

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
  dispose: () => Promise<void>;
  providerSessionId?: string;
}>): SessionRuntimeV1 & Readonly<{
  dispose: ReturnType<typeof vi.fn>;
}> {
  const providerSessionId = params.providerSessionId ?? 'pi-session-1';
  return {
    identity: {
      read: vi.fn(() => ({ providerSessionId })),
    },
    events: {
      subscribe: vi.fn(() => () => undefined),
    },
    send: vi.fn(async () => ({ status: 'accepted' })),
    cancel: vi.fn(async () => ({ status: 'cancelled' })),
    permissions: { capability: 'static' },
    updateConfig: vi.fn(async () => undefined),
    dispose: vi.fn(params.dispose),
  };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe('createPiExecutionRunBackend', () => {
  it('keeps overlapping provision resume ids scoped to their factory calls', async () => {
    createPiRuntimeOperationsMock.mockImplementation((options: Readonly<{ resumeSessionId?: string | null }>) => {
      const providerSessionId = options.resumeSessionId ?? 'pi-session-fresh';
      return createRuntimeOperations({
        providerSessionId,
        dispose: async () => undefined,
      });
    });
    const backend = createPiExecutionRunBackend({
      ctx: {} as PluginContextV1,
      executionRunParams: {
        backendId: 'pi',
        cwd: process.cwd(),
      },
    });

    const firstProvision = backend.provisionSession({ resumeSessionId: 'pi-session-first' });
    const secondProvision = backend.provisionSession({ resumeSessionId: 'pi-session-second' }).catch((error: unknown) => error);

    await expect(firstProvision).resolves.toEqual({ sessionId: 'pi-session-first' });
    await expect(secondProvision).resolves.toBeInstanceOf(Error);
    expect(createPiRuntimeOperationsMock).toHaveBeenCalledTimes(1);
    expect(createPiRuntimeOperationsMock).toHaveBeenCalledWith(expect.objectContaining({
      resumeSessionId: 'pi-session-first',
    }));
  });

  it('applies the execution-run modelId to the pi runtime before the first turn', async () => {
    const operations = createRuntimeOperations({ providerSessionId: 'pi-session-first', dispose: async () => undefined });
    createPiRuntimeOperationsMock.mockReturnValue(operations);
    const backend = createPiExecutionRunBackend({
      ctx: {} as PluginContextV1,
      executionRunParams: {
        backendId: 'pi',
        cwd: process.cwd(),
        modelId: 'openai/gpt-5',
      },
    });

    await expect(backend.provisionSession({ resumeSessionId: 'pi-session-first' }))
      .resolves.toEqual({ sessionId: 'pi-session-first' });
    expect(operations.updateConfig).toHaveBeenCalledWith({ modelId: 'openai/gpt-5' });
  });

  it('does not apply a sentinel default modelId to the pi runtime', async () => {
    const operations = createRuntimeOperations({ providerSessionId: 'pi-session-first', dispose: async () => undefined });
    createPiRuntimeOperationsMock.mockReturnValue(operations);
    const backend = createPiExecutionRunBackend({
      ctx: {} as PluginContextV1,
      executionRunParams: {
        backendId: 'pi',
        cwd: process.cwd(),
        modelId: 'default',
      },
    });

    await backend.provisionSession({ resumeSessionId: 'pi-session-first' });
    expect(operations.updateConfig).not.toHaveBeenCalled();
  });

  it('awaits runtime cleanup when disposed while runtime creation is in flight', async () => {
    const runtimeCreation = createDeferred<SessionRuntimeV1>();
    const disposeComplete = createDeferred<void>();
    let runtimeDisposeStarted = false;
    let disposeSettled = false;
    createPiRuntimeOperationsMock.mockReturnValue(runtimeCreation.promise);
    const operations = createRuntimeOperations({
      async dispose() {
        runtimeDisposeStarted = true;
        await disposeComplete.promise;
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
    runtimeCreation.resolve(operations);
    await flushMicrotasks();

    expect(operations.dispose).toHaveBeenCalledTimes(1);
    expect(runtimeDisposeStarted).toBe(true);
    expect(disposeSettled).toBe(false);

    disposeComplete.resolve();
    await expect(disposePromise).resolves.toBeUndefined();
    await expect(provisionResult).resolves.toMatchObject({ ok: false });
    expect(disposeSettled).toBe(true);
  });
});
