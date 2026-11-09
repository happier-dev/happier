import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries/registrySourcesV1';
import { createCliRegistryHostV1 } from './createCliRegistryHost';

afterEach(() => vi.restoreAllMocks());

describe('daemon admitted immutable app catalog reads', () => {
  function fixture(id: string) {
    const first = 'a'.repeat(40), next = 'b'.repeat(40);
    let head = first;
    const source: RegistrySourceDescriptorV1 = { id, title: 'Apps', format: 'coolify-templates', kinds: ['app'],
      url: `https://github.com/${id}/catalog`, enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
    const calls: string[] = [];
    let bodyGate: Promise<void> | undefined;
    let limited = false;
    let bodyLimited = false;
    let bodyUnavailable = false;
    const retryAt = Date.now() + 60_000;
    // Network is the boundary; admission, catalog parsing and app normalization are real.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input); calls.push(url);
      if (url.includes('/commits/')) return limited
        ? new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(retryAt / 1000)) } })
        : Response.json({ sha: url.endsWith('/HEAD') ? head : url.split('/').at(-1) });
      if (url.endsWith('/service-templates.json')) return Response.json({ app: { name: 'App', slogan: 'Status' } });
      if (url.endsWith('/app.yaml')) {
        if (bodyGate) await new Promise<void>((resolve, reject) => {
          const abort = () => reject(init?.signal?.reason);
          init?.signal?.addEventListener('abort', abort, { once: true });
          bodyGate.then(resolve, reject).finally(() => init?.signal?.removeEventListener('abort', abort));
        });
        if (bodyLimited) return new Response('', { status: 429,
          headers: { 'x-ratelimit-reset': String(Math.ceil(retryAt / 1000)) } });
        if (bodyUnavailable) return new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError('Response body transport failed')); },
        }));
        return new Response('services:\n  app:\n    image: nginx:1\n');
      }
      throw new Error(`Unexpected catalog request: ${url}`);
    });
    const host = (signal?: AbortSignal) => createCliRegistryHostV1({ readSources: async () => [source], signal });
    const read = (version = first, signal?: AbortSignal) => host(signal).fetchRequest({ op: 'read', kind: 'app', sourceId: id, itemId: 'app', version });
    const list = (query?: string) => host().fetchRequest({ op: 'list', kind: 'app', sourceId: id, ...(query === undefined ? {} : { query }) });
    return { first, next, calls, read, list, retryAt,
      setHead(value: string) { head = value; }, setLimited() { limited = true; },
      setBodyLimited(value: boolean) { bodyLimited = value; },
      setBodyUnavailable(value: boolean) { bodyUnavailable = value; },
      holdBody(gate: Promise<void>) { bodyGate = gate; } };
  }

  it('shares one index and YAML across separate preparation hosts, including concurrent readers, without resolving a full pin', async () => {
    const f = fixture('shared-preparations');
    const results = await Promise.all(Array.from({ length: 4 }, () => f.read()));
    for (const result of results) expect(result).toMatchObject({ op: 'read', item: { payload: { kind: 'app', state: 'ready' } } });
    expect(await f.read()).toMatchObject({ op: 'read', item: { payload: { state: 'ready' } } });
    expect(f.calls).toEqual([
      `https://raw.githubusercontent.com/shared-preparations/catalog/${f.first}/templates/service-templates.json`,
      `https://raw.githubusercontent.com/shared-preparations/catalog/${f.first}/templates/compose/app.yaml`,
    ]);
  });

  it('cancels one host locally while another finishes the same cold catalog read', async () => {
    const f = fixture('independent-cancellation');
    const firstController = new AbortController();
    const secondController = new AbortController();
    const cancellation = new Error('A cancelled');
    let release!: () => void;
    f.holdBody(new Promise<void>(resolve => { release = resolve; }));
    const first = f.read(f.first, firstController.signal);
    const firstCancelled = expect(first).rejects.toBe(cancellation);
    await vi.waitFor(() => expect(f.calls.some(url => url.endsWith('/app.yaml'))).toBe(true));
    const second = f.read(f.first, secondController.signal);
    const secondFinished = expect(second).resolves.toMatchObject({ op: 'read', item: { payload: { state: 'ready' } } });
    // Admission uses immediate promises; let the second host join the held HTTP read.
    await new Promise<void>(resolve => setImmediate(resolve));
    firstController.abort(cancellation);
    try {
      // The cancelled caller settles before the upstream response is released.
      await firstCancelled;
    } finally { release(); }
    await secondFinished;
    expect(secondController.signal.aborted).toBe(false);
    expect(f.calls.filter(url => url.endsWith('/service-templates.json'))).toHaveLength(1);
    expect(f.calls.filter(url => url.endsWith('/app.yaml'))).toHaveLength(1);
  });

  it('settles a shared response-body failure as unreachable and lets an explicit read recover', async () => {
    const f = fixture('body-transport-recovery');
    f.setBodyUnavailable(true);
    expect(await f.read()).toEqual({ op: 'error', status: { state: 'unreachable' } });
    f.setBodyUnavailable(false);
    expect(await f.read()).toMatchObject({ op: 'read', item: { payload: { state: 'ready' } } });
    expect(f.calls.filter(url => url.endsWith('/service-templates.json'))).toHaveLength(1);
    expect(f.calls.filter(url => url.endsWith('/app.yaml'))).toHaveLength(2);
  });

  it('acquires one index per source commit across browse and changing search terms, and only the selected body', async () => {
    const f = fixture('search-cost');
    for (const query of ['', 'Sta', 'Status', 'unrelated', 'App']) {
      const result = await f.list(query);
      expect(result).toMatchObject({ op: 'list', page: { status: { state: 'ok' }, total: query === 'unrelated' ? 0 : 1 } });
    }
    expect(f.calls.filter(url => url.endsWith('/service-templates.json'))).toHaveLength(1);
    expect(f.calls.filter(url => url.endsWith('/app.yaml'))).toHaveLength(0);
    expect(f.calls.filter(url => url.includes('/commits/'))).toHaveLength(5);
    expect(await f.read()).toMatchObject({ op: 'read', item: { payload: { state: 'ready' } } });
    expect(f.calls.filter(url => url.endsWith('/app.yaml'))).toHaveLength(1);
    f.setHead(f.next);
    expect(await f.list('Status')).toMatchObject({ op: 'list', page: { items: [{ version: f.next }] } });
    expect(f.calls.filter(url => url.endsWith('/service-templates.json'))).toHaveLength(2);
  });

  it('retains an old SHA only while a read uses it, then releases it when currentness has moved', async () => {
    const f = fixture('revision-retirement');
    let release!: () => void;
    f.holdBody(new Promise<void>(resolve => { release = resolve; }));
    const active = f.read();
    await vi.waitFor(() => expect(f.calls.some(url => url.endsWith('/app.yaml'))).toBe(true));
    f.setHead(f.next);
    expect(await f.list()).toMatchObject({ op: 'list', page: { items: [{ version: f.next }] } });
    const overlapping = f.read();
    release();
    expect(await active).toMatchObject({ op: 'read' });
    expect(await overlapping).toMatchObject({ op: 'read' });
    expect(f.calls.filter(url => url.includes(`/${f.first}/`))).toHaveLength(2);
    expect(await f.read(f.next)).toMatchObject({ op: 'read' });
    expect(f.calls.filter(url => url.includes(`/${f.next}/`))).toHaveLength(2);
    expect(await f.read()).toMatchObject({ op: 'read' });
    expect(f.calls.filter(url => url.includes(`/${f.first}/`))).toHaveLength(4);
    expect(f.calls.filter(url => url.includes('/commits/'))).toHaveLength(1);
  });

  it('retains a newly supplied listing pin without a daemon HEAD check and releases the previous inactive revision', async () => {
    const f = fixture('new-listing-pin');
    expect(await f.read()).toMatchObject({ op: 'read' });
    for (let i = 0; i < 3; i++) expect(await f.read(f.next)).toMatchObject({ op: 'read' });
    expect(f.calls.filter(url => url.includes(`/${f.next}/`))).toHaveLength(2);
    expect(f.calls.filter(url => url.includes('/commits/'))).toHaveLength(0);
    expect(await f.read()).toMatchObject({ op: 'read' });
    expect(f.calls.filter(url => url.includes(`/${f.first}/`))).toHaveLength(4);
  });

  it('settles a reset-proven API refusal once and continues serving an admitted pin', async () => {
    const f = fixture('limited-currentness');
    expect(await f.read()).toMatchObject({ op: 'read' });
    f.setLimited();
    const expected = { op: 'list', page: { status: { state: 'rate_limited', retryAt: Math.ceil(f.retryAt / 1000) * 1000 } } };
    expect(await f.list()).toMatchObject(expected);
    expect(await f.list()).toMatchObject(expected);
    expect(await f.read()).toMatchObject({ op: 'read', item: { payload: { state: 'ready' } } });
    expect(f.calls.filter(url => url.includes('/commits/'))).toHaveLength(1);
    expect(f.calls.filter(url => url.includes('raw.githubusercontent.com'))).toHaveLength(2);
  });

  it('settles a rate-limited YAML read without a loop and lets an explicit read recover at the upstream reset', async () => {
    const f = fixture('limited-template');
    f.setBodyLimited(true);
    const retryAt = Math.ceil(f.retryAt / 1000) * 1000;
    const failure = { op: 'error', status: { state: 'rate_limited', retryAt } };
    expect(await f.read()).toEqual(failure);
    expect(await f.read()).toEqual(failure);
    expect(f.calls.filter(url => url.endsWith('/app.yaml'))).toHaveLength(1);
    f.setBodyLimited(false);
    vi.spyOn(Date, 'now').mockReturnValue(retryAt);
    expect(await f.read()).toMatchObject({ op: 'read', item: { payload: { state: 'ready' } } });
    expect(f.calls.filter(url => url.endsWith('/app.yaml'))).toHaveLength(2);
    expect(f.calls.filter(url => url.endsWith('/service-templates.json'))).toHaveLength(1);
    expect(f.calls.filter(url => url.includes('/commits/'))).toHaveLength(0);
  });
});
