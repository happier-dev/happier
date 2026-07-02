import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

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
  let emittedRuntimeDescriptor = false;
  let emittedRuntimeCapabilities = false;
  let emittedRuntimeFacets = false;

  const emitRuntimeEvent = (name: string, payload: unknown): void => {
    if (payload === null || payload === undefined) return;
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
      unsubscribeByHandler.set(handler, runtime.subscribeMessages(handler));
    }
  };

  const resolveRuntime = async (): Promise<ExecutionRunHostRuntime> => {
    if (resolvedRuntimePromise) {
      return await resolvedRuntimePromise;
    }

    resolvedRuntimePromise = (async () => {
      const runtime = await params.resolveRuntime();
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

  return {
    async readResumeSupport(opts) {
      const runtime = await resolveRuntime();
      return await runtime.readResumeSupport(opts);
    },
    async provisionSession(opts) {
      const runtime = await resolveRuntime();
      const started = await runtime.provisionSession(opts);
      if (started.sessionId) {
        await params.onProvisionSession?.(started.sessionId);
      }
      return started;
    },
    async sendPrompt(sessionId, prompt) {
      const runtime = await resolveRuntime();
      await runtime.sendPrompt(sessionId, prompt);
    },
    async sendSteerPrompt(sessionId, prompt) {
      const runtime = await resolveRuntime();
      if (typeof runtime.sendSteerPrompt !== 'function') {
        throw new Error('Backend does not support steering');
      }
      await runtime.sendSteerPrompt(sessionId, prompt);
    },
    async cancel(sessionId) {
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
    async respondToPermission(requestId, approved) {
      const runtime = await resolveRuntime();
      if (typeof runtime.respondToPermission !== 'function') return;
      await runtime.respondToPermission(requestId, approved);
    },
    async waitForTurnCompletion(timeoutMs) {
      const runtime = await resolveRuntime();
      if (typeof runtime.waitForTurnCompletion !== 'function') return;
      await runtime.waitForTurnCompletion(timeoutMs);
    },
    async dispose() {
      const runtime = await resolvedRuntimePromise?.catch(() => null);
      if (!runtime) return;
      for (const unsubscribe of unsubscribeByHandler.values()) {
        unsubscribe();
      }
      unsubscribeByHandler.clear();
      await runtime.dispose();
    },
  };
}
