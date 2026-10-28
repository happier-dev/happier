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
  it('leaves healthy quiet streams open by default when the environment variable is absent or invalid', async () => {
    const clientModule = await import('./client') as ClientModuleWithReadIdleResolver;

    expect(clientModule.resolveOpenCodeSseReadIdleTimeoutMs).toBeTypeOf('function');
    expect(clientModule.resolveOpenCodeSseReadIdleTimeoutMs?.({})).toBeNull();
    expect(clientModule.resolveOpenCodeSseReadIdleTimeoutMs?.({
      HAPPIER_OPENCODE_SSE_READ_IDLE_TIMEOUT_MS: 'not-a-number',
    })).toBeNull();
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('aborts an idle HTTP event stream at the configured lower bound', async () => {
    const { createOpenCodeSseResponse } = await import('./managedOpenCodeClient.testkit');
    const streams: ReturnType<typeof createOpenCodeSseResponse>[] = [];
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.pathname === '/event') {
        if (init?.signal) signals.push(init.signal);
        const stream = createOpenCodeSseResponse(init?.signal);
        streams.push(stream);
        return stream.response;
      }
      return new Response(JSON.stringify({ healthy: true, version: 'fixture' }), { status: 200 });
    }) satisfies typeof fetch);
    const { createOpenCodeServerRuntimeClient } = await import('./client');
    // Explicit external endpoint: no owned local server or shared state is involved.
    const client = await createOpenCodeServerRuntimeClient({
      directory: '/tmp', messageBuffer: new MessageBuffer(),
      env: { HAPPIER_OPENCODE_SERVER_URL: 'http://example.test', HAPPIER_OPENCODE_SSE_READ_IDLE_TIMEOUT_MS: '6' },
    });
    vi.useFakeTimers();
    try {
      await client.subscribeGlobalEvents({ signal: new AbortController().signal, onEvent: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);
      expect(streams).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(signals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[0]?.reason).toMatchObject({ code: 'OPENCODE_SSE_READ_IDLE_TIMEOUT', timeoutMs: 5_000 });
    } finally {
      for (const stream of streams) stream.close();
      await client.dispose();
    }
  });
});
