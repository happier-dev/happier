import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenCodeExternalSessionClient,
  validateOpenCodeExternalSessionsSource,
} from './client.js';

afterEach(() => {
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

    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', managedEndpoint: false },
    }).ok).toBe(false);

    expect(validateOpenCodeExternalSessionsSource({
      source: {
        kind: 'opencodeServer',
        baseUrl: 'http://127.0.0.1:49196',
        managedEndpoint: true,
      },
    }).ok).toBe(false);
  });

  it('does not promote a configured managed endpoint URL into source data', () => {
    const source = {
      kind: 'opencodeServer' as const,
      directory: ' /tmp/repo ',
      endpointUrl: 'http://127.0.0.1:49196',
      token: 'must-not-survive',
      handle: 'must-not-survive',
      pid: 123,
      custody: 'must-not-survive',
    };
    const expected = {
      ok: true,
      source: {
        kind: 'opencodeServer',
        managedEndpoint: true,
        directory: '/tmp/repo',
      },
    };

    expect(validateOpenCodeExternalSessionsSource({
      source,
      env: {
        HAPPIER_OPENCODE_SERVER_URL: ' http://127.0.0.1:49196/?ignored=true#hash ',
      },
    })).toEqual(expected);
    expect(validateOpenCodeExternalSessionsSource({
      source: {
        ...source,
      },
      env: {
        HAPPIER_OPENCODE_SERVER_URL: 'not a URL',
      },
    })).toEqual(expected);
  });

  /**
   * The rule the daemon enforces has to be stated where the user's value is
   * accepted, and it has to name what is wrong. Otherwise the first thing the
   * user sees is `plugin_managed_server_endpoint_denied` from inside the
   * process supervisor.
   */
  it('names why a base URL is refused instead of deferring to the supervisor', () => {
    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', baseUrl: 'http://opencode:secret@192.168.1.50:4096' },
    })).toEqual({
      ok: false,
      error: 'source baseUrl must not embed a username or password; put the server password in the OpenCode server password setting',
    });

    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', baseUrl: 'ftp://192.168.1.50:4096' },
    })).toEqual({
      ok: false,
      error: 'source baseUrl must be an http or https URL',
    });

    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', baseUrl: 'not a url' },
    })).toEqual({
      ok: false,
      error: 'source baseUrl must be an absolute URL, for example http://192.168.1.50:4096',
    });
  });

  it('accepts loopback HTTP and remote HTTPS while refusing LAN HTTP', () => {
    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', baseUrl: ' http://127.0.0.1:4096/ ' },
    })).toEqual({
      ok: true,
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' },
    });

    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', baseUrl: 'http://192.168.1.50:4096' },
    })).toEqual({
      ok: false,
      error: 'source baseUrl must name a host',
    });

    expect(validateOpenCodeExternalSessionsSource({
      source: { kind: 'opencodeServer', baseUrl: 'https://opencode.example.com' },
    })).toEqual({
      ok: true,
      source: { kind: 'opencodeServer', baseUrl: 'https://opencode.example.com' },
    });
  });

  it('normalizes an explicitly supplied external base URL', () => {
    const persistedSource = {
      kind: 'opencodeServer' as const,
      baseUrl: ' http://127.0.0.1:49196/ ',
      directory: ' /tmp/repo ',
    };

    expect(validateOpenCodeExternalSessionsSource({
      source: persistedSource,
      env: {
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:59196',
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
});

describe('createOpenCodeExternalSessionClient', () => {
  const source = {
    kind: 'opencodeServer' as const,
    baseUrl: 'http://127.0.0.1:49196',
  };
  const env = {
    HAPPIER_OPENCODE_SERVER_URL: source.baseUrl,
  };

  /**
   * Every read — attached server or owned one — is served by the host managed
   * endpoint, so the tests drive that seam rather than a client-owned fetch.
   */
  const managedRead = (
    respond: (pathAndQuery: string) => Response,
  ) => vi.fn(async ({ pathAndQuery }: Readonly<{ pathAndQuery: string }>) => {
    const response = respond(pathAndQuery);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: response.body,
    };
  });

  function chunkedResponse(params: Readonly<{
    chunks: readonly string[];
    status?: number;
    statusText?: string;
  }>) {
    const encoder = new TextEncoder();
    let nextChunk = 0;
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = params.chunks[nextChunk];
        nextChunk += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunk));
      },
      cancel(reason) {
        cancelled(reason);
      },
    });
    return {
      response: new Response(body, {
        status: params.status ?? 200,
        statusText: params.statusText,
        headers: { 'content-type': 'application/json' },
      }),
      cancelled,
    };
  }

  it('routes an unmarked external attach through the managed endpoint, never a client-owned fetch', async () => {
    const directFetch = vi.fn();
    vi.stubGlobal('fetch', directFetch);
    const managedEndpointRead = managedRead(() => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const client = await createOpenCodeExternalSessionClient({
      source,
      env,
      managedEndpointRead,
    });
    await expect(client.sessionStatusList()).resolves.toEqual({});
    expect(managedEndpointRead).toHaveBeenCalledOnce();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('keeps a successful empty status map distinct from a malformed successful response', async () => {
    const emptyClient = await createOpenCodeExternalSessionClient({
      source,
      env,
      managedEndpointRead: managedRead(() => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    });
    await expect(emptyClient.sessionStatusList()).resolves.toEqual({});

    const malformedClient = await createOpenCodeExternalSessionClient({
      source,
      env,
      managedEndpointRead: managedRead(() => new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    });
    await expect(malformedClient.sessionStatusList()).rejects.toThrow(
      'OpenCode /session/status returned an invalid status map',
    );
  });

  it('rejects successful non-array session and message payloads instead of treating them as empty', async () => {
    const sessionClient = await createOpenCodeExternalSessionClient({
      source,
      env,
      managedEndpointRead: managedRead(() => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    });
    const messageClient = await createOpenCodeExternalSessionClient({
      source,
      env,
      managedEndpointRead: managedRead(() => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    });

    await expect(sessionClient.sessionList({ limit: 1 })).rejects.toThrow();
    await expect(messageClient.sessionMessagesList({
      sessionId: 'session-1',
      limit: 1,
    })).rejects.toThrow();
  });

  it('keeps status transport failure distinct from a successful empty status map', async () => {
    const client = await createOpenCodeExternalSessionClient({
      source,
      env,
      managedEndpointRead: managedRead(() => new Response('unavailable', {
        status: 503,
        statusText: 'Service Unavailable',
      })),
    });

    await expect(client.sessionStatusList()).rejects.toThrow('503 Service Unavailable');
  });

  it('routes managed JSON operations through the invocation-bound endpoint reader', async () => {
    const directFetch = vi.fn();
    const requests: string[] = [];
    const managedEndpointRead = vi.fn(async ({ pathAndQuery }: Readonly<{
      pathAndQuery: string;
    }>) => {
      requests.push(pathAndQuery);
      const isMessages = pathAndQuery.includes('/message');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'application/json',
          ...(isMessages ? { 'x-next-cursor': 'managed-next' } : {}),
        },
        body: new Response(isMessages ? '[]' : '{}').body,
      };
    });
    vi.stubGlobal('fetch', directFetch);
    const client = await createOpenCodeExternalSessionClient({
      source: {
        kind: 'opencodeServer',
        managedEndpoint: true,
        directory: '/tmp/project',
      },
      env,
      managedEndpointRead,
    });

    await expect(client.sessionGet({ sessionId: 'session/1' })).resolves.toEqual({});
    await expect(client.sessionStatusList()).resolves.toEqual({});
    await expect(client.sessionMessagesList({
      sessionId: 'session/1',
      limit: 2,
    })).resolves.toEqual({ items: [], nextCursor: 'managed-next' });
    expect(requests).toEqual([
      '/session/session%2F1?directory=%2Ftmp%2Fproject',
      '/session/status?directory=%2Ftmp%2Fproject',
      '/session/session%2F1/message?directory=%2Ftmp%2Fproject&limit=2',
    ]);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('fails a managed read closed without falling back to direct fetch', async () => {
    const directFetch = vi.fn();
    vi.stubGlobal('fetch', directFetch);
    const client = await createOpenCodeExternalSessionClient({
      source: {
        kind: 'opencodeServer',
        managedEndpoint: true,
      },
    });

    await expect(client.sessionStatusList()).rejects.toThrow(
      'requires an invocation-bound managedEndpointRead',
    );
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('preserves status-specific fields after validating the common status shape', async () => {
    const client = await createOpenCodeExternalSessionClient({
      source,
      env,
      managedEndpointRead: managedRead(() => new Response(JSON.stringify({
        'ses-retry': {
          type: 'retry',
          attempt: 2,
          message: 'waiting',
          next: 1_700_000_123_456,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
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

  it('uses the global bounded session and opaque message paging queries', async () => {
    const requests: string[] = [];
    const client = await createOpenCodeExternalSessionClient({
      source: {
        ...source,
        directory: '/tmp/project',
      },
      env,
      managedEndpointRead: managedRead((pathAndQuery) => {
        requests.push(pathAndQuery);
        if (pathAndQuery.includes('/message')) {
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
      }),
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
      '/experimental/session?directory=%2Ftmp%2Fproject&limit=7&search=needle',
      '/session/session%2F1/message?directory=%2Ftmp%2Fproject&limit=11&before=opaque-before',
    ]);
    expect(messagePage).toEqual({
      items: [],
      nextCursor: 'opaque-next',
    });
  });

  it('passes the global numeric session cursor through the invocation-bound reader', async () => {
    const requests: string[] = [];
    const client = await createOpenCodeExternalSessionClient({
      source: {
        ...source,
        directory: '/tmp/project',
      },
      env,
      maxResponseBytes: 1_024,
      managedEndpointRead: managedRead((pathAndQuery) => {
        requests.push(pathAndQuery);
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });

    await client.sessionList({ limit: 7, search: 'needle', cursor: 123 });

    expect(requests).toEqual([
      '/experimental/session?directory=%2Ftmp%2Fproject&limit=7&search=needle&cursor=123',
    ]);
  });

  it('rejects an invalid session cursor before touching the managed endpoint', async () => {
    const managedEndpointRead = managedRead(() => new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = await createOpenCodeExternalSessionClient({
      source,
      env,
      maxResponseBytes: 1_024,
      managedEndpointRead,
    });

    await expect(client.sessionList({ limit: 1, cursor: -1 })).rejects.toThrow(
      'OpenCode session cursor must be a non-negative safe integer.',
    );
    expect(managedEndpointRead).not.toHaveBeenCalled();
  });

  it('rejects a successful multi-chunk body over the invocation byte budget and cancels it upstream', async () => {
    const streamed = chunkedResponse({
      chunks: ['{"session":', '{"type":"busy"}', '}'],
    });
    const client = await createOpenCodeExternalSessionClient({
      source,
      env,
      maxResponseBytes: 20,
      managedEndpointRead: managedRead(() => streamed.response),
    });

    await expect(client.sessionStatusList()).rejects.toThrow(
      'OpenCode response body exceeds its 20-byte operation budget',
    );
    expect(streamed.cancelled).toHaveBeenCalledOnce();
  });

  it('rejects an error multi-chunk body over the invocation byte budget and cancels it upstream', async () => {
    const streamed = chunkedResponse({
      chunks: ['upstream-', 'error-body', 'must-not-be-read'],
      status: 503,
      statusText: 'Service Unavailable',
    });
    const client = await createOpenCodeExternalSessionClient({
      source,
      env,
      maxResponseBytes: 12,
      managedEndpointRead: managedRead(() => streamed.response),
    });

    await expect(client.sessionStatusList()).rejects.toThrow(
      'OpenCode response body exceeds its 12-byte operation budget',
    );
    expect(streamed.cancelled).toHaveBeenCalledOnce();
  });

  /**
   * The managed endpoint read carries the host's own read timeout, so a client
   * that discards the caller's signal leaves an abandoned browse parked for the
   * whole of it. Cancellation has to settle the caller, not the deadline.
   */
  it('settles an aborted read on the caller signal instead of the host read timeout', async () => {
    const managedEndpointRead = vi.fn(
      async () => await new Promise<never>(() => undefined),
    );
    const client = await createOpenCodeExternalSessionClient({
      source,
      env,
      managedEndpointRead,
    });
    const controller = new AbortController();

    const pending = client.sessionStatusList({ signal: controller.signal });
    await vi.waitFor(() => expect(managedEndpointRead).toHaveBeenCalledOnce());
    controller.abort(new Error('browse cancelled'));

    const outcome = await Promise.race([
      pending.then(
        () => 'resolved' as const,
        (error: unknown) => ({ error }),
      ),
      new Promise<'hung'>((resolve) => {
        setTimeout(() => resolve('hung'), 500);
      }),
    ]);

    expect(outcome).not.toBe('hung');
    expect(outcome).toMatchObject({
      error: expect.objectContaining({ message: 'browse cancelled' }),
    });
  });

  it('refuses a read whose signal is already aborted before the endpoint is touched', async () => {
    const managedEndpointRead = vi.fn(
      async () => await new Promise<never>(() => undefined),
    );
    const client = await createOpenCodeExternalSessionClient({
      source,
      env,
      managedEndpointRead,
    });

    await expect(client.sessionGet({
      sessionId: 'ses-1',
      signal: AbortSignal.abort(new Error('browse already cancelled')),
    })).rejects.toThrow('browse already cancelled');
    expect(managedEndpointRead).not.toHaveBeenCalled();
  });

});
