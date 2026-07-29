import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerOpenCodeManagedServerEndpoint,
} from '../../../runtime/server/endpoint.js';
import { createOpenCodeServerTransport } from '../../../runtime/server/transport.js';
import {
  createOpenCodeExternalSessionClient,
  validateOpenCodeExternalSessionsSource,
} from './client.js';

const endpointRegistrations: Array<Readonly<{ dispose: () => void }>> = [];

afterEach(() => {
  while (endpointRegistrations.length > 0) {
    endpointRegistrations.pop()?.dispose();
  }
  vi.unstubAllGlobals();
});

describe('validateOpenCodeExternalSessionsSource', () => {
  it('rejects malformed OpenCode source payload fields at the plugin boundary', () => {
    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', baseUrl: 42 },
    }).ok).toBe(false);

    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', directory: 42 },
    }).ok).toBe(false);

    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', directory: 'x'.repeat(10_001) },
    }).ok).toBe(false);
  });

  it('normalizes configured base URL while preserving a valid directory', () => {
    expect(validateOpenCodeExternalSessionsSource({
      source: {
        kind: 'opencodeServer',
        directory: ' /tmp/repo ',
      },
      env: {
        HAPPIER_OPENCODE_SERVER_URL: ' http://127.0.0.1:49196/?ignored=true#hash ',
      },
    })).toEqual({
      ok: true,
      source: {
        kind: 'opencodeServer',
        baseUrl: 'http://127.0.0.1:49196',
        directory: '/tmp/repo',
      },
    });
  });

  it('accepts a persisted canonical base URL only at the identity boundary', () => {
    const persistedSource = {
      kind: 'opencodeServer' as const,
      baseUrl: ' http://127.0.0.1:49196/ ',
      directory: ' /tmp/repo ',
    };

    expect(validateOpenCodeExternalSessionsSource({
      source: persistedSource,
      env: {},
    })).toEqual({
      ok: false,
      error: 'source baseUrl override is not allowed',
    });
    expect(validateOpenCodeExternalSessionsSource({
      source: persistedSource,
      env: {},
      baseUrlAuthority: 'canonical',
    })).toEqual({
      ok: true,
      source: {
        kind: 'opencodeServer',
        baseUrl: 'http://127.0.0.1:49196',
        directory: '/tmp/repo',
      },
    });
  });
});

describe('createOpenCodeExternalSessionClient', () => {
  const source = {
    kind: 'opencodeServer' as const,
    baseUrl: 'http://127.0.0.1:49196',
  };
  const env = {
    HAPPIER_OPENCODE_SERVER_URL: source.baseUrl,
  };

  it('keeps a successful empty status map distinct from a malformed successful response', async () => {
    const emptyClient = await createOpenCodeExternalSessionClient({
      source,
      env,
      fetchFn: async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await expect(emptyClient.sessionStatusList()).resolves.toEqual({});

    const malformedClient = await createOpenCodeExternalSessionClient({
      source,
      env,
      fetchFn: async () => new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await expect(malformedClient.sessionStatusList()).rejects.toThrow(
      'OpenCode /session/status returned an invalid status map',
    );
  });

  it('keeps status transport failure distinct from a successful empty status map', async () => {
    const client = await createOpenCodeExternalSessionClient({
      source,
      env,
      fetchFn: async () => new Response('unavailable', {
        status: 503,
        statusText: 'Service Unavailable',
      }),
    });

    await expect(client.sessionStatusList()).rejects.toThrow('503 Service Unavailable');
  });

  it('uses the current endpoint credential when reading the shared status map', async () => {
    const requests: RequestInit[] = [];
    const client = await createOpenCodeExternalSessionClient({
      source,
      env,
      headers: { authorization: 'Basic test-credential' },
      fetchFn: async (_input, init) => {
        requests.push(init ?? {});
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(client.sessionStatusList()).resolves.toEqual({});
    expect(requests).toEqual([
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Basic test-credential' },
      }),
    ]);
  });

  it('preserves status-specific fields after validating the common status shape', async () => {
    const client = await createOpenCodeExternalSessionClient({
      source,
      env,
      fetchFn: async () => new Response(JSON.stringify({
        'ses-retry': {
          type: 'retry',
          attempt: 2,
          message: 'waiting',
          next: 1_700_000_123_456,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });

    await expect(client.sessionStatusList()).resolves.toEqual({
      'ses-retry': {
        type: 'retry',
        attempt: 2,
        message: 'waiting',
        next: 1_700_000_123_456,
      },
    });
  });

  it('uses the official bounded session and opaque message paging queries', async () => {
    const requests: string[] = [];
    const client = await createOpenCodeExternalSessionClient({
      source: {
        ...source,
        directory: '/tmp/project',
      },
      env,
      fetchFn: async (input) => {
        requests.push(input);
        if (input.includes('/message')) {
          return new Response('[]', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-next-cursor': 'opaque-next',
            },
          });
        }
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await Reflect.apply(client.sessionList, undefined, [{
      limit: 7,
      search: 'needle',
    }]);
    const messagePage = await Reflect.apply(client.sessionMessagesList, undefined, [{
      sessionId: 'session/1',
      limit: 11,
      before: 'opaque-before',
    }]);

    expect(requests).toEqual([
      'http://127.0.0.1:49196/session?directory=%2Ftmp%2Fproject&limit=7&search=needle',
      'http://127.0.0.1:49196/session/session%2F1/message?directory=%2Ftmp%2Fproject&limit=11&before=opaque-before',
    ]);
    expect(messagePage).toEqual({
      items: [],
      nextCursor: 'opaque-next',
    });
  });

  it('routes every JSON operation through the registered endpoint-bound transport', async () => {
    const transportFetch = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/message')) {
        return new Response('[]', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-next-cursor': 'next-page',
          },
        });
      }
      if (url.pathname === '/session/status') {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.startsWith('/session/')) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const transport = createOpenCodeServerTransport({
      baseUrl: source.baseUrl,
      instanceId: 'registered-instance',
      readManagedServerSnapshot: () => ({
        instanceId: 'registered-instance',
        state: 'healthy',
        baseUrl: source.baseUrl,
      }),
      fetchImpl: transportFetch,
    });
    endpointRegistrations.push(registerOpenCodeManagedServerEndpoint({
      baseUrl: source.baseUrl,
      credential: null,
      transport,
    }));
    const fallbackFetch = vi.fn(async () => {
      throw new Error('global/fallback fetch must not run');
    });

    const client = await createOpenCodeExternalSessionClient({
      source,
      env,
      fetchFn: fallbackFetch,
    });
    await client.sessionList({ limit: 1 });
    await client.sessionGet({ sessionId: 'session-1' });
    await client.sessionStatusList();
    await expect(client.sessionMessagesList({
      sessionId: 'session-1',
      limit: 1,
    })).resolves.toEqual({
      items: [],
      nextCursor: 'next-page',
    });

    expect(transportFetch).toHaveBeenCalledTimes(4);
    expect(fallbackFetch).not.toHaveBeenCalled();
  });

  it('captures one endpoint registration and fails closed instead of jumping to a same-base replacement', async () => {
    let firstState = 'healthy';
    const firstNetworkFetch = vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const firstTransport = createOpenCodeServerTransport({
      baseUrl: source.baseUrl,
      instanceId: 'first-instance',
      readManagedServerSnapshot: () => ({
        instanceId: 'first-instance',
        state: firstState,
        baseUrl: source.baseUrl,
      }),
      fetchImpl: firstNetworkFetch,
    });
    endpointRegistrations.push(registerOpenCodeManagedServerEndpoint({
      baseUrl: source.baseUrl,
      credential: null,
      transport: firstTransport,
    }));
    const client = await createOpenCodeExternalSessionClient({ source, env });

    const secondNetworkFetch = vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    endpointRegistrations.push(registerOpenCodeManagedServerEndpoint({
      baseUrl: source.baseUrl,
      credential: null,
      transport: createOpenCodeServerTransport({
        baseUrl: source.baseUrl,
        instanceId: 'second-instance',
        readManagedServerSnapshot: () => ({
          instanceId: 'second-instance',
          state: 'healthy',
          baseUrl: source.baseUrl,
        }),
        fetchImpl: secondNetworkFetch,
      }),
    }));
    firstState = 'stopped';

    await expect(client.sessionList({ limit: 1 })).rejects.toThrow(
      /incarnation is stale/u,
    );
    expect(firstNetworkFetch).not.toHaveBeenCalled();
    expect(secondNetworkFetch).not.toHaveBeenCalled();
  });
});
