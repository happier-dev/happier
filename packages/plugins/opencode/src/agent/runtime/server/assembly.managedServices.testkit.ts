import { vi } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ManagedServiceHandle, ManagedServiceRequest, ManagedServiceResponse, ManagedServiceSnapshot } from '@happier-dev/plugin-sdk/managed-services';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';

export function managedServiceHandle(params: Readonly<{
  baseUrl: string;
  state?: () => ManagedServiceSnapshot['state'];
  waitError?: Error;
  onDispose?: () => void;
  request?: (input: ManagedServiceRequest) => Promise<ManagedServiceResponse>;
  onWaitUntilHealthy?: (options: Parameters<ManagedServiceHandle['waitUntilHealthy']>[0]) => void;
}>): ManagedServiceHandle {
  const readSnapshot = (): ManagedServiceSnapshot => ({
    id: 'opencode-server',
    state: params.state?.() ?? 'healthy',
    mode: 'spawn',
    baseUrl: params.baseUrl,
    startedAtMs: 100,
    lastHealthyAtMs: 101,
    diagnostics: [],
    diagnosticsTruncated: false,
  });
  return {
    snapshot: readSnapshot,
    observe: (listener) => {
      listener(readSnapshot());
      return { dispose() {} };
    },
    waitUntilHealthy: async (options) => {
      params.onWaitUntilHealthy?.(options);
      if (params.waitError) throw params.waitError;
      return readSnapshot();
    },
    stop: async () => ({ status: 'stopped' }),
    dispose: async () => {
      params.onDispose?.();
    },
    request: params.request ?? (async (input) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: new Response(
        input.pathAndQuery === '/session?directory=%2Frepo'
          ? JSON.stringify({ id: 'oc-session-1' })
          : '{}',
      ).body,
    })),
  };
}

export function createContextFixture(params: Readonly<{
  managedServerBaseUrl: string;
  managedServerWaitError?: Error;
  onManagedServerDispose?: () => void;
  onWaitUntilHealthy?: (options: Parameters<ManagedServiceHandle['waitUntilHealthy']>[0]) => void;
  systemToolExecutablePath?: string;
  systemToolResolveError?: Error;
  managedServerRequest?: (input: ManagedServiceRequest) => Promise<ManagedServiceResponse>;
  permissionDecision?: OpenCodeRuntimeContext['sessions']['current']['permissions']['requestDecision'];
}>): OpenCodeRuntimeContext {
  const abortController = new AbortController();
  const sessionStorage = new Map<string, JsonValue>();
  return {
    exec: {
      systemTools: {
        resolve: vi.fn(async () => {
          if (params.systemToolResolveError) throw params.systemToolResolveError;
          return { executablePath: params.systemToolExecutablePath ?? '/usr/local/bin/opencode' };
        }),
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    env: {
      list: () => ({}),
    },
    abort: {
      signal: abortController.signal,
      compose: (signals) => AbortSignal.any([...signals]),
    },
    config: { values: {} },
    managedServices: {
      observeWorkload: async () => ({ kind: 'unavailable', reason: 'admission_unavailable' }),
      dependencies: {} as OpenCodeRuntimeContext['managedServices']['dependencies'],
      supervise: vi.fn(async () => managedServiceHandle({
        baseUrl: params.managedServerBaseUrl,
        waitError: params.managedServerWaitError,
        onDispose: params.onManagedServerDispose,
        onWaitUntilHealthy: params.onWaitUntilHealthy,
        ...(params.managedServerRequest ? { request: params.managedServerRequest } : {}),
      })),
    },
    ui: {
      askQuestions: vi.fn(async () => ({
        requestId: 'question-cancelled',
        kind: 'questions' as const,
        status: 'userCancelled' as const,
      })),
    },
    sessions: {
      current: {
        permissions: {
          requestDecision: params.permissionDecision ?? vi.fn(async () => ({
            requestId: 'approval-approved',
            kind: 'approval' as const,
            status: 'approved' as const,
            persistence: 'once' as const,
          })),
        },
      },
      writeStateField: vi.fn(async () => undefined),
    },
    storage: {
      daemonSession: {
        // The storage transport returns JSON values parameterized by the caller's requested shape.
        get: async <T extends JsonValue = JsonValue>(key: string): Promise<T | null> => (
          (sessionStorage.get(key) ?? null) as T | null
        ),
        set: vi.fn(async (key: string, value: JsonValue) => {
          sessionStorage.set(key, value);
        }),
      },
    },
    experimental: {
      telemetry: {
        emit: vi.fn(),
      },
    },
  };
}
