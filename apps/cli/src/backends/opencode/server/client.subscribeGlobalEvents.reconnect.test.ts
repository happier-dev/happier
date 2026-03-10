import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./openCodeSse', () => ({
  subscribeSseJson: vi.fn(),
}));

vi.mock('./sharedManagedServer', () => ({
  ensureSharedManagedOpenCodeServerBaseUrl: vi.fn(),
  isLoopbackManagedOpenCodeBaseUrl: (rawBaseUrl: string) => {
    const value = rawBaseUrl.trim();
    if (!value) return false;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      const port = Number.parseInt(url.port, 10);
      if (!Number.isFinite(port) || port <= 0) return false;
      const host = url.hostname.toLowerCase();
      return host === 'localhost' || host === '::1' || host.startsWith('127.');
    } catch {
      return false;
    }
  },
  readSharedManagedOpenCodeServerStateBestEffort: vi.fn(),
}));

type FakeResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

function createResponse(params: { ok: boolean; status: number; statusText: string; body: unknown }): FakeResponse {
  return {
    ok: params.ok,
    status: params.status,
    statusText: params.statusText,
    json: async () => params.body,
    text: async () => JSON.stringify(params.body),
  };
}

function createOkJsonResponse(body: unknown): FakeResponse {
  return createResponse({ ok: true, status: 200, statusText: 'OK', body });
}

describe('createOpenCodeServerRuntimeClient.subscribeGlobalEvents', () => {
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    for (const key of [
      'HAPPIER_OPENCODE_SERVER_URL',
      'HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS',
      'HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS',
    ] as const) {
      prevEnv[key] = process.env[key];
    }

    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://127.0.0.1:9999';
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS = '5';
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS = '5';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) {
        delete (process.env as any)[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('reconnects when the SSE stream ends unexpectedly and resumes delivering events', async () => {
    const fetchSpy = vi.fn(async (url: any) => {
      if (String(url).includes('/global/health')) return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;

    let firstParams: any = null;
    let secondParams: any = null;

    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });
    subscribeMock
      .mockImplementationOnce(async (params: any) => {
        firstParams = params;
        // Emit one event with an SSE id to seed the Last-Event-ID header on reconnect.
        params.onMessage({ directory: '/tmp', payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } } }, { id: 'evt_1' });
        return { close: vi.fn(), done: firstDone };
      })
      .mockImplementationOnce(async (params: any) => {
        secondParams = params;
        params.onMessage({ directory: '/tmp', payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } } }, { id: 'evt_2' });
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        params.signal?.addEventListener?.('abort', () => resolveDone(), { once: true });
        const close = vi.fn(() => resolveDone());
        return { close, done };
      });

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });

    const onEvent = vi.fn();
    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(firstParams?.headers?.['Last-Event-ID']).toBeUndefined();

    // Simulate an SSE disconnect.
    rejectFirstDone(new Error('socket hang up'));

    await expect.poll(() => subscribeMock.mock.calls.length).toBeGreaterThan(1);
    expect(secondParams?.headers?.['Last-Event-ID']).toBe('evt_1');

    await expect.poll(() => onEvent.mock.calls.length).toBeGreaterThan(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ type: 'session.idle' }) }));

    controller.abort();
    await client.dispose();
  });

  it('dispose aborts reconnect sleep promptly (does not block on backoff timers)', async () => {
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS = '5000';
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS = '5000';

    const fetchSpy = vi.fn(async (url: any) => {
      if (String(url).includes('/global/health')) return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;

    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });
    subscribeMock.mockImplementationOnce(async (params: any) => {
      // Keep a reference to the abort signal so we can ensure it becomes aborted on dispose.
      expect(params.signal?.aborted).toBe(false);
      return { close: vi.fn(), done: firstDone };
    });

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });

    const onEvent = vi.fn();
    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });

    rejectFirstDone(new Error('socket hang up'));
    // Give the reconnect loop a chance to enter its sleep.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await Promise.race([
      client.dispose(),
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('dispose timed out')), 50)),
    ]);
  });

  it('refreshes the managed OpenCode server baseUrl when the SSE stream drops (e.g. managed server restarted on a new port)', async () => {
    delete process.env.HAPPIER_OPENCODE_SERVER_URL;

    const fetchSpy = vi.fn(async (url: any) => {
      if (String(url).includes('/global/health')) return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
    const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
    const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;
    ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
    readMock
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:10000', pid: process.pid, startedAtMs: 2 });

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;

    let firstParams: any = null;
    let secondParams: any = null;

    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });

    subscribeMock
      .mockImplementationOnce(async (params: any) => {
        firstParams = params;
        return { close: vi.fn(), done: firstDone };
      })
      .mockImplementationOnce(async (params: any) => {
        secondParams = params;
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        params.signal?.addEventListener?.('abort', () => resolveDone(), { once: true });
        return { close: vi.fn(() => resolveDone()), done };
      });

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });

    const onEvent = vi.fn();
    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });

    expect(String(firstParams?.url ?? '')).toContain('127.0.0.1:9999');

    rejectFirstDone(new Error('socket hang up'));

    await expect.poll(() => subscribeMock.mock.calls.length).toBeGreaterThan(1);
    expect(String(secondParams?.url ?? '')).toContain('127.0.0.1:10000');

    controller.abort();
    await client.dispose();
  });

  it('re-ensures the managed OpenCode server when state is missing and the current baseUrl is unhealthy', async () => {
    delete process.env.HAPPIER_OPENCODE_SERVER_URL;

    const fetchSpy = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('127.0.0.1:9999') && urlStr.includes('/global/health')) {
        return createResponse({ ok: false, status: 502, statusText: 'Bad Gateway', body: { healthy: false } }) as any;
      }
      if (urlStr.includes('127.0.0.1:10000') && urlStr.includes('/global/health')) {
        return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      }
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
    const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
    const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;
    ensureMock
      .mockResolvedValueOnce('http://127.0.0.1:9999')
      .mockResolvedValueOnce('http://127.0.0.1:10000');
    readMock.mockResolvedValueOnce(null);

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;

    let firstParams: any = null;
    let secondParams: any = null;

    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });

    subscribeMock
      .mockImplementationOnce(async (params: any) => {
        firstParams = params;
        return { close: vi.fn(), done: firstDone };
      })
      .mockImplementationOnce(async (params: any) => {
        secondParams = params;
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        params.signal?.addEventListener?.('abort', () => resolveDone(), { once: true });
        return { close: vi.fn(() => resolveDone()), done };
      });

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });

    const onEvent = vi.fn();
    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });

    expect(String(firstParams?.url ?? '')).toContain('127.0.0.1:9999');

    rejectFirstDone(new Error('socket hang up'));

    await expect.poll(() => subscribeMock.mock.calls.length).toBeGreaterThan(1);
    expect(String(secondParams?.url ?? '')).toContain('127.0.0.1:10000');
    expect(ensureMock.mock.calls.length).toBe(2);

    controller.abort();
    await client.dispose();
  });

  it('ignores non-loopback managed server state during SSE reconnect refresh', async () => {
    delete process.env.HAPPIER_OPENCODE_SERVER_URL;

    const fetchSpy = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('127.0.0.1:9999') && urlStr.includes('/global/health')) {
        return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      }
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
    const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
    const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;
    ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
    readMock.mockResolvedValueOnce({ baseUrl: 'http://example.com:8080', pid: process.pid, startedAtMs: 2 });

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;

    let firstParams: any = null;
    let secondParams: any = null;

    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });

    subscribeMock
      .mockImplementationOnce(async (params: any) => {
        firstParams = params;
        return { close: vi.fn(), done: firstDone };
      })
      .mockImplementationOnce(async (params: any) => {
        secondParams = params;
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        params.signal?.addEventListener?.('abort', () => resolveDone(), { once: true });
        return { close: vi.fn(() => resolveDone()), done };
      });

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });

    const onEvent = vi.fn();
    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });

    expect(String(firstParams?.url ?? '')).toContain('127.0.0.1:9999');

    rejectFirstDone(new Error('socket hang up'));

    await expect.poll(() => subscribeMock.mock.calls.length).toBeGreaterThan(1);
    expect(String(secondParams?.url ?? '')).toContain('127.0.0.1:9999');
    expect(String(secondParams?.url ?? '')).not.toContain('example.com:8080');
    expect(ensureMock).toHaveBeenCalledTimes(1);

    controller.abort();
    await client.dispose();
  });
});
