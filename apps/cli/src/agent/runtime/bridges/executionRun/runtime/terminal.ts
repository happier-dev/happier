import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { ResolvedBackendContribution } from '@/plugins/projection/registry/types';
import type { AnyTerminalRuntimeOps } from '@/backends/types';
import { createNormalizedRuntimeEventWriter } from '@/agent/runtime/events/createNormalizedRuntimeEventWriter';

import { normalizeTerminalRuntimeLaunchResult } from './terminalLaunch';

export type TerminalRuntimeExecutionRunBackendOptions = Readonly<{
  cwd: string;
  backendId: string;
  backend: ResolvedBackendContribution;
  launch: NonNullable<AnyTerminalRuntimeOps['launch']>;
  modelId?: string;
  permissionMode: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  start?: ExecutionRunBackendStartContext | null;
}>;

export function createTerminalRuntimeExecutionRunBackend(
  opts: TerminalRuntimeExecutionRunBackendOptions,
): ExecutionRunHostRuntime {
  const handlers = new Set<ExecutionRunHostRuntimeMessageHandler>();
  let resolvedBackendPromise: Promise<ReturnType<typeof normalizeTerminalRuntimeLaunchResult>> | null = null;
  let runtimeUnsubscribe: (() => void) | null = null;

  const dispatchMessage = (message: Parameters<ExecutionRunHostRuntimeMessageHandler>[0]): void => {
    for (const handler of handlers) {
      try {
        handler(message);
      } catch {
        // Best effort: backend event subscribers must not break runtime routing.
      }
    }
  };

  const resolveBackend = async (
    initialPrompt?: string,
  ): Promise<ReturnType<typeof normalizeTerminalRuntimeLaunchResult>> => {
    if (resolvedBackendPromise) return await resolvedBackendPromise;
    resolvedBackendPromise = (async () => {
      const launchResult = await opts.launch({
        cwd: opts.cwd,
        backendId: opts.backendId,
        modelId: opts.modelId,
        permissionMode: opts.permissionMode,
        accountSettings: opts.accountSettings ?? null,
        start: opts.start ?? null,
        ...(typeof initialPrompt === 'string' ? { initialPrompt } : {}),
      } as never);
      const normalized = normalizeTerminalRuntimeLaunchResult({
        result: launchResult,
        backend: opts.backend,
      });
      const runtimeEventWriter = createNormalizedRuntimeEventWriter({
        dispatch: dispatchMessage,
        identity: {
          runtimeDescriptor: normalized.runtimeDescriptor,
          runtimeCapabilities: normalized.runtimeCapabilities,
          runtimeFacets: normalized.runtimeFacets,
        },
      });
      runtimeUnsubscribe = normalized.runtime.subscribeMessages((message) => {
        runtimeEventWriter.handleMessage(message);
      });
      runtimeEventWriter.publishFallbackIdentity();
      return normalized;
    })();
    return await resolvedBackendPromise;
  };

  return {
    async readResumeSupport(opts2) {
      const resolved = await resolveBackend();
      return await resolved.runtime.readResumeSupport(opts2);
    },
    async provisionSession(opts2) {
      const initialPrompt = typeof opts2?.initialPrompt === 'string' ? opts2.initialPrompt : undefined;
      const resolved = await resolveBackend(initialPrompt);
      if (resolved.startedSessionId) {
        return { sessionId: resolved.startedSessionId };
      }
      return await resolved.runtime.provisionSession(opts2);
    },
    async sendPrompt(sessionId, prompt) {
      const resolved = await resolveBackend();
      await resolved.runtime.sendPrompt(sessionId, prompt);
    },
    async sendSteerPrompt(sessionId, prompt) {
      const resolved = await resolveBackend();
      if (typeof resolved.runtime.sendSteerPrompt !== 'function') {
        throw new Error('Backend does not support steering');
      }
      await resolved.runtime.sendSteerPrompt(sessionId, prompt);
    },
    async cancel(sessionId) {
      const resolved = await resolveBackend();
      await resolved.runtime.cancel(sessionId);
    },
    subscribeMessages(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async respondToPermission(requestId, approved) {
      const resolved = await resolveBackend();
      if (typeof resolved.runtime.respondToPermission !== 'function') return;
      await resolved.runtime.respondToPermission(requestId, approved);
    },
    async waitForTurnCompletion(timeoutMs) {
      const resolved = await resolveBackend();
      if (typeof resolved.runtime.waitForTurnCompletion !== 'function') return;
      await resolved.runtime.waitForTurnCompletion(timeoutMs);
    },
    async dispose() {
      const resolved = await resolvedBackendPromise?.catch(() => null);
      if (!resolved) return;
      runtimeUnsubscribe?.();
      runtimeUnsubscribe = null;
      await resolved.runtime.dispose();
    },
  };
}
