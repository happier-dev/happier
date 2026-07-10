import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
  ExecutionRunPermissionCapability,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { ResolvedAgentRuntimeContribution } from '@/plugins/projection/registry/types';
import type { AnyTerminalRuntimeOps } from '@/agent/catalog/types';
import { createNormalizedRuntimeEventWriter } from '@/agent/runtime/events/createNormalizedRuntimeEventWriter';
import { wrapExecutionRunHostRuntime } from '../hostRuntime/wrap';

import { normalizeTerminalRuntimeLaunchResult } from './terminalLaunch';

export type TerminalRuntimeExecutionRunBackendOptions = Readonly<{
  cwd: string;
  backendId: string;
  backend: ResolvedAgentRuntimeContribution;
  launch: NonNullable<AnyTerminalRuntimeOps['launch']>;
  modelId?: string;
  permissionMode: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  start?: ExecutionRunBackendStartContext | null;
}>;

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

export function createTerminalRuntimeExecutionRunBackend(
  opts: TerminalRuntimeExecutionRunBackendOptions,
): ExecutionRunHostRuntime {
  const handlers = new Set<ExecutionRunHostRuntimeMessageHandler>();
  let resolvedBackendPromise: Promise<ReturnType<typeof normalizeTerminalRuntimeLaunchResult>> | null = null;
  let resolvedBackend: ReturnType<typeof normalizeTerminalRuntimeLaunchResult> | null = null;
  let sessionProvisionPromise: Promise<string> | null = null;
  let disposePromise: Promise<void> | null = null;
  let activeSessionId: string | null = null;
  let runtimeUnsubscribe: (() => void) | null = null;
  let permissionCapability = readRuntimePermissionCapability(opts.backend.capabilities);

  const dispatchMessage = (message: Parameters<ExecutionRunHostRuntimeMessageHandler>[0]): void => {
    for (const handler of handlers) {
      try {
        handler(message);
      } catch {
        // Best effort: backend event subscribers must not break runtime routing.
      }
    }
  };

  const refreshPermissionCapability = (
    runtime: ExecutionRunHostRuntime,
    runtimeCapabilities?: unknown,
  ): void => {
    permissionCapability = runtime.permissionCapability
      ?? readRuntimePermissionCapability(runtimeCapabilities)
      ?? permissionCapability;
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
      refreshPermissionCapability(normalized.runtime, normalized.runtimeCapabilities);
      const runtimeEventWriter = createNormalizedRuntimeEventWriter({
        dispatch: dispatchMessage,
        identity: {
          runtimeDescriptor: normalized.runtimeDescriptor,
          runtimeCapabilities: normalized.runtimeCapabilities,
          runtimeFacets: normalized.runtimeFacets,
        },
      });
      runtimeUnsubscribe = normalized.runtime.subscribeMessages((message) => {
        if (message.type === 'event' && message.name === 'runtime.capabilities') {
          permissionCapability = readRuntimePermissionCapability(message.payload) ?? 'static';
        }
        runtimeEventWriter.handleMessage(message);
      });
      runtimeEventWriter.publishFallbackIdentity();
      resolvedBackend = normalized;
      return normalized;
    })();
    return await resolvedBackendPromise;
  };

  const respondToPermission = async (requestId: string, approved: boolean) => {
    if (!activeSessionId) {
      if (!sessionProvisionPromise) {
        return { delivered: false as const, reason: 'no_active_session' as const };
      }
      await sessionProvisionPromise;
    }
    const resolved = await resolveBackend();
    refreshPermissionCapability(resolved.runtime, resolved.runtimeCapabilities);
    const runtimeResponder = permissionCapability === 'responds'
      ? resolved.runtime.respondToPermission
      : undefined;
    if (!runtimeResponder) {
      return { delivered: false as const, reason: 'no_active_session' as const };
    }
    return await runtimeResponder(requestId, approved);
  };

  return wrapExecutionRunHostRuntime({
    readPermissionCapability: () => permissionCapability ?? undefined,
    async readResumeSupport(opts2) {
      const resolved = await resolveBackend();
      return await resolved.runtime.readResumeSupport(opts2);
    },
    async provisionSession(opts2) {
      const initialPrompt = typeof opts2?.initialPrompt === 'string' ? opts2.initialPrompt : undefined;
      const provisionPromise = (async () => {
        const resolved = await resolveBackend(initialPrompt);
        if (resolved.startedSessionId) {
          activeSessionId = resolved.startedSessionId;
          refreshPermissionCapability(resolved.runtime, resolved.runtimeCapabilities);
          return resolved.startedSessionId;
        }
        const started = await resolved.runtime.provisionSession(opts2);
        activeSessionId = started.sessionId;
        refreshPermissionCapability(resolved.runtime, resolved.runtimeCapabilities);
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
      const resolved = await resolveBackend();
      activeSessionId = sessionId;
      await resolved.runtime.sendPrompt(sessionId, prompt, meta);
    },
    readSendSteerPrompt: () => resolvedBackend?.runtime.sendSteerPrompt
      ? async (sessionId, prompt, meta) => {
          const resolved = await resolveBackend();
          if (typeof resolved.runtime.sendSteerPrompt !== 'function') return;
          activeSessionId = sessionId;
          await resolved.runtime.sendSteerPrompt(sessionId, prompt, meta);
        }
      : undefined,
    async cancel(sessionId) {
      if (!activeSessionId) {
        if (!sessionProvisionPromise) return;
        await sessionProvisionPromise;
      }
      if (!activeSessionId || !resolvedBackendPromise) return;
      const resolved = await resolveBackend();
      await resolved.runtime.cancel(sessionId);
    },
    subscribeMessages(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    readRespondToPermission: () => permissionCapability === 'responds' ? respondToPermission : undefined,
    readWaitForTurnCompletion: () => resolvedBackend?.runtime.waitForTurnCompletion
      ? async (timeoutMs) => {
          const resolved = await resolveBackend();
          await resolved.runtime.waitForTurnCompletion?.(timeoutMs);
        }
      : undefined,
    readProbeTurnLiveness: () => resolvedBackend?.runtime.probeTurnLiveness
      ? async (sessionId) => {
          const resolved = await resolveBackend();
          const probeTurnLiveness = resolved.runtime.probeTurnLiveness;
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
      if (!resolvedBackendPromise) return;
      disposePromise = (async () => {
        const resolved = await resolvedBackendPromise?.catch(() => null);
        if (!resolved) return;
        runtimeUnsubscribe?.();
        runtimeUnsubscribe = null;
        await resolved.runtime.dispose();
      })();
      return await disposePromise;
    },
  });
}
