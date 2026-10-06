import { randomUUID } from 'node:crypto';

import type {
  ActionOperationCancelV1Response,
  ActionOperationFailureV1,
  ActionExecuteResult,
} from '@happier-dev/protocol/actions';
import { ActionOperationDomainRefV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

import { parseActionOperationProgressUpdate } from './actionOperationProgress';
import type { ActionOperationStore } from './actionOperationStore';
import type {
  ActionOperationOwnerUpdate,
  ActionOperationProgressUpdate,
  ActionOperationQueryScope,
  ActionOperationScope,
  ResolvedTrackedAction,
} from './actionOperationTypes';

type ActiveInvocation = Readonly<{
  controller: AbortController;
  cancellation: 'unsupported' | 'supported';
  result: Promise<ActionExecuteResult>;
}>;

function terminalResult(snapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1): ActionExecuteResult | null {
  if (snapshot.state === 'succeeded') return { ok: true, result: snapshot.result };
  if (snapshot.state === 'failed') {
    return {
      ok: false,
      errorCode: snapshot.error?.errorCode ?? 'action_operation_failed',
      error: snapshot.error?.error ?? 'action_operation_failed',
    };
  }
  if (snapshot.state === 'cancelled') return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  return null;
}

function createCancellationRequestError(): Error {
  const error = new Error('Action operation cancellation requested');
  error.name = 'AbortError';
  return error;
}

function projectThrownFailure(error: unknown): ActionOperationFailureV1 {
  const code = error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' && error.code.trim()
    ? error.code.trim()
    : 'action_operation_failed';
  return {
    errorCode: code,
    error: error instanceof Error && error.message.trim()
      ? error.message
      : 'action_operation_failed',
  };
}

function isRecoverableIndeterminateHandoff(
  actionId: string,
  result: ActionExecuteResult,
): boolean {
  return actionId === 'session.handoff'
    && !result.ok
    && result.errorCode === 'indeterminate';
}

export function createActionOperationRunner(deps: Readonly<{
  store: ActionOperationStore;
  resolveAction: (actionId: string) => ResolvedTrackedAction | null;
  generateOperationId?: () => string;
}>) {
  const generateOperationId = deps.generateOperationId ?? randomUUID;
  const active = new Map<string, ActiveInvocation>();

  const observe = async (request: Readonly<{
    actionId: string;
    action?: ResolvedTrackedAction;
    requestId?: string;
    input?: unknown;
    domainRef?: import('@happier-dev/protocol/actions').ActionOperationDomainRefV1;
    scope: ActionOperationScope;
    cancellation?: 'unsupported' | 'supported';
    execute: (context: Readonly<{
      actionRequestId?: string;
      signal: AbortSignal;
      updateProgress: (update: ActionOperationProgressUpdate) => void;
      publishOwnerUpdate: (update: ActionOperationOwnerUpdate) => void;
    }>) => Promise<ActionExecuteResult>;
  }>): Promise<ActionExecuteResult> => {
    const action = request.action ?? deps.resolveAction(request.actionId);
    if (!action?.operation) {
      return await request.execute({
        signal: new AbortController().signal,
        updateProgress: () => undefined,
        publishOwnerUpdate: () => undefined,
      });
    }
    const existing = request.requestId
      ? deps.store.findByRequestIdentity(request.scope, request.actionId, request.requestId)
      : null;
    const inputIdentity = createCanonicalJsonSigningInput(request.input === undefined ? null : request.input);
    if (existing && !deps.store.hasMatchingInputIdentity(existing.operationId, inputIdentity)) {
      return { ok: false, errorCode: 'action_request_input_conflict', error: 'action_request_input_conflict' };
    }
    const invoke = async (
      operationId: string,
      cancellation: 'unsupported' | 'supported',
    ): Promise<ActionExecuteResult> => {
      const controller = new AbortController();
      const updateProgress = (update: ActionOperationProgressUpdate): void => {
        const progress = parseActionOperationProgressUpdate(update);
        if (progress) deps.store.updateProgress(operationId, progress);
      };
      const publishOwnerUpdate = (update: ActionOperationOwnerUpdate): void => {
        if (update.domainRef) {
          const domainRef = ActionOperationDomainRefV1Schema.safeParse(update.domainRef);
          if (domainRef.success) deps.store.updateDomainRef(operationId, domainRef.data);
        }
        if (update.progress) updateProgress(update.progress);
      };
      const result = (async (): Promise<ActionExecuteResult> => {
        try {
          const executionResult = await request.execute({
            actionRequestId: request.requestId ?? operationId,
            signal: controller.signal,
            updateProgress,
            publishOwnerUpdate,
          });
          if (isRecoverableIndeterminateHandoff(action.actionId, executionResult)) {
            return executionResult;
          }
          if (!executionResult.ok && executionResult.errorCode === 'cancelled') {
            deps.store.cancel(operationId);
          } else if (executionResult.ok) {
            deps.store.succeed(operationId, executionResult.result);
          } else {
            deps.store.fail(operationId, { errorCode: executionResult.errorCode, error: executionResult.error });
          }
          return executionResult;
        } catch (error) {
          const projected = projectThrownFailure(error);
          if (action.actionId !== 'session.handoff' || projected.errorCode !== 'indeterminate') {
            deps.store.fail(operationId, projected);
          }
          throw error;
        } finally {
          active.delete(operationId);
        }
      })();
      active.set(operationId, { controller, cancellation, result });
      return await result;
    };
    if (existing) {
      const invocation = active.get(existing.operationId);
      if (invocation) return await invocation.result;
      const settled = terminalResult(existing);
      if (settled) return settled;
      if (existing.state === 'running' && action.actionId === 'session.handoff') {
        return await invoke(existing.operationId, existing.cancellation);
      }
      return { ok: false, errorCode: 'action_operation_unavailable', error: 'action_operation_unavailable' };
    }
    const operationId = generateOperationId();
    const cancellation = request.cancellation ?? 'unsupported';
    deps.store.create({
      operationId,
      actionId: action.actionId,
      scope: request.scope,
      title: action.title,
      cancellation,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(request.domainRef ? { domainRef: request.domainRef } : {}),
      inputIdentity,
    });
    deps.store.markRunning(operationId);
    return await invoke(operationId, cancellation);
  };

  return Object.freeze({
    observe,
    cancel(scope: ActionOperationQueryScope, operationId: string): ActionOperationCancelV1Response {
      const snapshot = deps.store.get(scope, operationId);
      if (!snapshot) return { kind: 'not_found' };
      if (snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
        return { kind: 'already_settled' };
      }
      const invocation = active.get(operationId);
      if (!invocation || invocation.cancellation === 'unsupported') return { kind: 'unsupported' };
      invocation.controller.abort(createCancellationRequestError());
      return { kind: 'requested' };
    },
  });
}

export type ActionOperationRunner = ReturnType<typeof createActionOperationRunner>;
