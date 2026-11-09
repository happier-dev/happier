import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchCliHomeAuthEntry } from './cliAuthEntryClient';

afterEach(() => vi.unstubAllGlobals());

describe('fetchCliHomeAuthEntry', () => {
  it('preserves a typed redirect refusal instead of reporting discovery unavailable', async () => {
    let redirectMode: RequestRedirect | undefined;
    vi.stubGlobal('fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      redirectMode = init?.redirect;
      return new Response(null, { status: 302, headers: { Location: 'https://other.example.test/?secret=private' } });
    });
    await expect(fetchCliHomeAuthEntry({ serverUrl: 'https://accounts.example.test' })).rejects.toMatchObject({
      code: 'credential_request_redirect_refused', retryable: false, status: 302,
    });
    expect(redirectMode).toBe('manual');
  });

  it('propagates caller cancellation instead of reporting the Account Service unavailable', async () => {
    const caller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => {
          reject(new DOMException('Auth entry request aborted', 'AbortError'));
        }, { once: true });
      });
    }));
    const pending = fetchCliHomeAuthEntry({
      serverUrl: 'https://accounts.example.test',
      signal: caller.signal,
    });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    const cancellation = new DOMException('Caller cancelled auth entry discovery', 'AbortError');
    caller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
  });

  it('keeps the request-owned deadline classified as unavailable', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Auth entry request timed out', 'AbortError'));
          }, { once: true });
        });
      }));
      const pending = fetchCliHomeAuthEntry({
        serverUrl: 'https://accounts.example.test',
        timeoutMs: 1,
      });

      await vi.advanceTimersByTimeAsync(1_001);

      await expect(pending).resolves.toEqual({ kind: 'unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the complete contextual Home method projection', async () => {
    const request = vi.fn(async () => Response.json({
      v: 1,
      scope: { kind: 'home' },
      state: 'ready',
      actions: [{
        kind: 'authenticate',
        methodId: 'email_password',
        action: 'login',
        mode: 'either',
        origin: 'home',
        presentation: { displayName: 'Email' },
      }],
      autoRedirect: null,
    }));
    vi.stubGlobal('fetch', request);

    await expect(fetchCliHomeAuthEntry({
      serverUrl: 'https://accounts.example.test/',
      purpose: 'account_service',
    })).resolves.toMatchObject({
      kind: 'ready',
      projection: { state: 'ready', actions: [{ methodId: 'email_password' }] },
    });
    expect(request).toHaveBeenCalledWith(
      'https://accounts.example.test/v1/auth/entry',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ v: 1, scope: { kind: 'home' }, purpose: 'account_service' }) }),
    );
  });

  it.each([404, 405, 501])('marks only status %i as unsupported', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
    await expect(fetchCliHomeAuthEntry({ serverUrl: 'https://accounts.example.test' }))
      .resolves.toEqual({ kind: 'unsupported' });
  });

  it('fails closed on a malformed successful response and other HTTP failures', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ state: 'ready' }))
      .mockResolvedValueOnce(Response.json({
        v: 1,
        state: 'admission_required',
        scope: { kind: 'team' },
        home: { serverId: 'home_1', displayName: 'Acme Home', storageMode: 'plain' },
        team: { teamId: 'team_1', name: 'Acme', logo: null },
        actions: [],
        autoRedirect: null,
      }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', request);
    await expect(fetchCliHomeAuthEntry({ serverUrl: 'https://accounts.example.test' }))
      .resolves.toEqual({ kind: 'incompatible' });
    await expect(fetchCliHomeAuthEntry({ serverUrl: 'https://accounts.example.test' }))
      .resolves.toEqual({ kind: 'incompatible' });
    await expect(fetchCliHomeAuthEntry({ serverUrl: 'https://accounts.example.test' }))
      .resolves.toEqual({ kind: 'unavailable' });
  });
});
