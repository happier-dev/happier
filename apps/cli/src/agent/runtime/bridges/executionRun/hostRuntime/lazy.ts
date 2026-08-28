import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
  ExecutionRunPermissionCapability,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { wrapExecutionRunHostRuntime } from './wrap';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readPermissionCapability(value: unknown): ExecutionRunPermissionCapability | null {
  return value === 'responds' || value === 'inline' || value === 'static' ? value : null;
}

function readRuntimePermissionCapability(value: unknown): ExecutionRunPermissionCapability | null {
  const record = readRecord(value);
  if (!record) return null;
  const permissions = readRecord(record.permissions);
  return readPermissionCapability(permissions?.capability)
    ?? readPermissionCapability(record.permissionCapability);
}

export function createLazyExecutionRunHostRuntime(params: Readonly<{
  resolveRuntime: () => Promise<ExecutionRunHostRuntime>;
  onProvisionSession?: (sessionId: string) => Promise<void>;
  runtimeDescriptor?: unknown;
  runtimeCapabilities?: unknown;
  runtimeFacets?: unknown;
}>): ExecutionRunHostRuntime {
  const handlers = new Set<ExecutionRunHostRuntimeMessageHandler>();
  const unsubscribeByHandler = new Map<ExecutionRunHostRuntimeMessageHandler, () => void>();
  let resolvedRuntimePromise: Promise<ExecutionRunHostRuntime> | null = null;
  let resolvedRuntime: ExecutionRunHostRuntime | null = null;
  let sessionProvisionPromise: Promise<string> | null = null;
  let disposePromise: Promise<void> | null = null;
  let disposed = false;
  let activeSessionId: string | null = null;
  let emittedRuntimeDescriptor = false;
  let emittedRuntimeCapabilities = false;
  let emittedRuntimeFacets = false;
  let permissionCapability = readRuntimePermissionCapability(params.runtimeCapabilities);

  const emitRuntimeEvent = (name: string, payload: unknown): void => {
    if (payload === null || payload === undefined) return;
    if (name === 'runtime.capabilities') {
      permissionCapability = readRuntimePermissionCapability(payload) ?? 'static';
    }
    for (const handler of handlers) {
      try {
        handler({ type: 'event', name, payload });
      } catch {
        // Best effort: runtime event subscribers must not break backend routing.
      }
    }
  };

  const attachQueuedHandlers = (runtime: ExecutionRunHostRuntime): void => {
    for (const handler of handlers) {
      if (!handlers.has(handler) || unsubscribeByHandler.has(handler)) continue;
      unsubscribeByHandler.set(handler, runtime.subscribeMessages((message) => {
        if (message.type === 'event' && message.name === 'runtime.capabilities') {
          permissionCapability = readRuntimePermissionCapability(message.payload) ?? 'static';
        }
        handler(message);
      }));
    }
  };

  const resolveRuntime = async (): Promise<ExecutionRunHostRuntime> => {
    if (disposed) throw new Error('Lazy execution-run runtime is disposed');
    if (resolvedRuntimePromise) {
      return await resolvedRuntimePromise;
    }

    resolvedRuntimePromise = (async () => {
      const runtime = await params.resolveRuntime();
      if (disposed) {
        await runtime.dispose();
        throw new Error('Lazy execution-run runtime is disposed');
      }
      resolvedRuntime = runtime;
      permissionCapability = runtime.permissionCapability ?? permissionCapability;
      attachQueuedHandlers(runtime);
      if (!emittedRuntimeDescriptor) {
        emitRuntimeEvent('runtime.descriptor', params.runtimeDescriptor ?? null);
        emittedRuntimeDescriptor = true;
      }
      if (!emittedRuntimeCapabilities) {
        emitRuntimeEvent('runtime.capabilities', params.runtimeCapabilities ?? null);
        emittedRuntimeCapabilities = true;
      }
      if (!emittedRuntimeFacets) {
        emitRuntimeEvent('runtime.facets', params.runtimeFacets ?? null);
        emittedRuntimeFacets = true;
      }
      return runtime;
    })();

    return await resolvedRuntimePromise;
  };

  const refreshPermissionCapability = (runtime: ExecutionRunHostRuntime): void => {
    permissionCapability = runtime.permissionCapability ?? permissionCapability;
  };

  const respondToPermission = async (requestId: string, approved: boolean) => {
    if (!activeSessionId) {
      if (!sessionProvisionPromise) {
        return { delivered: false as const, reason: 'no_active_session' as const };
      }
      await sessionProvisionPromise;
    }
    const runtime = await resolveRuntime();
    const runtimeResponder = permissionCapability === 'responds'
      ? runtime.respondToPermission
      : undefined;
    if (!runtimeResponder) {
      return { delivered: false as const, reason: 'no_active_session' as const };
    }
    return await runtimeResponder(requestId, approved);
  };

  return wrapExecutionRunHostRuntime({
    readPermissionCapability: () => permissionCapability ?? undefined,
    async readResumeSupport(opts) {
      const runtime = await resolveRuntime();
      return await runtime.readResumeSupport(opts);
    },
    async provisionSession(opts) {
      const provisionPromise = (async () => {
        const runtime = await resolveRuntime();
        const started = await runtime.provisionSession(opts);
        activeSessionId = started.sessionId;
        refreshPermissionCapability(runtime);
        await params.onProvisionSession?.(started.sessionId);
        return started.sessionId;
      })();
      sessionProvisionPromise = provisionPromise;
      try {
        const sessionId = await provisionPromise;
        return { sessionId };
      } finally {
        if (sessionProvisionPromise === provisionPromise) {
          sessionProvisionPromise = null;
        }
      }
    },
    async sendPrompt(sessionId, prompt, meta) {
      const runtime = await resolveRuntime();
      activeSessionId = sessionId;
      await runtime.sendPrompt(sessionId, prompt, meta);
    },
    readSendSteerPrompt: () => resolvedRuntime?.sendSteerPrompt
      ? async (sessionId, prompt, meta) => {
          const runtime = await resolveRuntime();
          if (typeof runtime.sendSteerPrompt !== 'function') return;
          activeSessionId = sessionId;
          await runtime.sendSteerPrompt(sessionId, prompt, meta);
        }
      : undefined,
    async cancel(sessionId) {
      if (!activeSessionId) {
        if (!sessionProvisionPromise) return;
        await sessionProvisionPromise;
      }
      if (!activeSessionId || !resolvedRuntimePromise) return;
      const runtime = await resolveRuntime();
      await runtime.cancel(sessionId);
    },
    subscribeMessages(handler) {
      handlers.add(handler);
      void resolvedRuntimePromise?.then((runtime) => {
        if (!handlers.has(handler) || unsubscribeByHandler.has(handler)) return;
        unsubscribeByHandler.set(handler, runtime.subscribeMessages(handler));
      }).catch(() => {});
      return () => {
        handlers.delete(handler);
        unsubscribeByHandler.get(handler)?.();
        unsubscribeByHandler.delete(handler);
      };
    },
    readRespondToPermission: () => permissionCapability === 'responds' ? respondToPermission : undefined,
    readWaitForTurnCompletion: () => resolvedRuntime?.waitForTurnCompletion
      ? async (timeoutMs) => {
          const runtime = await resolveRuntime();
          await runtime.waitForTurnCompletion?.(timeoutMs);
        }
      : undefined,
    readProbeTurnLiveness: () => resolvedRuntime?.probeTurnLiveness
      ? async (sessionId) => {
          const runtime = await resolveRuntime();
          const probeTurnLiveness = runtime.probeTurnLiveness;
          if (typeof probeTurnLiveness !== 'function') {
            return { active: false };
          }
          return await probeTurnLiveness(sessionId);
        }
      : undefined,
    async dispose() {
      if (disposePromise) {
        return await disposePromise;
      }
      disposed = true;
      activeSessionId = null;
      handlers.clear();
      disposePromise = (async () => {
        for (const unsubscribe of unsubscribeByHandler.values()) {
          unsubscribe();
        }
        unsubscribeByHandler.clear();
        if (resolvedRuntime) {
          await resolvedRuntime.dispose();
          return;
        }
        if (resolvedRuntimePromise) {
          void resolvedRuntimePromise.then(
            async (runtime) => await runtime.dispose(),
            () => undefined,
          ).catch(() => undefined);
        }
      })();
      return await disposePromise;
    },
  });
}
