import { describe, expect, it, vi } from 'vitest';

import { createOpenCodeServerTransport } from './transport.js';

describe('createOpenCodeServerTransport', () => {
  it('binds JSON and stream fetches to the supervised endpoint and per-boot credential', async () => {
    const body = new Uint8Array([0, 1, 2, 255]);
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const transport = createOpenCodeServerTransport({
      baseUrl: 'http://127.0.0.1:49196/',
      instanceId: 'instance-1',
      headers: { authorization: 'Basic current-boot' },
      readManagedServerSnapshot: () => ({
        instanceId: 'instance-1',
        state: 'healthy',
        baseUrl: 'http://127.0.0.1:49196',
      }),
      fetchImpl,
    });

    await transport.request({
      url: 'http://127.0.0.1:49196/session',
      method: 'POST',
      headers: { authorization: 'Basic caller-must-not-override' },
      body,
    });
    await transport.fetch('http://127.0.0.1:49196/global/event', {
      method: 'GET',
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:49196/session',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body,
        headers: expect.any(Headers),
      }),
    );
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('authorization'))
      .toBe('Basic current-boot');
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get('authorization'))
      .toBe('Basic current-boot');
  });

  it('fails closed before dispatch when the endpoint or SVC09 incarnation is stale', async () => {
    let instanceId = 'instance-1';
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('{}'));
    const transport = createOpenCodeServerTransport({
      baseUrl: 'http://127.0.0.1:49196',
      instanceId: 'instance-1',
      readManagedServerSnapshot: () => ({
        instanceId,
        state: 'healthy',
        baseUrl: 'http://127.0.0.1:49196',
      }),
      fetchImpl,
    });

    await expect(transport.fetch('http://127.0.0.1:49197/session'))
      .rejects.toThrow(/outside its supervised endpoint/u);

    instanceId = 'instance-2';
    await expect(transport.request({
      url: 'http://127.0.0.1:49196/session',
      method: 'GET',
    })).rejects.toThrow(/incarnation is stale/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
