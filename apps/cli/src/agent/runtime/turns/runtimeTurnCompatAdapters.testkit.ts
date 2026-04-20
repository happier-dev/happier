import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '@/agent/core/AgentBackend';

import type { RuntimeTurnOperations } from './runtimeTurnOperations';

function normalizeResumeId(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireRuntimeTurnSessionId(sessionId: string | null): SessionId {
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return sessionId as SessionId;
  }
  throw new Error('Runtime turn operation requires a started session');
}

export function createRuntimeTurnOperationsFromLegacyAgentBackend(backend: AgentBackend): RuntimeTurnOperations {
  let currentSessionId: string | null = null;

  return Object.freeze({
    beginTurnLifecycle() {},
    async startOrLoadSession(opts) {
      const resumeId = normalizeResumeId(opts?.resumeId);
      const started = resumeId && typeof backend.loadSession === 'function'
        ? await backend.loadSession(resumeId as SessionId)
        : await backend.startSession();
      currentSessionId = started.sessionId;
    },
    async sendTurnPrompt(prompt) {
      await backend.sendPrompt(requireRuntimeTurnSessionId(currentSessionId), prompt);
    },
    async steerInFlightTurn(message) {
      if (typeof backend.sendSteerPrompt !== 'function') {
        throw new Error('Runtime turn operation does not support in-flight steering');
      }
      await backend.sendSteerPrompt(requireRuntimeTurnSessionId(currentSessionId), message);
    },
    async waitForTurnCompletion(opts) {
      if (typeof backend.waitForResponseComplete !== 'function') return;
      await backend.waitForResponseComplete(opts?.timeoutMs ?? null);
    },
    subscribeRuntimeMessages(handler) {
      backend.onMessage(handler);
      return () => {
        backend.offMessage?.(handler);
      };
    },
    async respondToPermission(requestId, approved) {
      if (typeof backend.respondToPermission !== 'function') return;
      await backend.respondToPermission(requestId, approved);
    },
    async cancelTurn() {
      if (!currentSessionId) return;
      await backend.cancel(currentSessionId as SessionId);
    },
    readSessionIdentity() {
      return { sessionId: currentSessionId };
    },
    async updateSessionRuntimeConfig() {},
    async resetOrDisposeRuntime() {
      await backend.dispose();
      currentSessionId = null;
    },
  });
}

export function createLegacyAgentBackendFromRuntimeTurnOperations(
  operations: RuntimeTurnOperations,
): AgentBackend {
  const unsubscribeByHandler = new Map<AgentMessageHandler, () => void>();

  const readStartedSession = (): StartSessionResult => ({
    sessionId: requireRuntimeTurnSessionId(operations.readSessionIdentity().sessionId),
  });

  const backend: AgentBackend = {
    async startSession() {
      await operations.startOrLoadSession();
      return readStartedSession();
    },
    async loadSession(sessionId) {
      await operations.startOrLoadSession({ resumeId: sessionId });
      return readStartedSession();
    },
    async sendPrompt(_sessionId, prompt) {
      operations.beginTurnLifecycle();
      await operations.sendTurnPrompt(prompt);
    },
    async sendSteerPrompt(_sessionId, prompt) {
      await operations.steerInFlightTurn(prompt);
    },
    async cancel() {
      await operations.cancelTurn();
    },
    onMessage(handler) {
      if (unsubscribeByHandler.has(handler)) return;
      const unsubscribe = operations.subscribeRuntimeMessages((message) => {
        handler(message as AgentMessage);
      });
      unsubscribeByHandler.set(handler, unsubscribe);
    },
    offMessage(handler) {
      const unsubscribe = unsubscribeByHandler.get(handler);
      if (!unsubscribe) return;
      unsubscribe();
      unsubscribeByHandler.delete(handler);
    },
    async respondToPermission(requestId, approved) {
      await operations.respondToPermission(requestId, approved);
    },
    async waitForResponseComplete(timeoutMs) {
      await operations.waitForTurnCompletion({ timeoutMs });
    },
    async dispose() {
      for (const unsubscribe of unsubscribeByHandler.values()) {
        unsubscribe();
      }
      unsubscribeByHandler.clear();
      await operations.resetOrDisposeRuntime();
    },
  };

  return Object.freeze(backend);
}
