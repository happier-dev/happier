import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveLoopbackHttpUrlMock = vi.hoisted(() => vi.fn((url: string) => url));
const descriptorRuntimeMock = vi.hoisted(() => ({
  acquire: vi.fn(),
  resolveTarget: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('@/api/client/loopbackUrl', () => ({
  resolveLoopbackHttpUrl: resolveLoopbackHttpUrlMock,
}));
vi.mock('@/auth/terminalAuthEnrollmentRuntime', () => ({
  acquireTerminalAuthEnrollmentRuntime: descriptorRuntimeMock.acquire,
}));
vi.mock('@/auth/terminalAuthEnrollmentClient', () => ({
  verifyTerminalAuthEnrollmentRuntime: descriptorRuntimeMock.verify,
}));
vi.mock('@/server/homeTarget', () => ({
  resolveCurrentCliHomeTarget: descriptorRuntimeMock.resolveTarget,
}));

describe('validateStoredAuthTokenAgainstActiveServer', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('HAPPIER_SERVER_URL', 'https://active.example.test');
    resolveLoopbackHttpUrlMock.mockClear();
    resolveLoopbackHttpUrlMock.mockImplementation((url: string) => url);
    descriptorRuntimeMock.acquire.mockReset();
    descriptorRuntimeMock.resolveTarget.mockResolvedValue({
      descriptor: null,
      applicationUrl: 'https://active.example.test',
    });
    descriptorRuntimeMock.verify.mockReset();
  });

  afterEach(() => {
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, 'fetch');
    } else {
      global.fetch = originalFetch;
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns invalid for 403 profile responses', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ code: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;

    const { validateStoredAuthTokenAgainstActiveServer } = await import('./validateStoredAuthTokenAgainstActiveServer');
    await expect(validateStoredAuthTokenAgainstActiveServer('token-123')).resolves.toEqual({
      state: 'invalid',
      httpStatus: 403,
      reasonCode: 'forbidden',
    });
  });

  it('returns unknown for transport failures instead of forcing invalid auth', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    const { validateStoredAuthTokenAgainstActiveServer } = await import('./validateStoredAuthTokenAgainstActiveServer');
    await expect(validateStoredAuthTokenAgainstActiveServer('token-123')).resolves.toEqual({
      state: 'unknown',
      httpStatus: null,
      reasonCode: 'TypeError',
    });
  });

  it('preserves a typed redirect refusal for an injected profile transport', async () => {
    const transport: typeof fetch = async () => new Response(null, { status: 307, headers: { location: 'https://other.example.test/?token=hidden' } });
    const { validateStoredAuthTokenAgainstServer } = await import('./validateStoredAuthTokenAgainstActiveServer');
    await expect(validateStoredAuthTokenAgainstServer({ token: 'fixture', baseUrl: 'https://home.example.test', fetchImpl: transport }))
      .rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status: 307 });
  });

  it('propagates caller cancellation through the active Home profile request', async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    global.fetch = vi.fn(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
      });
    }) as typeof fetch;

    const { validateStoredAuthTokenAgainstActiveServer } = await import('./validateStoredAuthTokenAgainstActiveServer');
    const pending = validateStoredAuthTokenAgainstActiveServer('token-123', caller.signal);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    caller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('fails fast for missing tokens without calling fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    const { validateStoredAuthTokenAgainstActiveServer } = await import('./validateStoredAuthTokenAgainstActiveServer');
    await expect(validateStoredAuthTokenAgainstActiveServer('   ')).resolves.toEqual({
      state: 'invalid',
      httpStatus: 401,
      reasonCode: 'missing-token',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates an explicit profile without consulting the active-server URL', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'account-explicit' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;

    const { validateStoredAuthTokenAgainstServer } = await import('./validateStoredAuthTokenAgainstActiveServer');
    await expect(validateStoredAuthTokenAgainstServer({
      token: 'token-explicit',
      baseUrl: 'https://other.example.test/',
      fetchImpl: fetchMock,
    })).resolves.toMatchObject({ state: 'valid', httpStatus: 200 });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://other.example.test/v1/account/profile',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-explicit' }),
      }),
    );
  });

  it('returns a readable account label from the same profile read (username, else display name, never email)', async () => {
    const { validateStoredAuthTokenAgainstServer } = await import('./validateStoredAuthTokenAgainstActiveServer');
    const respond = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    await expect(validateStoredAuthTokenAgainstServer({
      token: 't', baseUrl: 'https://h.example.test', fetchImpl: respond({ id: 'a1', username: 'alice', firstName: 'Alice', lastName: 'Liddell' }),
    })).resolves.toMatchObject({ state: 'valid', accountLabel: 'alice' });
    await expect(validateStoredAuthTokenAgainstServer({
      token: 't', baseUrl: 'https://h.example.test', fetchImpl: respond({ id: 'a1', username: null, firstName: ' Alice ', lastName: 'Liddell' }),
    })).resolves.toMatchObject({ state: 'valid', accountLabel: 'Alice Liddell' });
    await expect(validateStoredAuthTokenAgainstServer({
      token: 't', baseUrl: 'https://h.example.test', fetchImpl: respond({ id: 'a1', email: 'alice@example.test' }),
    })).resolves.toMatchObject({ state: 'valid', accountLabel: null });
  });

  it('validates an active descriptor Home through its authenticated carrier and closes it once', async () => {
    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_stored_iroh_home',
      canonicalServerUrl: 'http://localhost:3010',
      revision: 2,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'e'.repeat(64) }],
    };
    const close = vi.fn(async () => {});
    descriptorRuntimeMock.resolveTarget.mockResolvedValue({
      descriptor,
      applicationUrl: descriptor.canonicalServerUrl,
      preferredTransport: 'iroh',
    });
    descriptorRuntimeMock.acquire.mockResolvedValue({
      ok: true,
      runtime: {
        runtimeOrigin: 'http://127.0.0.1:49123',
        carrier: 'iroh',
        authenticatedCredentialDestination: { kind: 'iroh', endpointId: 'e'.repeat(64) },
      },
      close,
    });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'account-iroh' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const { validateStoredAuthTokenAgainstActiveServer } = await import('./validateStoredAuthTokenAgainstActiveServer');
    await expect(validateStoredAuthTokenAgainstActiveServer('token-iroh')).resolves.toMatchObject({
      state: 'valid',
      httpStatus: 200,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:49123/v1/account/profile',
      expect.anything(),
    );
    expect(descriptorRuntimeMock.verify).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
