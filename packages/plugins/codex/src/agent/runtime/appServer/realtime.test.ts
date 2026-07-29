import type {
  AgentSessionRealtimeHandle,
  AgentSessionRealtimeLifecycleEvent,
  AgentSessionRealtimeStartResult,
} from '@happier-dev/plugin-sdk/experimental/agent-runtime/realtime';
import { AgentSessionRealtimeStartRequestV1Schema } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { DisposableCodexAppServerClient } from './client.js';
import { createCodexAppServerRealtimeConversation } from './realtime.js';

type RequestImplementation = (
  method: string,
  params?: unknown,
) => Promise<unknown>;

type VersionedDisposableCodexAppServerClient =
  Omit<DisposableCodexAppServerClient, 'launchFeatures'>
  & Readonly<{
    launchFeatures: Readonly<{
      realtimeConversationAdvertised: boolean;
      codexCliVersion: string | null;
      realtimeConversationVersionSupported: boolean;
    }>;
  }>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function featurePage(
  entries: ReadonlyArray<Readonly<{ name: string; enabled: boolean }>>,
  nextCursor: string | null = null,
) {
  return {
    data: entries.map((entry) => ({
      ...entry,
      stage: 'underDevelopment',
      displayName: null,
      description: null,
      announcement: null,
      defaultEnabled: false,
    })),
    nextCursor,
  };
}

function jsonRpcApplicationError(
  method: string,
  options?: Readonly<{
    code?: number;
    message?: string;
    data?: unknown;
  }>,
): Error {
  const error = new Error(options?.message ?? 'request rejected before admission');
  error.name = 'JsonRpcApplicationError';
  Object.defineProperty(error, 'method', { value: method, enumerable: true });
  Object.defineProperty(error, 'code', { value: options?.code ?? -32602, enumerable: true });
  if (options && 'data' in options) {
    Object.defineProperty(error, 'data', { value: options.data, enumerable: true });
  }
  return error;
}

function resolveCanonicalSdpMaxBytes(): number {
  const accepts = (offerSdp: string) => AgentSessionRealtimeStartRequestV1Schema.safeParse({
    v: 1,
    provider: { pluginId: 'test.plugin', localId: 'realtime' },
    applicationAttemptId: 'limit-probe',
    transport: { kind: 'webrtc', offerSdp },
  }).success;
  let upper = 1;
  while (accepts('x'.repeat(upper))) upper *= 2;
  let lower = upper / 2;
  while (lower + 1 < upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    if (accepts('x'.repeat(midpoint))) lower = midpoint;
    else upper = midpoint;
  }
  return lower;
}

function createClientFixture(options?: Readonly<{
  advertised?: boolean;
  codexCliVersion?: string | null;
  versionSupported?: boolean;
  request?: RequestImplementation;
}>) {
  let exited = false;
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  const exitListeners = new Set<(result: Readonly<{
    exitCode: number | null;
    signal: string | null;
  }>) => void>();
  const request = vi.fn<RequestImplementation>(options?.request ?? (async (method, params) => {
    if (method === 'experimentalFeature/list') {
      return featurePage([{ name: 'realtime_conversation', enabled: true }]);
    }
    return {};
  }));
  const client: VersionedDisposableCodexAppServerClient = {
    launchFeatures: {
      realtimeConversationAdvertised: options?.advertised ?? true,
      codexCliVersion: options && 'codexCliVersion' in options
        ? options.codexCliVersion ?? null
        : '0.145.0',
      realtimeConversationVersionSupported: options?.versionSupported ?? true,
    },
    request,
    notify: vi.fn(async () => {}),
    registerRequestHandler: vi.fn(() => () => {}),
    registerNotificationHandler(method, handler) {
      const current = handlers.get(method) ?? new Set();
      current.add(handler);
      handlers.set(method, current);
      return () => {
        current.delete(handler);
        if (current.size === 0) handlers.delete(method);
      };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    dispose: vi.fn(async () => {}),
  };
  return {
    client,
    request,
    publish(method: string, params: unknown) {
      for (const handler of [...(handlers.get(method) ?? [])]) handler(params);
    },
    exit(result = { exitCode: 17, signal: null }) {
      exited = true;
      for (const listener of [...exitListeners]) listener(result);
    },
    isExited() {
      return exited;
    },
    registeredMethods() {
      return [...handlers.keys()].sort();
    },
  };
}

function createConversation(
  fixture: ReturnType<typeof createClientFixture>,
  options?: Readonly<{
    threadId?: string | null;
    getThreadId?: () => string | null;
    disposed?: boolean;
    settlementTimeoutMs?: number;
    getClient?: () => Promise<DisposableCodexAppServerClient>;
  }>,
) {
  return createCodexAppServerRealtimeConversation({
    getClient: options?.getClient ?? (async () => fixture.client),
    getThreadId: options?.getThreadId
      ?? (() => options && 'threadId' in options ? options.threadId ?? null : 'thread-1'),
    isDisposed: () => options?.disposed ?? false,
    isRuntimeExited: fixture.isExited,
    settlementTimeoutMs: options?.settlementTimeoutMs ?? 5_000,
  });
}

async function settleSuccessfulStart(
  fixture: ReturnType<typeof createClientFixture>,
  startPromise: Promise<AgentSessionRealtimeStartResult>,
  answerSdp = 'v=0\r\nanswer',
  threadId = 'thread-1',
) {
  fixture.publish('thread/realtime/started', {
    threadId,
    realtimeSessionId: 'realtime-1',
    version: 'v3',
  });
  fixture.publish('thread/realtime/sdp', {
    threadId,
    sdp: answerSdp,
  });
  const result = await startPromise;
  expect(result.status).toBe('started');
  return result as Extract<AgentSessionRealtimeStartResult, { status: 'started' }>;
}

describe('Codex app-server realtime V3 adapter', () => {
  const canonicalSdpMaxBytes = resolveCanonicalSdpMaxBytes();
  const exactSdp = 'é'.repeat(canonicalSdpMaxBytes / 2);
  const oversizedSdp = `${exactSdp}x`;
  it('exhausts effective feature pages on the exact loaded client without API-key readiness', async () => {
    const fixture = createClientFixture({
      request: async (method, params) => {
        if (method !== 'experimentalFeature/list') return {};
        const cursor = (params as Readonly<{ cursor?: unknown }>).cursor;
        return cursor === null
          ? featurePage([{ name: 'apps', enabled: true }], 'page-2')
          : featurePage([{ name: 'realtime_conversation', enabled: true }]);
      },
    });
    const conversation = createConversation(fixture);

    await expect(conversation.inspect()).resolves.toEqual({
      status: 'available',
      transport: 'webrtc',
    });
    expect(fixture.request).toHaveBeenNthCalledWith(1, 'experimentalFeature/list', {
      threadId: 'thread-1',
      cursor: null,
      limit: 100,
    });
    expect(fixture.request).toHaveBeenNthCalledWith(2, 'experimentalFeature/list', {
      threadId: 'thread-1',
      cursor: 'page-2',
      limit: 100,
    });
  });

  it('reads the effective feature state for the exact loaded thread rather than a global default', async () => {
    const fixture = createClientFixture({
      request: async (method, params) => {
        if (method !== 'experimentalFeature/list') return {};
        return featurePage([{
          name: 'realtime_conversation',
          enabled: (params as Readonly<{ threadId?: unknown }>).threadId !== 'thread-1',
        }]);
      },
    });

    await expect(createConversation(fixture).inspect()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'feature_unavailable',
      diagnostic: { code: 'codex_realtime_feature_disabled' },
    });
  });

  it('fails readiness when the exact thread changes during the final feature page', async () => {
    let threadId: string | null = 'thread-1';
    const fixture = createClientFixture({
      request: async (method) => {
        if (method !== 'experimentalFeature/list') return {};
        threadId = 'thread-2';
        return featurePage([{ name: 'realtime_conversation', enabled: true }]);
      },
    });
    const conversation = createCodexAppServerRealtimeConversation({
      getClient: async () => fixture.client,
      getThreadId: () => threadId,
      isDisposed: () => false,
    });

    await expect(conversation.inspect()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'session_unavailable',
      diagnostic: { code: 'codex_realtime_thread_changed' },
    });
  });

  it.each([
    ['rejects', true],
    ['returns an enabled feature page', false],
  ] as const)(
    'reports session loss when the app-server exits while feature inspection %s',
    async (_label, rejectFeatureList) => {
      let fixture!: ReturnType<typeof createClientFixture>;
      fixture = createClientFixture({
        request: async (method) => {
          if (method !== 'experimentalFeature/list') return {};
          fixture.exit();
          if (rejectFeatureList) {
            throw new Error('feature request lost with the app-server process');
          }
          return featurePage([{ name: 'realtime_conversation', enabled: true }]);
        },
      });

      await expect(createConversation(fixture).inspect()).resolves.toMatchObject({
        status: 'unavailable',
        reason: 'session_unavailable',
        diagnostic: { code: 'codex_realtime_runtime_restart_required' },
      });
    },
  );

  it('settles feature inspection and pre-admission start when feature listing ignores abort', async () => {
    const inspectFeaturePage = deferred<unknown>();
    const inspectFixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return await inspectFeaturePage.promise;
        }
        return {};
      },
    });
    const inspectAbort = new AbortController();
    const inspecting = createConversation(inspectFixture).inspect({
      signal: inspectAbort.signal,
    });
    await vi.waitFor(() => expect(inspectFixture.request).toHaveBeenCalledWith(
      'experimentalFeature/list',
      expect.any(Object),
    ));

    const startFeaturePage = deferred<unknown>();
    const startFixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return await startFeaturePage.promise;
        }
        return {};
      },
    });
    const startAbort = new AbortController();
    const starting = createConversation(startFixture).start(
      { transport: { kind: 'webrtc', offerSdp: 'offer' } },
      { signal: startAbort.signal },
    );
    await vi.waitFor(() => expect(startFixture.request).toHaveBeenCalledWith(
      'experimentalFeature/list',
      expect.any(Object),
    ));

    inspectAbort.abort();
    startAbort.abort();
    const [inspectOutcome, startOutcome] = await Promise.all([
      Promise.race([
        inspecting,
        new Promise<'still_pending'>((resolve) => {
          setTimeout(() => resolve('still_pending'), 25);
        }),
      ]),
      Promise.race([
        starting,
        new Promise<'still_pending'>((resolve) => {
          setTimeout(() => resolve('still_pending'), 25);
        }),
      ]),
    ]);

    inspectFeaturePage.resolve(
      featurePage([{ name: 'realtime_conversation', enabled: true }]),
    );
    startFeaturePage.resolve(
      featurePage([{ name: 'realtime_conversation', enabled: true }]),
    );
    await Promise.all([inspecting, starting]);

    expect(inspectOutcome).toMatchObject({
      status: 'unavailable',
      reason: 'feature_unavailable',
      diagnostic: { code: 'codex_realtime_inspect_aborted' },
    });
    expect(startOutcome).toEqual({ status: 'aborted' });
    expect(
      startFixture.request.mock.calls.filter(
        ([method]) => method === 'thread/realtime/start',
      ),
    ).toHaveLength(0);
    expect(
      startFixture.request.mock.calls.filter(
        ([method]) => method === 'thread/realtime/stop',
      ),
    ).toHaveLength(0);
  });

  it.each([
    ['launch capability missing', false, featurePage([{ name: 'realtime_conversation', enabled: true }]), 'update_required'],
    ['effective feature missing', true, featurePage([{ name: 'apps', enabled: true }]), 'update_required'],
    ['effective feature disabled', true, featurePage([{ name: 'realtime_conversation', enabled: false }]), 'feature_unavailable'],
  ] as const)('fails readiness precisely when %s', async (
    _label,
    advertised,
    listResponse,
    reason,
  ) => {
    const fixture = createClientFixture({
      advertised,
      request: async (method) => method === 'experimentalFeature/list' ? listResponse : {},
    });

    await expect(createConversation(fixture).inspect()).resolves.toMatchObject({
      status: 'unavailable',
      reason,
    });
  });

  it.each([
    {
      label: 'client acquisition',
      inspect: async () => {
        const fixture = createClientFixture();
        return await createConversation(fixture, {
          getClient: async () => {
            throw jsonRpcApplicationError('initialize', {
              code: -32603,
              message: 'Unauthenticated: Bearer sk-private-client-acquisition',
              data: {
                error: {
                  code: 'unauthenticated',
                  codexErrorInfo: 'Unauthorized',
                  message: 'session authentication expired: sk-private-client-acquisition',
                },
              },
            });
          },
        }).inspect();
      },
      secret: 'sk-private-client-acquisition',
    },
    {
      label: 'effective feature listing',
      inspect: async () => {
        const fixture = createClientFixture({
          request: async (method) => {
            if (method !== 'experimentalFeature/list') return {};
            throw jsonRpcApplicationError(method, {
              code: -32603,
              message: 'request rejected: Bearer sk-private-feature-list',
              data: {
                error: {
                  code: 'token_revoked',
                  message: 'the selected account token was revoked: sk-private-feature-list',
                },
              },
            });
          },
        });
        return await createConversation(fixture).inspect();
      },
      secret: 'sk-private-feature-list',
    },
  ])('maps canonical classifier auth input during $label to authentication_required without projecting provider text', async ({
    inspect,
    secret,
  }) => {
    const result = await inspect();

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'authentication_required',
      diagnostic: {
        code: 'codex_realtime_authentication_required',
        severity: 'error',
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('Bearer');
    expect(JSON.stringify(result)).not.toContain('token was revoked');
  });

  it.each([
    [
      'unsupported feature listing',
      async () => {
        throw new Error('method not found: credential-bearing detail');
      },
      'codex_realtime_feature_list_unavailable',
    ],
    [
      'malformed feature pagination',
      async () => ({ data: [], nextCursor: 17 }),
      'codex_realtime_feature_list_invalid',
    ],
    [
      'cyclic feature pagination',
      async () => featurePage([], 'same-cursor'),
      'codex_realtime_feature_pagination_invalid',
    ],
  ] as const)('fails closed for %s', async (
    _label,
    request,
    code,
  ) => {
    const fixture = createClientFixture({ request });

    await expect(createConversation(fixture).inspect()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'feature_unavailable',
      diagnostic: { code },
    });
  });

  it.each([
    {
      label: 'synchronous start rejection',
      authError: jsonRpcApplicationError('thread/realtime/start', {
        code: -32603,
        message: 'request rejected: Bearer sk-private-start',
        data: {
          error: {
            code: 'refresh_token_expired',
            message: 'refresh token expired: sk-private-start',
          },
        },
      }),
      publish: null,
      secret: 'sk-private-start',
    },
    {
      label: 'asynchronous realtime admission rejection',
      authError: null,
      publish: {
        threadId: 'thread-1',
        message: 'unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, failing request; Bearer sk-private-realtime',
      },
      secret: 'sk-private-realtime',
    },
  ])('maps $label to a safe authentication-required start diagnostic', async ({
    authError,
    publish,
    secret,
  }) => {
    const fixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return featurePage([{ name: 'realtime_conversation', enabled: true }]);
        }
        if (method === 'thread/realtime/start' && authError) throw authError;
        return {};
      },
    });
    const startPromise = createConversation(fixture).start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    if (publish) fixture.publish('thread/realtime/error', publish);

    const result = await startPromise;
    expect(result).toMatchObject({
      diagnostic: {
        code: 'codex_realtime_authentication_required',
        severity: 'error',
      },
    });
    expect(['unavailable', 'failed']).toContain(result.status);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('Bearer');
    expect(JSON.stringify(result)).not.toContain('refresh token');
    expect(JSON.stringify(result)).not.toContain('invalidated oauth token');
  });

  it.each([
    {
      label: 'generic client acquisition failure',
      inspect: async () => {
        const fixture = createClientFixture();
        return await createConversation(fixture, {
          getClient: async () => {
            throw new Error('runtime missing: sk-private-generic-client');
          },
        }).inspect();
      },
      reason: 'unsupported_runtime',
      code: 'codex_realtime_runtime_unavailable',
      secret: 'sk-private-generic-client',
    },
    {
      label: 'rejected realtime-enabled app-server launch',
      inspect: async () => {
        const fixture = createClientFixture();
        return await createConversation(fixture, {
          getClient: async () => {
            throw Object.assign(
              new Error('realtime launch rejected: sk-private-launch'),
              { code: 'CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE' },
            );
          },
        }).inspect();
      },
      reason: 'feature_unavailable',
      code: 'codex_realtime_launch_enablement_unavailable',
      secret: 'sk-private-launch',
    },
    {
      label: 'unvalidated feature-advertising runtime version',
      inspect: async () => {
        const fixture = createClientFixture({
          advertised: true,
          codexCliVersion: '0.145.1',
          versionSupported: false,
          request: async () => {
            throw new Error('feature inspection must not run for an unvalidated runtime');
          },
        });
        const result = await createConversation(fixture).inspect();
        expect(fixture.request).not.toHaveBeenCalled();
        return result;
      },
      reason: 'update_required',
      code: 'codex_realtime_runtime_version_unsupported',
      secret: null,
    },
    {
      label: 'unadvertised realtime feature',
      inspect: async () => {
        const fixture = createClientFixture({ advertised: false });
        return await createConversation(fixture).inspect();
      },
      reason: 'update_required',
      code: 'codex_realtime_feature_not_advertised',
      secret: null,
    },
    {
      label: 'generic feature-list rejection',
      inspect: async () => {
        const fixture = createClientFixture({
          request: async () => {
            throw new Error('feature service failed: sk-private-generic-feature');
          },
        });
        return await createConversation(fixture).inspect();
      },
      reason: 'feature_unavailable',
      code: 'codex_realtime_feature_list_unavailable',
      secret: 'sk-private-generic-feature',
    },
  ])('retains the existing non-auth classification for $label', async ({
    inspect,
    reason,
    code,
    secret,
  }) => {
    const result = await inspect();
    expect(result).toMatchObject({
      status: 'unavailable',
      reason,
      diagnostic: { code },
    });
    if (secret) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('treats admission as asynchronous and sends the exact V3 request with defaults intact', async () => {
    const admission = deferred<unknown>();
    const fixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return featurePage([{ name: 'realtime_conversation', enabled: true }]);
        }
        if (method === 'thread/realtime/start') return await admission.promise;
        return {};
      },
    });
    const conversation = createConversation(fixture);
    const startPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\noffer' },
    });

    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      {
        threadId: 'thread-1',
        version: 'v3',
        outputModality: 'audio',
        transport: { type: 'webrtc', sdp: 'v=0\r\noffer' },
        includeStartupContext: true,
        clientManagedHandoffs: false,
        flushTranscriptTailOnSessionEnd: false,
        codexResponseHandoffMode: 'thinking',
        codexResponsesAsItems: false,
      },
    ));
    expect(fixture.registeredMethods()).toEqual([
      'thread/realtime/closed',
      'thread/realtime/error',
      'thread/realtime/sdp',
      'thread/realtime/started',
    ]);

    admission.resolve({});
    await expect(Promise.race([
      startPromise.then(() => 'settled'),
      Promise.resolve('pending'),
    ])).resolves.toBe('pending');

    const started = await settleSuccessfulStart(fixture, startPromise);
    expect(started.transport).toEqual({
      kind: 'webrtc',
      answerSdp: 'v=0\r\nanswer',
    });
    const request = fixture.request.mock.calls.find(([method]) => method === 'thread/realtime/start')?.[1];
    expect(request).not.toHaveProperty('prompt');
    expect(request).not.toHaveProperty('initialItems');
    expect(request).not.toHaveProperty('model');
    expect(request).not.toHaveProperty('voice');
  });

  it.each([
    ['non-empty object', { admitted: true }],
    ['null', null],
    ['array', []],
  ] as const)('rejects a fulfilled %s start response as invalid ambiguous admission', async (
    _label,
    response,
  ) => {
    const admission = deferred<unknown>();
    const fixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return featurePage([{ name: 'realtime_conversation', enabled: true }]);
        }
        if (method === 'thread/realtime/start') return await admission.promise;
        return {};
      },
    });
    const conversation = createConversation(fixture);
    const startPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\noffer' },
    });

    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    fixture.publish('thread/realtime/started', {
      threadId: 'thread-1',
      realtimeSessionId: 'realtime-1',
      version: 'v3',
    });
    fixture.publish('thread/realtime/sdp', {
      threadId: 'thread-1',
      sdp: 'v=0\r\nanswer',
    });
    admission.resolve(response);

    await expect(startPromise).resolves.toMatchObject({
      status: 'failed',
      diagnostic: { code: 'codex_realtime_start_response_invalid' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/stop',
      { threadId: 'thread-1' },
    ));
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\nretry' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });
  });

  it.each([
    ['error before started', (fixture: ReturnType<typeof createClientFixture>) => {
      fixture.publish('thread/realtime/error', { threadId: 'thread-1', message: 'private upstream text' });
    }, 'codex_realtime_upstream_error'],
    ['error between started and SDP', (fixture: ReturnType<typeof createClientFixture>) => {
      fixture.publish('thread/realtime/started', {
        threadId: 'thread-1',
        realtimeSessionId: null,
        version: 'v3',
      });
      fixture.publish('thread/realtime/error', { threadId: 'thread-1', message: 'private upstream text' });
    }, 'codex_realtime_upstream_error'],
    ['SDP before started', (fixture: ReturnType<typeof createClientFixture>) => {
      fixture.publish('thread/realtime/sdp', { threadId: 'thread-1', sdp: 'v=0\r\nstale' });
    }, 'codex_realtime_notification_order'],
    ['wrong started version', (fixture: ReturnType<typeof createClientFixture>) => {
      fixture.publish('thread/realtime/started', {
        threadId: 'thread-1',
        realtimeSessionId: null,
        version: 'v2',
      });
    }, 'codex_realtime_version_unsupported'],
  ])('fails closed for %s and sanitizes diagnostics', async (_label, publish, code) => {
    const fixture = createClientFixture();
    const startPromise = createConversation(fixture).start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));

    publish(fixture);

    await expect(startPromise).resolves.toMatchObject({
      status: 'failed',
      diagnostic: {
        code,
      },
    });
    const result = await startPromise;
    expect(result).not.toEqual(expect.objectContaining({
      diagnostic: expect.objectContaining({ message: 'private upstream text' }),
    }));
  });

  it.each([
    {
      label: 'started without its required realtime session id',
      publish: (fixture: ReturnType<typeof createClientFixture>) => {
        fixture.publish('thread/realtime/started', {
          threadId: 'thread-1',
          version: 'v3',
        });
        fixture.publish('thread/realtime/sdp', {
          threadId: 'thread-1',
          sdp: 'v=0\r\nanswer',
        });
      },
    },
    {
      label: 'error without its required message',
      publish: (fixture: ReturnType<typeof createClientFixture>) => {
        fixture.publish('thread/realtime/error', {
          threadId: 'thread-1',
        });
      },
    },
    {
      label: 'closed without its required nullable reason',
      publish: (fixture: ReturnType<typeof createClientFixture>) => {
        fixture.publish('thread/realtime/closed', {
          threadId: 'thread-1',
        });
      },
    },
  ])('rejects a current-thread $label against the generated Codex schema', async ({
    publish,
  }) => {
    const fixture = createClientFixture();
    const startPromise = createConversation(fixture).start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));

    publish(fixture);

    await expect(startPromise).resolves.toMatchObject({
      status: 'failed',
      diagnostic: {
        code: 'codex_realtime_notification_invalid',
      },
    });
    await vi.waitFor(() => expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/stop'),
    ).toHaveLength(1));
  });

  it('ignores wrong-thread evidence and accepts only same-thread started then SDP', async () => {
    const fixture = createClientFixture();
    const startPromise = createConversation(fixture).start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    fixture.publish('thread/realtime/started', {
      threadId: 'foreign-thread',
      realtimeSessionId: null,
      version: 'v3',
    });
    fixture.publish('thread/realtime/sdp', {
      threadId: 'foreign-thread',
      sdp: 'foreign',
    });

    await expect(Promise.race([
      startPromise.then(() => 'settled'),
      Promise.resolve('pending'),
    ])).resolves.toBe('pending');
    await settleSuccessfulStart(fixture, startPromise);
  });

  it('keeps an aborted negotiation fenced through requested close when close beats stop response', async () => {
    const stopResponse = deferred<unknown>();
    const fixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return featurePage([{ name: 'realtime_conversation', enabled: true }]);
        }
        if (method === 'thread/realtime/stop') return await stopResponse.promise;
        return {};
      },
    });
    const conversation = createConversation(fixture);
    const abortController = new AbortController();
    const startPromise = conversation.start(
      { transport: { kind: 'webrtc', offerSdp: 'offer' } },
      { signal: abortController.signal },
    );
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    abortController.abort();

    await expect(startPromise).resolves.toEqual({ status: 'aborted' });
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'retry' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });
    expect(fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/stop'))
      .toHaveLength(1);

    for (const reason of [undefined, 'error', 'transport_closed', 'unknown']) {
      fixture.publish('thread/realtime/closed', {
        threadId: 'thread-1',
        ...(reason ? { reason } : {}),
      });
    }
    fixture.publish('thread/realtime/closed', {
      threadId: 'foreign-thread',
      reason: 'requested',
    });
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'still-blocked' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });

    fixture.publish('thread/realtime/closed', {
      threadId: 'thread-1',
      reason: 'requested',
    });
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'retry' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });
    stopResponse.resolve({});
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/start'),
    ).toHaveLength(1);
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/stop'),
    ).toHaveLength(1);
    expect(fixture.client.dispose).not.toHaveBeenCalled();
  });

  it('settles an admitted abort-ignoring start while disposal owns its one pending stop', async () => {
    const startResponse = deferred<unknown>();
    const stopResponse = deferred<unknown>();
    const fixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return featurePage([{ name: 'realtime_conversation', enabled: true }]);
        }
        if (method === 'thread/realtime/start') return await startResponse.promise;
        if (method === 'thread/realtime/stop') return await stopResponse.promise;
        return {};
      },
    });
    const conversation = createConversation(fixture);
    const abortController = new AbortController();
    const starting = conversation.start(
      { transport: { kind: 'webrtc', offerSdp: 'offer' } },
      { signal: abortController.signal },
    );
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));

    abortController.abort();
    const startOutcome = await Promise.race([
      starting,
      new Promise<'still_pending'>((resolve) => {
        setTimeout(() => resolve('still_pending'), 25);
      }),
    ]);
    const retryWhileStartPending = await conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'retry-while-start-pending' },
    });
    expect(['busy', 'unavailable']).toContain(retryWhileStartPending.status);
    if (retryWhileStartPending.status === 'unavailable') {
      expect(retryWhileStartPending.diagnostic.code)
        .toBe('codex_realtime_retry_unavailable');
    }
    const disposing = conversation.dispose();
    const disposeBeforeStop = await Promise.race([
      disposing.then(() => 'disposed' as const),
      new Promise<'still_pending'>((resolve) => {
        setTimeout(() => resolve('still_pending'), 25);
      }),
    ]);

    expect(startOutcome).toEqual({ status: 'aborted' });
    expect(disposeBeforeStop).toBe('still_pending');
    expect(
      fixture.request.mock.calls.filter(
        ([method]) => method === 'thread/realtime/stop',
      ),
    ).toHaveLength(1);

    startResponse.resolve({});
    await expect(starting).resolves.toEqual({ status: 'aborted' });
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'retry-while-stop-pending' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });
    stopResponse.resolve({});
    await disposing;
    expect(
      fixture.request.mock.calls.filter(
        ([method]) => method === 'thread/realtime/stop',
      ),
    ).toHaveLength(1);
  });

  it('keeps the thread immediately reusable after a synchronous proven rejection', async () => {
    let rejectNextStart = true;
    const fixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return featurePage([{ name: 'realtime_conversation', enabled: true }]);
        }
        if (method === 'thread/realtime/start' && rejectNextStart) {
          rejectNextStart = false;
          throw jsonRpcApplicationError('thread/realtime/start');
        }
        return {};
      },
    });
    const conversation = createConversation(fixture);

    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'first-offer' },
    })).resolves.toMatchObject({
      status: 'failed',
      diagnostic: { code: 'codex_realtime_start_rejected' },
    });

    const retryPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'retry-offer' },
    });
    await vi.waitFor(() => expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/start'),
    ).toHaveLength(2));
    await settleSuccessfulStart(fixture, retryPromise);
  });

  it('keeps an admitted start error fenced through requested close', async () => {
    const admission = deferred<unknown>();
    let startRequests = 0;
    const fixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return featurePage([{ name: 'realtime_conversation', enabled: true }]);
        }
        if (method === 'thread/realtime/start' && startRequests++ === 0) {
          return await admission.promise;
        }
        return {};
      },
    });
    const conversation = createConversation(fixture);
    const startPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'first-offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));

    fixture.publish('thread/realtime/started', {
      threadId: 'thread-1',
      realtimeSessionId: 'realtime-1',
      version: 'v3',
    });
    fixture.publish('thread/realtime/sdp', {
      threadId: 'thread-1',
      sdp: 'first-answer',
    });
    admission.reject(jsonRpcApplicationError('thread/realtime/start'));

    await expect(startPromise).resolves.toMatchObject({
      status: 'failed',
      diagnostic: { code: 'codex_realtime_start_failed' },
    });
    await vi.waitFor(() => expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/stop'),
    ).toHaveLength(1));
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'blocked' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });

    fixture.publish('thread/realtime/closed', {
      threadId: 'thread-1',
      reason: 'error',
    });
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'still-blocked' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });

    fixture.publish('thread/realtime/closed', {
      threadId: 'thread-1',
      reason: 'requested',
    });
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'retry' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/start'),
    ).toHaveLength(1);
  });

  it('keeps a generic transport rejection fenced despite close until process termination', async () => {
    let rejectNextStart = true;
    const fixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return featurePage([{ name: 'realtime_conversation', enabled: true }]);
        }
        if (method === 'thread/realtime/start' && rejectNextStart) {
          rejectNextStart = false;
          throw Object.assign(new Error('request timed out after dispatch'), {
            code: 'PLUGIN_EXEC_CLIENT_REQUEST_TIMEOUT',
          });
        }
        return {};
      },
    });
    const conversation = createConversation(fixture);

    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'first-offer' },
    })).resolves.toMatchObject({
      status: 'failed',
      diagnostic: { code: 'codex_realtime_start_failed' },
    });
    fixture.publish('thread/realtime/closed', {
      threadId: 'thread-1',
      reason: 'stopped',
    });
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'blocked' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });

    fixture.exit();
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'retry-offer' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_runtime_restart_required' },
    });
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/start'),
    ).toHaveLength(1);
  });

  it('keeps an upstream error fenced through natural and requested closes', async () => {
    const fixture = createClientFixture();
    const conversation = createConversation(fixture);
    const firstPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer-1' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    await settleSuccessfulStart(fixture, firstPromise);

    fixture.publish('thread/realtime/error', {
      threadId: 'thread-1',
      message: 'upstream failed',
    });
    await vi.waitFor(() => expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/stop'),
    ).toHaveLength(1));
    fixture.publish('thread/realtime/closed', {
      threadId: 'thread-1',
      reason: 'error',
    });
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'blocked' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });

    fixture.publish('thread/realtime/closed', {
      threadId: 'thread-1',
      reason: 'requested',
    });
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer-2' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/start'),
    ).toHaveLength(1);
  });

  it('fences an admitted timeout through requested close', async () => {
    vi.useFakeTimers();
    try {
      const fixture = createClientFixture();
      const conversation = createConversation(fixture, { settlementTimeoutMs: 250 });
      const startPromise = conversation.start({
        transport: { kind: 'webrtc', offerSdp: 'offer' },
      });
      await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
        'thread/realtime/start',
        expect.any(Object),
      ));

      await vi.advanceTimersByTimeAsync(250);
      await expect(startPromise).resolves.toMatchObject({
        status: 'failed',
        diagnostic: { code: 'codex_realtime_start_timeout' },
      });
      await expect(conversation.start({
        transport: { kind: 'webrtc', offerSdp: 'blocked' },
      })).resolves.toMatchObject({
        status: 'unavailable',
        diagnostic: { code: 'codex_realtime_retry_unavailable' },
      });

      fixture.publish('thread/realtime/closed', {
        threadId: 'thread-1',
        reason: 'transport_closed',
      });
      await expect(conversation.start({
        transport: { kind: 'webrtc', offerSdp: 'still-blocked' },
      })).resolves.toMatchObject({
        status: 'unavailable',
        diagnostic: { code: 'codex_realtime_retry_unavailable' },
      });

      fixture.publish('thread/realtime/closed', {
        threadId: 'thread-1',
        reason: 'requested',
      });
      await expect(conversation.start({
        transport: { kind: 'webrtc', offerSdp: 'retry' },
      })).resolves.toMatchObject({
        status: 'unavailable',
        diagnostic: { code: 'codex_realtime_retry_unavailable' },
      });
      expect(
        fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/start'),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a spontaneous close terminally fenced until app-server process replacement', async () => {
    const fixture = createClientFixture();
    const conversation = createConversation(fixture);
    const attemptAbort = new AbortController();
    const startPromise = conversation.start(
      { transport: { kind: 'webrtc', offerSdp: 'offer' } },
      { signal: attemptAbort.signal },
    );
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    const started = await settleSuccessfulStart(fixture, startPromise);
    const terminalEvents: AgentSessionRealtimeLifecycleEvent[] = [];
    const lateTerminalEvents: AgentSessionRealtimeLifecycleEvent[] = [];
    started.handle.watch((event) => terminalEvents.push(event));

    fixture.publish('thread/realtime/closed', {
      threadId: 'thread-1',
      reason: 'transport_closed',
    });

    expect(terminalEvents).toEqual([{
      kind: 'terminal',
      reason: 'upstream_closed',
    }]);
    started.handle.watch((event) => lateTerminalEvents.push(event));
    expect(lateTerminalEvents).toEqual(terminalEvents);
    await expect(started.handle.stop()).resolves.toEqual({
      status: 'already_stopped',
    });
    attemptAbort.abort();
    expect(fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/stop'))
      .toHaveLength(0);

    const retryBeforeExit = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'retry' },
    });
    const retryBeforeExitOutcome = await Promise.race([
      retryBeforeExit,
      new Promise<'still_pending'>((resolve) => {
        setTimeout(() => resolve('still_pending'), 25);
      }),
    ]);
    if (retryBeforeExitOutcome === 'still_pending') {
      fixture.exit();
      await retryBeforeExit;
    }
    expect(retryBeforeExitOutcome).toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });

    fixture.publish('thread/realtime/started', {
      threadId: 'thread-1',
      realtimeSessionId: 'stale-realtime',
      version: 'v3',
    });
    fixture.publish('thread/realtime/sdp', {
      threadId: 'thread-1',
      sdp: 'stale-answer',
    });
    fixture.publish('thread/realtime/error', {
      threadId: 'thread-1',
      message: 'stale error',
    });
    expect(terminalEvents).toHaveLength(1);
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/start'),
    ).toHaveLength(1);

    fixture.exit();
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'retry-after-exit' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_runtime_restart_required' },
    });
    expect(fixture.client.dispose).not.toHaveBeenCalled();

    const replacementFixture = createClientFixture();
    const replacementConversation = createConversation(replacementFixture);
    const replacementStart = replacementConversation.start({
      transport: { kind: 'webrtc', offerSdp: 'replacement-offer' },
    });
    await vi.waitFor(() => expect(replacementFixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    fixture.publish('thread/realtime/started', {
      threadId: 'thread-1',
      realtimeSessionId: 'stale-after-replacement',
      version: 'v3',
    });
    fixture.publish('thread/realtime/sdp', {
      threadId: 'thread-1',
      sdp: 'stale-after-replacement',
    });
    await expect(Promise.race([
      replacementStart.then(() => 'settled'),
      Promise.resolve('pending'),
    ])).resolves.toBe('pending');
    await settleSuccessfulStart(replacementFixture, replacementStart);
  });

  it('process exit is a retry barrier and cannot be confused with a Voice-owned restart', async () => {
    const fixture = createClientFixture();
    const conversation = createConversation(fixture);
    const startPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));

    fixture.exit();

    await expect(startPromise).resolves.toMatchObject({
      status: 'failed',
      diagnostic: { code: 'codex_realtime_runtime_exited' },
    });
    const requestCountAfterExit = fixture.request.mock.calls.length;
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'retry' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_runtime_restart_required' },
    });
    expect(fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/start'))
      .toHaveLength(1);
    expect(fixture.request).toHaveBeenCalledTimes(requestCountAfterExit);
    expect(fixture.client.dispose).not.toHaveBeenCalled();
  });

  it('accepts exact-limit offer and answer SDP at the Codex leaf', async () => {
    expect(new TextEncoder().encode(exactSdp).byteLength)
      .toBe(canonicalSdpMaxBytes);
    const fixture = createClientFixture();
    const conversation = createConversation(fixture);
    const startPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: exactSdp },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.objectContaining({
        transport: { type: 'webrtc', sdp: exactSdp },
      }),
    ));

    const started = await settleSuccessfulStart(fixture, startPromise, exactSdp);
    expect(started.transport.answerSdp).toBe(exactSdp);
    await expect(started.handle.stop()).resolves.toEqual({ status: 'stopped' });
  });

  it('rejects limit-plus-one offer SDP before admission at the Codex leaf', async () => {
    expect(new TextEncoder().encode(oversizedSdp).byteLength)
      .toBe(canonicalSdpMaxBytes + 1);
    const fixture = createClientFixture();
    const conversation = createConversation(fixture, { settlementTimeoutMs: 250 });

    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: oversizedSdp },
    })).resolves.toEqual({
      status: 'failed',
      diagnostic: {
        code: 'codex_realtime_offer_invalid',
        severity: 'error',
        message: 'Codex Realtime Voice requires a valid WebRTC offer.',
      },
    });
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it('rejects a limit-plus-one answer SDP at the Codex leaf and stops the admitted attempt once', async () => {
    expect(new TextEncoder().encode(oversizedSdp).byteLength)
      .toBe(canonicalSdpMaxBytes + 1);
    const fixture = createClientFixture();
    const conversation = createConversation(fixture);
    const startPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));

    fixture.publish('thread/realtime/started', {
      threadId: 'thread-1',
      realtimeSessionId: 'realtime-1',
      version: 'v3',
    });
    fixture.publish('thread/realtime/sdp', {
      threadId: 'thread-1',
      sdp: oversizedSdp,
    });

    await expect(startPromise).resolves.toEqual({
      status: 'failed',
      diagnostic: {
        code: 'codex_realtime_answer_invalid',
        severity: 'error',
        message: 'The selected Codex runtime returned an invalid WebRTC answer.',
      },
    });
    await vi.waitFor(() => expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/stop'),
    ).toHaveLength(1));
  });

  it('keeps local stop fenced when requested close can precede a stale transport close', async () => {
    let publishLatePriorClose = () => {};
    let startRequests = 0;
    const fixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return featurePage([{ name: 'realtime_conversation', enabled: true }]);
        }
        if (method === 'thread/realtime/start' && ++startRequests === 2) {
          publishLatePriorClose();
        }
        return {};
      },
    });
    publishLatePriorClose = () => fixture.publish('thread/realtime/closed', {
      threadId: 'thread-1',
      reason: 'transport_closed',
    });
    const conversation = createConversation(fixture);
    const firstPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer-1' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));

    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer-2' },
    })).resolves.toEqual({ status: 'busy' });
    const started = await settleSuccessfulStart(fixture, firstPromise);
    const early: AgentSessionRealtimeLifecycleEvent[] = [];
    started.handle.watch((event) => early.push(event));

    await expect(started.handle.stop()).resolves.toEqual({ status: 'stopped' });
    await expect(started.handle.stop()).resolves.toEqual({ status: 'already_stopped' });
    await started.handle.dispose();
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'blocked' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });

    const late: AgentSessionRealtimeLifecycleEvent[] = [];
    started.handle.watch((event) => late.push(event));
    expect(early).toEqual([{ kind: 'terminal', reason: 'stopped' }]);
    expect(late).toEqual([{ kind: 'terminal', reason: 'stopped' }]);
    expect(fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/stop'))
      .toHaveLength(1);
    fixture.publish('thread/realtime/closed', {
      threadId: 'thread-1',
      reason: 'requested',
    });
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer-2' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/start'),
    ).toHaveLength(1);
    expect(fixture.client.dispose).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['array', []],
    ['non-empty object', { stopped: true }],
  ] as const)('rejects a fulfilled %s stop response without releasing the terminal thread fence', async (
    _label,
    stopResponse,
  ) => {
    const fixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return featurePage([{ name: 'realtime_conversation', enabled: true }]);
        }
        if (method === 'thread/realtime/stop') return stopResponse;
        return {};
      },
    });
    const conversation = createConversation(fixture);
    const starting = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    const started = await settleSuccessfulStart(fixture, starting);
    const terminalEvents: AgentSessionRealtimeLifecycleEvent[] = [];
    started.handle.watch((event) => terminalEvents.push(event));

    await expect(started.handle.stop()).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_stop_response_invalid' },
    });
    expect(terminalEvents).toEqual([{
      kind: 'terminal',
      reason: 'error',
      diagnostic: expect.objectContaining({
        code: 'codex_realtime_stop_response_invalid',
      }),
    }]);
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'retry-after-invalid-stop' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/stop'),
    ).toHaveLength(1);
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/start'),
    ).toHaveLength(1);
  });

  it('isolates throwing lifecycle watchers and retains terminal replay through one upstream stop', async () => {
    const fixture = createClientFixture();
    const startPromise = createConversation(fixture).start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    const started = await settleSuccessfulStart(fixture, startPromise);
    const surviving: AgentSessionRealtimeLifecycleEvent[] = [];
    started.handle.watch(() => {
      throw new Error('watcher_failed');
    });
    started.handle.watch((event) => surviving.push(event));

    await expect(started.handle.stop()).resolves.toEqual({ status: 'stopped' });
    expect(() => {
      started.handle.watch(() => {
        throw new Error('late_watcher_failed');
      });
    }).not.toThrow();
    const survivingLate: AgentSessionRealtimeLifecycleEvent[] = [];
    expect(() => {
      started.handle.watch((event) => survivingLate.push(event));
    }).not.toThrow();
    await started.handle.dispose();

    expect(surviving).toEqual([{ kind: 'terminal', reason: 'stopped' }]);
    expect(survivingLate).toEqual(surviving);
    expect(
      fixture.request.mock.calls.filter(
        ([method]) => method === 'thread/realtime/stop',
      ),
    ).toHaveLength(1);
  });

  it('owns duplicate lifecycle watcher registrations by subscription identity', async () => {
    const fixture = createClientFixture();
    const startPromise = createConversation(fixture).start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    const started = await settleSuccessfulStart(fixture, startPromise);
    const listener = vi.fn<(event: AgentSessionRealtimeLifecycleEvent) => void>();
    const firstSubscription = started.handle.watch(listener);
    started.handle.watch(listener);

    firstSubscription.dispose();
    await expect(started.handle.stop()).resolves.toEqual({ status: 'stopped' });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      kind: 'terminal',
      reason: 'stopped',
    });
  });

  it('admits a different thread only through a fresh facade after process exit', async () => {
    let threadId = 'thread-1';
    const fixture = createClientFixture();
    const conversation = createConversation(fixture, {
      getThreadId: () => threadId,
    });
    const firstPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer-1' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.objectContaining({ threadId: 'thread-1' }),
    ));
    const started = await settleSuccessfulStart(fixture, firstPromise);
    await expect(started.handle.stop()).resolves.toEqual({ status: 'stopped' });

    threadId = 'thread-2';
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'blocked' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });
    fixture.publish('thread/realtime/closed', {
      threadId: 'thread-2',
      reason: 'requested',
    });
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'still-blocked' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });

    fixture.publish('thread/realtime/closed', {
      threadId: 'thread-1',
      reason: 'requested',
    });
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'still-fenced' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/start'),
    ).toHaveLength(1);

    fixture.exit();
    const replacementFixture = createClientFixture();
    const replacementConversation = createConversation(replacementFixture, {
      getThreadId: () => threadId,
    });
    const replacementPromise = replacementConversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer-2' },
    });
    await vi.waitFor(() => expect(replacementFixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.objectContaining({ threadId: 'thread-2' }),
    ));
    await settleSuccessfulStart(
      replacementFixture,
      replacementPromise,
      'v=0\r\nanswer-2',
      'thread-2',
    );
    expect(fixture.client.dispose).not.toHaveBeenCalled();
    expect(replacementFixture.client.dispose).not.toHaveBeenCalled();
  });

  it('projects active upstream close as one retained terminal lifecycle fact', async () => {
    const fixture = createClientFixture();
    const conversation = createConversation(fixture);
    const startPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    const started = await settleSuccessfulStart(fixture, startPromise);
    const events: AgentSessionRealtimeLifecycleEvent[] = [];
    started.handle.watch((event) => events.push(event));

    fixture.publish('thread/realtime/closed', {
      threadId: 'thread-1',
      reason: 'upstream closed',
    });

    expect(events).toEqual([{
      kind: 'terminal',
      reason: 'upstream_closed',
    }]);
    const late: AgentSessionRealtimeLifecycleEvent[] = [];
    started.handle.watch((event) => late.push(event));
    expect(late).toEqual(events);
  });

  it('stop during negotiation settles start and session disposal remains terminal-only', async () => {
    const fixture = createClientFixture();
    const conversation = createConversation(fixture);
    const startPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));

    await conversation.dispose();

    await expect(startPromise).resolves.toMatchObject({
      status: 'failed',
      diagnostic: { code: 'codex_realtime_agent_session_disposed' },
    });
    expect(fixture.registeredMethods()).not.toContain('thread/realtime/outputAudio/delta');
    expect(fixture.registeredMethods()).not.toContain('thread/realtime/transcriptUpdated');
    expect(fixture.registeredMethods()).not.toContain('thread/realtime/itemAdded');
  });

  it('returns typed aborted stop without ending an established attachment', async () => {
    const fixture = createClientFixture();
    const startPromise = createConversation(fixture).start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    const started = await settleSuccessfulStart(fixture, startPromise);
    const controller = new AbortController();
    controller.abort();

    await expect(started.handle.stop({ signal: controller.signal }))
      .resolves.toEqual({ status: 'aborted' });
    expect(fixture.request.mock.calls.filter(([method]) => method === 'thread/realtime/stop'))
      .toHaveLength(0);
  });

  it('lets a stop caller abort while disposal awaits the same abort-ignoring upstream stop', async () => {
    const stopResponse = deferred<unknown>();
    const fixture = createClientFixture({
      request: async (method) => {
        if (method === 'experimentalFeature/list') {
          return featurePage([{ name: 'realtime_conversation', enabled: true }]);
        }
        if (method === 'thread/realtime/stop') return await stopResponse.promise;
        return {};
      },
    });
    const conversation = createConversation(fixture);
    const startPromise = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    const started = await settleSuccessfulStart(fixture, startPromise);
    const caller = new AbortController();
    const callerStop = started.handle.stop({ signal: caller.signal });
    await vi.waitFor(() => expect(
      fixture.request.mock.calls.filter(
        ([method]) => method === 'thread/realtime/stop',
      ),
    ).toHaveLength(1));

    caller.abort();
    const callerOutcome = await Promise.race([
      callerStop,
      new Promise<'still_pending'>((resolve) => {
        setTimeout(() => resolve('still_pending'), 25);
      }),
    ]);
    const cleanup = started.handle.dispose();
    const cleanupBeforeStop = await Promise.race([
      Promise.resolve(cleanup).then(() => 'disposed' as const),
      new Promise<'still_pending'>((resolve) => {
        setTimeout(() => resolve('still_pending'), 25);
      }),
    ]);

    expect(callerOutcome).toEqual({ status: 'aborted' });
    expect(cleanupBeforeStop).toBe('still_pending');
    expect(
      fixture.request.mock.calls.filter(
        ([method]) => method === 'thread/realtime/stop',
      ),
    ).toHaveLength(1);
    await expect(conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'retry-before-stop-settles' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_realtime_retry_unavailable' },
    });

    stopResponse.resolve({});
    await Promise.all([callerStop, cleanup]);
    expect(
      fixture.request.mock.calls.filter(
        ([method]) => method === 'thread/realtime/stop',
      ),
    ).toHaveLength(1);
  });
});
