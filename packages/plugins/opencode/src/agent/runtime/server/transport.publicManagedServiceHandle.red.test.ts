import { describe, expect, it, vi } from 'vitest';
import type {
  ManagedServiceHandle,
  ManagedServiceResponse,
  ManagedServiceSnapshot,
} from '@happier-dev/plugin-sdk/managed-services';

import { createOpenCodeServerTransport } from './transport.js';

function createHandle(initial: ManagedServiceSnapshot) {
  let snapshot = initial;
  const listeners = new Set<(value: ManagedServiceSnapshot) => void>();
  const request = vi.fn(async (input: Readonly<{
    pathAndQuery: string;
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
    timeoutMs?: number;
    signal?: AbortSignal;
  }>) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: new Response('{}').body,
  } satisfies ManagedServiceResponse));
  const handle = {
    snapshot: () => snapshot,
    observe: (listener) => {
      listeners.add(listener);
      listener(snapshot);
      return { dispose: () => listeners.delete(listener) };
    },
    waitUntilHealthy: vi.fn(async () => snapshot),
    stop: vi.fn(async () => ({ status: 'stopped' as const })),
    dispose: vi.fn(async () => undefined),
    request,
  } satisfies ManagedServiceHandle;
  return {
    handle,
    request,
    publish(next: ManagedServiceSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener(next);
    },
  };
}

const healthy = (baseUrl = 'http://127.0.0.1:49196'): ManagedServiceSnapshot => ({
  id: 'opencode-server',
  state: 'healthy',
  mode: 'spawn',
  baseUrl,
  startedAtMs: 1,
  lastHealthyAtMs: 2,
  diagnostics: [],
  diagnosticsTruncated: false,
});

describe('OpenCode transport currentness through the exact public handle', () => {
  it('routes REST and streaming reads as relative requests through the exact handle', async () => {
    const exact = createHandle(healthy());
    const globalFetch = vi.fn(async () => {
      throw new Error('global fetch must not own managed OpenCode transport');
    });
    vi.stubGlobal('fetch', globalFetch);
    const ownerAbort = new AbortController();
    const callerAbort = new AbortController();
    const transport = createOpenCodeServerTransport({
      managedService: exact.handle,
      signal: ownerAbort.signal,
    });

    await transport.request({
      url: '/session/ses-1/message?directory=%2Frepo',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"parts":[]}',
      timeoutMs: 5_000,
      signal: callerAbort.signal,
    });
    await transport.fetch('/global/event', {
      method: 'GET',
      signal: callerAbort.signal,
    });

    expect(exact.request).toHaveBeenNthCalledWith(1, {
      pathAndQuery: '/session/ses-1/message?directory=%2Frepo',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode('{"parts":[]}'),
      timeoutMs: 5_000,
      signal: expect.any(AbortSignal),
    });
    expect(exact.request).toHaveBeenNthCalledWith(2, {
      pathAndQuery: '/global/event',
      method: 'GET',
      signal: expect.any(AbortSignal),
    });
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
