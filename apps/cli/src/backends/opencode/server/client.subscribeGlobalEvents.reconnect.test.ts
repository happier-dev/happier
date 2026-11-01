import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createManagedOpenCodeClientFixture, createOpenCodeSseResponse } from './managedOpenCodeClient.testkit';
import type { OpenCodeManagedServerIdentityChange } from './openCodeManagedServerIdentity';

type Stream = ReturnType<typeof createOpenCodeSseResponse> & { url: URL; headers: Headers; signal?: AbortSignal | null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

describe('createOpenCodeServerRuntimeClient event reconnects', () => {
  let fixture: Awaited<ReturnType<typeof createManagedOpenCodeClientFixture>>;
  let streams: Stream[];
  let requests: URL[];
  let respond: (url: URL, init?: RequestInit) => Promise<Response>;
  const originalFetch = globalThis.fetch;
  const originalReconnectBase = process.env.HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS;
  const originalReconnectMax = process.env.HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS;

  beforeEach(async () => {
    fixture = await createManagedOpenCodeClientFixture();
    streams = [];
    requests = [];
    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://127.0.0.1:9999';
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS = '5';
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS = '5';
    respond = async url => url.pathname === '/global/health'
      ? json({ healthy: true, version: 'fixture' }) : json({});
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      requests.push(url);
      if (url.pathname === '/event' || url.pathname === '/api/event') {
        const stream = { ...createOpenCodeSseResponse(init?.signal), url, headers: new Headers(init?.headers), signal: init?.signal };
        streams.push(stream);
        return stream.response;
      }
      return await respond(url, init);
    }) satisfies typeof fetch);
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const stream of streams) stream.close();
    await fixture.close();
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
    for (const [key, value] of [
      ['HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS', originalReconnectBase],
      ['HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS', originalReconnectMax],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const client = async (managed = false, onManagedServerIdentityChanged?: (change: OpenCodeManagedServerIdentityChange) => void) => {
    if (managed) delete process.env.HAPPIER_OPENCODE_SERVER_URL;
    return await fixture.createClient({ directory: '/tmp', messageBuffer: new MessageBuffer(), onManagedServerIdentityChanged });
  };
  const subscribe = async (value: Awaited<ReturnType<typeof client>>, onEvent = vi.fn()) => {
    const controller = new AbortController();
    await value.subscribeGlobalEvents({ signal: controller.signal, onEvent });
    await expect.poll(() => streams.length).toBe(1);
    return { controller, onEvent };
  };

  it('uses the instance stream and accepts only post-boundary events as live after every reconnect', async () => {
    const value = await client();
    const { onEvent } = await subscribe(value);
    const emit = (stream: Stream, suffix: string) => {
      stream.send({ type: 'session.error', properties: { sessionID: 'ses_1', error: { message: 'stale' } } }, `stale-${suffix}`);
      stream.send({ type: 'server.connected', properties: {} }, `boundary-${suffix}`);
      stream.send({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } }, `live-${suffix}`);
    };
    emit(streams[0]!, 'first');
    await expect.poll(() => onEvent.mock.calls.length).toBe(2);
    expect(`${streams[0]!.url.pathname}${streams[0]!.url.search}`).toBe('/event?directory=%2Ftmp');
    streams[0]!.fail();
    await expect.poll(() => streams.length).toBe(2);
    emit(streams[1]!, 'second');
    await expect.poll(() => onEvent.mock.calls.length).toBe(4);
    expect(streams.map(stream => stream.headers.get('Last-Event-ID'))).toEqual([null, null]);
    expect(onEvent.mock.calls.map(([event, delivery]) => [event.payload.type, event.directory, delivery.provenance])).toEqual([
      ['server.connected', '/tmp', 'connection-boundary'], ['session.status', '/tmp', 'accepted-live'],
      ['server.connected', '/tmp', 'connection-boundary'], ['session.status', '/tmp', 'accepted-live'],
    ]);
  });

  it.each([
    { initial: 'v1', next: 'v2', eof: false },
    { initial: 'v2', next: 'v1', eof: true },
  ] as const)('re-probes an external same-URL server after $initial changes to $next', async ({ initial, next, eof }) => {
    let generation: 'v1' | 'v2' = initial;
    respond = async url => {
      if (url.pathname === '/api/health') return json({ healthy: true }, generation === 'v2' ? 200 : 404);
      if (url.pathname === '/global/health') return json({ healthy: true, version: 'fixture' }, generation === 'v1' ? 200 : 404);
      return json(url.pathname === '/api/session' ? { data: [] } : []);
    };
    const value = await client();
    const { onEvent } = await subscribe(value);
    expect(streams[0]!.url.pathname).toBe(initial === 'v1' ? '/event' : '/api/event');
    generation = next;
    if (eof) streams[0]!.close(); else streams[0]!.fail();
    await expect.poll(() => streams.length).toBe(2);
    expect(streams[1]!.url.pathname).toBe(next === 'v1' ? '/event' : '/api/event');
    streams[1]!.send(next === 'v2' ? { type: 'server.connected', data: {} } : { type: 'server.connected', properties: {} });
    streams[1]!.send(next === 'v2'
      ? { type: 'session.text.delta', data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 0, delta: 'v2' } }
      : { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    await expect.poll(() => onEvent.mock.calls.some(([event]) => event.payload.type === (next === 'v2' ? 'message.part.delta' : 'session.status'))).toBe(true);
    await expect(value.sessionList()).resolves.toEqual([]);
    expect(requests.some(url => url.pathname === (next === 'v2' ? '/api/session' : '/session'))).toBe(true);
  });

  it('reopens the instance stream and requires a fresh boundary when directory changes', async () => {
    const value = await fixture.createClient({ directory: '/tmp/left', messageBuffer: new MessageBuffer() });
    const { onEvent } = await subscribe(value);
    streams[0]!.send({ type: 'server.connected', properties: {} });
    await expect.poll(() => onEvent.mock.calls.length).toBe(1);
    expect(value.setDirectoryOverride('/tmp/right')).toBe(true);
    await expect.poll(() => streams.length).toBe(2);
    expect(streams[0]!.signal?.aborted).toBe(true);
    expect(streams[1]!.url.searchParams.get('directory')).toBe('/tmp/right');
    streams[1]!.send({ type: 'session.error', properties: { sessionID: 'ses_1' } });
    streams[1]!.send({ type: 'server.connected', properties: {} });
    streams[1]!.send({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    await expect.poll(() => onEvent.mock.calls.length).toBe(3);
    expect(onEvent.mock.calls.map(([event, delivery]) => [event.payload.type, event.directory, delivery.provenance])).toEqual([
      ['server.connected', '/tmp/left', 'connection-boundary'], ['server.connected', '/tmp/right', 'connection-boundary'], ['session.idle', '/tmp/right', 'accepted-live'],
    ]);
    expect(value.setDirectoryOverride('/tmp/right')).toBe(false);
    expect(streams).toHaveLength(2);
  });

  it('dispose aborts reconnect sleep promptly', async () => {
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS = '5000';
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS = '5000';
    const value = await client();
    await subscribe(value);
    streams[0]!.fail();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    // Leave room for real owner-file/process cleanup, while distinguishing the 5s backoff.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        value.dispose(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Client disposal waited for SSE reconnect backoff')), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    expect(streams[0]!.signal?.aborted).toBe(true);
    expect(streams).toHaveLength(1);
  });

  it('refreshes the endpoint and emits one identity change when reconnect observes a replacement', async () => {
    const changes: OpenCodeManagedServerIdentityChange[] = [];
    const value = await client(true, change => changes.push(change));
    await subscribe(value);
    await fixture.publish({ baseUrl: 'http://127.0.0.1:10000', ownerToken: 'gen-B', startedAtMs: 2 });
    streams[0]!.fail();
    await expect.poll(() => streams.length).toBe(2);
    expect(streams[1]!.url.origin).toBe('http://127.0.0.1:10000');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.reason).toBe('sse_reconnect_state_refresh');
    expect(changes[0]!.previous?.generationKey).not.toBe(changes[0]!.current?.generationKey);
  });

  it.each(['missing', 'non-loopback'] as const)('does not ensure, replace, or publish an identity change from a %s reconnect state', async state => {
    const changes: OpenCodeManagedServerIdentityChange[] = [];
    const value = await client(true, change => changes.push(change));
    await subscribe(value);
    if (state === 'missing') await fixture.removeState();
    else await fixture.publish({ baseUrl: 'http://example.com:8080', ownerToken: 'gen-B', startedAtMs: 2 });
    const requestCount = requests.length;
    streams[0]!.fail();
    await expect.poll(() => streams.length).toBe(2);
    expect(streams[1]!.url.origin).toBe('http://127.0.0.1:9999');
    expect(requests.slice(requestCount).every(url => url.pathname === '/event')).toBe(true);
    if (state === 'missing') expect(existsSync(fixture.statePath)).toBe(false);
    expect(changes).toHaveLength(0);
  });

  it.each([['auto', '/event'], ['v2', '/api/event']] as const)('keeps the authenticated managed %s server dialect coherent without re-probing during reconnect', async (apiGeneration, eventPath) => {
    await fixture.publish({ apiGeneration });
    respond = async url => {
      if (url.pathname === '/global/health') {
        return apiGeneration === 'auto' ? json({ healthy: true, version: 'fixture' }) : json({}, 404);
      }
      return url.pathname === '/api/health' && apiGeneration === 'v2' ? json({ healthy: true }) : json({}, 404);
    };
    const value = await client(true);
    await subscribe(value);
    const count = requests.length;
    streams[0]!.fail();
    await expect.poll(() => streams.length).toBe(2);
    expect(streams.map(stream => stream.url.pathname)).toEqual([eventPath, eventPath]);
    expect(requests.slice(count).map(url => url.pathname)).toEqual([eventPath]);
  });

  it('never adopts managed lifecycle identity for an explicit endpoint', async () => {
    const changes: OpenCodeManagedServerIdentityChange[] = [];
    const value = await client(false, change => changes.push(change));
    await subscribe(value);
    await fixture.publish({ ownerToken: 'gen-B', startedAtMs: 2 });
    streams[0]!.fail();
    await expect.poll(() => streams.length).toBe(2);
    expect(value.getManagedServerIdentity()).toBeNull();
    expect(changes).toHaveLength(0);
  });

  it('emits one http_retry_ensure change when a failed request replaces a dead managed provider', async () => {
    const changes: OpenCodeManagedServerIdentityChange[] = [];
    let messages = 0;
    respond = async url => {
      if (url.pathname === '/global/health') return json({ healthy: true, version: 'fixture' });
      if (url.pathname.endsWith('/message')) {
        messages += 1;
        if (messages === 1) {
          await fixture.stopProvider();
          throw new TypeError('fetch failed');
        }
        return json([]);
      }
      return json({});
    };
    const value = await client(true, change => changes.push(change));
    await expect(value.sessionMessagesList({ sessionId: 'ses_1' })).resolves.toEqual([]);
    expect(messages).toBe(2);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.reason).toBe('http_retry_ensure');
    expect(value.getManagedServerIdentity()?.pid).not.toBe(fixture.pid);
    expect(value.getManagedServerIdentity()?.baseUrl).not.toBe('http://127.0.0.1:9999');
  });
});
