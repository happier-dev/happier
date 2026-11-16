import type {
  AgentExecutionRunConversationEventV1,
  AgentExecutionRunConversationRuntimeV1,
  AgentSessionSendRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import { asRecord, readNonBlankOpaqueIdentifier } from './openCodeParsing.js';
import { createOpenCodeRuntimeDiagnostic as diagnostic, projectOpenCodeTurnCancellationCause, projectOpenCodeRuntimeIssueDiagnostic } from './openCodeRuntimeEvents.js';
import { buildOpenCodePromptParts, OpenCodePromptProjectionError } from './promptParts.js';
import { OpenCodePromptIdentityUnresolvedError } from './promptSubmissionError.js';


/** Scope-neutral projection of the one OpenCode provider conversation owner. */
export function createOpenCodeExecutionRunConversation(params: Readonly<{
  operations: OpenCodeRuntimeTurnOperations;
  executionRunId: string;
  disposeOperations(): Promise<void>;
}>): AgentExecutionRunConversationRuntimeV1 {
  const listeners = new Set<(event: AgentExecutionRunConversationEventV1) => void>();
  const history: AgentExecutionRunConversationEventV1[] = [];
  let activeTurnId: string | null = null;
  let providerSessionId: string | null = null;
  let disposed = false;

  const publish = (event: AgentExecutionRunConversationEventV1): void => {
    if (disposed) return;
    history.push(Object.freeze(event));
    for (const listener of Array.from(listeners)) listener(event);
  };
  const publishProviderIdentity = (emittedAtMs = Date.now()): void => {
    const next = params.operations.readSessionIdentity().sessionId;
    if (!next || next === providerSessionId) return;
    providerSessionId = next;
    publish({ kind: 'provider-session-id', providerSessionId: next, emittedAtMs });
  };

  const unsubscribe = params.operations.subscribeRuntimeEvents((event) => {
    if (!('executionRunId' in event) || event.executionRunId !== params.executionRunId) return;
    publishProviderIdentity(event.emittedAtMs);
    if (event.kind === 'turn-start') {
      activeTurnId = event.turnId;
      publish({ kind: 'turn-progress', turnId: event.turnId, emittedAtMs: event.emittedAtMs });
      return;
    }
    if (event.kind === 'turn-progress') {
      publish({ kind: 'turn-progress', turnId: event.turnId, emittedAtMs: event.emittedAtMs,
        ...(event.retry ? { retry: event.retry } : {}) });
      return;
    }
    if (event.kind === 'transcript-agent-message-committed') {
      const body = asRecord(event.body);
      const text = typeof body?.message === 'string' ? body.message : '';
      const sidechainId = readNonBlankOpaqueIdentifier(body?.sidechainId);
      if (text && (body?.type === 'message' || body?.type === 'thinking')) {
        publish({
          kind: 'transcript-message-committed',
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(sidechainId ? { sidechainId } : {}),
          messageId: event.localId,
          role: body.type === 'thinking' ? 'reasoning' : 'assistant',
          text,
          emittedAtMs: event.emittedAtMs,
        });
      }
      return;
    }
    if (event.kind === 'turn-complete') {
      activeTurnId = null;
      publish({ kind: 'turn-complete', turnId: event.turnId, emittedAtMs: event.emittedAtMs });
      return;
    }
    if (event.kind === 'turn-failed') {
      activeTurnId = null;
      publish({
        kind: 'turn-failed',
        turnId: event.turnId,
        emittedAtMs: event.emittedAtMs,
        diagnostic: projectOpenCodeRuntimeIssueDiagnostic(event.issue),
      });
      return;
    }
    if (event.kind === 'turn-cancelled') {
      activeTurnId = null;
      publish({
        kind: 'turn-cancelled',
        turnId: event.turnId,
        cause: projectOpenCodeTurnCancellationCause(event.reason),
        emittedAtMs: event.emittedAtMs,
      });
    }
  });

  publishProviderIdentity();
  return {
    async send(request: AgentSessionSendRequest, options) {
      if (disposed) return { status: 'unavailable' };
      if (activeTurnId) {
        return { status: 'unavailable', diagnostic: diagnostic('opencode_execution_run_busy') };
      }
      if (!request.input.text.trim() && request.input.structuredInput === undefined) {
        return { status: 'rejected', diagnostic: diagnostic('opencode_input_missing_text') };
      }
      try {
        const promptProjection = buildOpenCodePromptParts({
          text: request.input.text,
          structuredInput: request.input.structuredInput,
        });
        const promptParts = Array.isArray(promptProjection)
          ? promptProjection
          : await promptProjection;
        activeTurnId = request.delivery.turnId;
        params.operations.beginTurnLifecycle(request.delivery.turnId);
        await params.operations.sendTurnPrompt(request.input.text, {
          localInputId: options?.localInputId ?? request.inputIds[0],
          localInputIds: request.inputIds,
          promptParts,
        });
        publishProviderIdentity();
        return { status: 'admitted' };
      } catch (error) {
        if (activeTurnId === request.delivery.turnId) activeTurnId = null;
        const identityUnproven = error instanceof OpenCodePromptIdentityUnresolvedError;
        return {
          status: identityUnproven ? 'unavailable' : 'rejected',
          ...(identityUnproven ? { retryable: false } : {}),
          diagnostic: diagnostic(
            identityUnproven
              ? 'opencode_input_custody_unknown'
              : error instanceof OpenCodePromptProjectionError
              ? error.code
              : 'opencode_input_rejected',
            error instanceof Error ? error.message : String(error),
            error,
          ),
        };
      }
    },
    async cancel(request) {
      if (!activeTurnId || activeTurnId !== request.turnId) return { status: 'notRunning' };
      try {
        await params.operations.cancelTurn();
        return { status: 'requested', turnId: request.turnId };
      } catch (error) {
        return {
          status: 'unavailable',
          diagnostic: diagnostic(
            'opencode_cancellation_unavailable',
            error instanceof Error ? error.message : String(error),
            error,
          ),
        };
      }
    },
    watch(listener) {
      for (const event of history) listener(event);
      if (!disposed) listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
      await params.disposeOperations();
    },
  };
}
