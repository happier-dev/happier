import { describe, expect, it, vi } from 'vitest';
import type {
  ManagedServiceHandle,
  ManagedServiceRequest,
  ManagedServiceResponse,
  ManagedServiceSnapshot,
} from '@happier-dev/plugin-sdk/managed-services';

import { createOpenCodeServerTransport } from './transport.js';

function response(body = '{}'): ManagedServiceResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: new Response(body).body,
  };
}

function managedService(request: (input: ManagedServiceRequest) => Promise<ManagedServiceResponse>): ManagedServiceHandle {
  const current = snapshot();
  return {
    snapshot: () => current,
    observe: (listener) => {
      listener(current);
      return { dispose() {} };
    },
    waitUntilHealthy: async () => current,
    stop: async () => ({ status: 'stopped' }),
    dispose: async () => undefined,
    request,
  };
}

function snapshot(): ManagedServiceSnapshot {
  return {
    id: 'opencode-server',
    state: 'healthy',
    mode: 'spawn',
    baseUrl: 'http://127.0.0.1:49196',
    startedAtMs: 1,
    lastHealthyAtMs: 2,
    diagnostics: [],
    diagnosticsTruncated: false,
  };
}

describe('createOpenCodeServerTransport', () => {
  it('normalizes JSON and stream request bodies before delegating to the exact handle', async () => {
    const body = new Uint8Array([0, 1, 2, 255]);
    const request = vi.fn(async (_input: ManagedServiceRequest) => response(JSON.stringify({ ok: true })));
    const transport = createOpenCodeServerTransport({
      managedService: managedService(request),
    });

    await transport.request({
      url: '/session',
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
    await transport.fetch('/global/event', {
      method: 'POST',
      body: 'stream-body',
    });

    expect(request).toHaveBeenNthCalledWith(1, {
      pathAndQuery: '/session',
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      pathAndQuery: '/global/event',
      method: 'POST',
      body: new TextEncoder().encode('stream-body'),
    });
  });

  it('propagates stale or disposed exact-handle failures without a fallback dispatch', async () => {
    const request = vi.fn(async () => {
      throw new Error('plugin_managed_service_not_reusable');
    });
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    const transport = createOpenCodeServerTransport({
      managedService: managedService(request),
    });

    await expect(transport.request({
      url: '/session',
      method: 'GET',
    })).rejects.toThrow('plugin_managed_service_not_reusable');
    expect(request).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('composes owner and caller cancellation for the delegated request', async () => {
    let delegatedSignal: AbortSignal | undefined;
    const request = vi.fn(async (input: ManagedServiceRequest) => {
      delegatedSignal = input.signal;
      return response();
    });
    const owner = new AbortController();
    const caller = new AbortController();
    const transport = createOpenCodeServerTransport({
      managedService: managedService(request),
      signal: owner.signal,
    });

    await transport.request({ url: '/session', signal: caller.signal });
    expect(delegatedSignal?.aborted).toBe(false);
    caller.abort();
    expect(delegatedSignal?.aborted).toBe(true);
  });
});
