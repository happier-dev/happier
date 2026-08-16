import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { subscribeSseJson } from './openCodeSse';

type ClientModuleWithReadIdleResolver = typeof import('./client') & {
  resolveOpenCodeSseReadIdleTimeoutMs?: (env: NodeJS.ProcessEnv) => number | null;
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('subscribeSseJson read idle timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('settles done with an identifiable error when socket reads stay idle past the timeout', async () => {
    vi.useFakeTimers();

    const observedFetchSignals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) observedFetchSignals.push(init.signal);
      return new Response(new ReadableStream<Uint8Array>(), { status: 200, statusText: 'OK' });
    }) satisfies typeof fetch);

    const outerAbort = new AbortController();
    const params = {
      url: 'http://127.0.0.1:9999/global/event',
      signal: outerAbort.signal,
      readIdleTimeoutMs: 25,
      onMessage: vi.fn(),
    };
    const subscription = await subscribeSseJson<Record<string, unknown>>(params);

    let settled = false;
    let doneError: unknown = null;
    void subscription.done
      .catch((error: unknown) => {
        doneError = error;
      })
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(24);
    await flushMicrotasks();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(settled).toBe(true);
    expect(doneError).toBeInstanceOf(Error);
    expect((doneError as Error).name).toBe('OpenCodeSseReadIdleTimeoutError');
    expect((doneError as { code?: unknown }).code).toBe('OPENCODE_SSE_READ_IDLE_TIMEOUT');
    expect(observedFetchSignals[0]?.aborted).toBe(true);
    expect(observedFetchSignals[0]?.reason).toBe(doneError);
  });

  it('keeps the stream open when bytes arrive before the read-idle deadline', async () => {
    vi.useFakeTimers();

    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      });
      return new Response(stream, { status: 200, statusText: 'OK' });
    }) satisfies typeof fetch);

    const subscription = await subscribeSseJson<Record<string, unknown>>({
      url: 'http://127.0.0.1:9999/global/event',
      signal: new AbortController().signal,
      readIdleTimeoutMs: 30,
      onMessage: vi.fn(),
    });

    const controller = () => {
      if (!streamController) {
        throw new Error('SSE test stream controller was not initialized');
      }
      return streamController;
    };

    let settled = false;
    const done = subscription.done.finally(() => {
      settled = true;
    });

    controller().enqueue(new TextEncoder().encode('data: {"type":"server.heartbeat"}\n\n'));
    await vi.advanceTimersByTimeAsync(20);
    await flushMicrotasks();
    expect(settled).toBe(false);

    controller().enqueue(new TextEncoder().encode('data: {"type":"server.heartbeat"}\n\n'));
    await vi.advanceTimersByTimeAsync(20);
    await flushMicrotasks();
    expect(settled).toBe(false);

    controller().close();
    await done;
    expect(settled).toBe(true);
  });
});

describe('resolveOpenCodeSseReadIdleTimeoutMs', () => {
  it('uses the default timeout when the environment variable is absent or invalid', async () => {
    const clientModule = await import('./client') as ClientModuleWithReadIdleResolver;

    expect(clientModule.resolveOpenCodeSseReadIdleTimeoutMs).toBeTypeOf('function');
    expect(clientModule.resolveOpenCodeSseReadIdleTimeoutMs?.({})).toBe(30_000);
    expect(clientModule.resolveOpenCodeSseReadIdleTimeoutMs?.({
      HAPPIER_OPENCODE_SSE_READ_IDLE_TIMEOUT_MS: 'not-a-number',
    })).toBe(30_000);
  });

  it('clamps configured timeouts while allowing zero to disable read-idle recovery', async () => {
    const clientModule = await import('./client') as ClientModuleWithReadIdleResolver;

    expect(clientModule.resolveOpenCodeSseReadIdleTimeoutMs).toBeTypeOf('function');
    expect(clientModule.resolveOpenCodeSseReadIdleTimeoutMs?.({
      HAPPIER_OPENCODE_SSE_READ_IDLE_TIMEOUT_MS: '1',
    })).toBe(5_000);
    expect(clientModule.resolveOpenCodeSseReadIdleTimeoutMs?.({
      HAPPIER_OPENCODE_SSE_READ_IDLE_TIMEOUT_MS: '999999',
    })).toBe(120_000);
    expect(clientModule.resolveOpenCodeSseReadIdleTimeoutMs?.({
      HAPPIER_OPENCODE_SSE_READ_IDLE_TIMEOUT_MS: '0',
    })).toBeNull();
  });
});

describe('createOpenCodeServerRuntimeClient read idle configuration', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('./openCodeSse');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('passes the resolved read-idle timeout to the instance SSE subscription', async () => {
    vi.resetModules();

    const subscribeSseJsonMock = vi.fn(async (params: unknown) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      return {
        close: vi.fn(() => resolveDone()),
        done,
        params,
      };
    });

    vi.doMock('./openCodeSse', () => ({
      subscribeSseJson: subscribeSseJsonMock,
    }));

    vi.doMock('./sharedManagedServer', () => ({
      ensureSharedManagedOpenCodeServerBaseUrl: vi.fn(),
      isLoopbackManagedOpenCodeBaseUrl: () => false,
      readSharedManagedOpenCodeServerStateBestEffort: vi.fn(),
    }));

    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify({ healthy: true, version: 'test' }), { status: 200, statusText: 'OK' });
    }) satisfies typeof fetch);

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({
      directory: '/tmp',
      messageBuffer: new MessageBuffer(),
      env: {
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:9999',
        HAPPIER_OPENCODE_SSE_READ_IDLE_TIMEOUT_MS: '6',
      } as NodeJS.ProcessEnv,
    });

    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent: vi.fn() });

    expect(subscribeSseJsonMock).toHaveBeenCalledWith(expect.objectContaining({
      readIdleTimeoutMs: 5_000,
    }));

    controller.abort();
    await client.dispose();
  });
});
