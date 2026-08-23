import { randomUUID } from 'node:crypto';

import type {
  ActionOperationCancelV1Response,
  ActionOperationFailureV1,
  ActionExecuteResult,
} from '@happier-dev/protocol/actions';
import { ActionOperationDomainRefV1Schema } from '@happier-dev/protocol/actions';

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
}>;

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
    domainRef?: import('@happier-dev/protocol/actions').ActionOperationDomainRefV1;
    scope: ActionOperationScope;
    cancellation?: 'unsupported' | 'supported';
    execute: (context: Readonly<{
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
    const operationId = existing?.operationId ?? generateOperationId();
    const controller = active.get(operationId)?.controller ?? new AbortController();
    const cancellation = request.cancellation ?? 'unsupported';
    const ownsLifecycle = !existing;
    if (ownsLifecycle) {
      deps.store.create({
        operationId,
        actionId: action.actionId,
        scope: request.scope,
        title: action.title,
        cancellation,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        ...(request.domainRef ? { domainRef: request.domainRef } : {}),
      });
      active.set(operationId, { controller, cancellation });
      deps.store.markRunning(operationId);
    }
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
    try {
      const result = await request.execute({
        signal: controller.signal,
        updateProgress,
        publishOwnerUpdate,
      });
      if (!result.ok && result.errorCode === 'cancelled') {
        deps.store.cancel(operationId);
      } else if (result.ok) {
        deps.store.succeed(operationId, result.result);
      } else {
        deps.store.fail(operationId, { errorCode: result.errorCode, error: result.error });
      }
      return result;
    } catch (error) {
      deps.store.fail(operationId, projectThrownFailure(error));
      throw error;
    } finally {
      if (ownsLifecycle) active.delete(operationId);
    }
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
