import { randomUUID } from 'node:crypto';

import { ActionOperationDomainRefV1Schema } from '@happier-dev/protocol';
import type {
  ActionOperationDomainRefV1,
  ActionOperationProgressV1,
} from '@happier-dev/protocol';
import type { ActionExecuteResult } from '@happier-dev/protocol';

import type { ActionOperationStore } from './actionOperationStore';
import type {
  ActionOperationAccessScope,
  ActionOperationCancelResult,
  ActionOperationExecutionRequest,
} from './actionOperationTypes';
import { parseActionOperationProgress } from './actionOperationProgress';

type Task = Readonly<{
  scope: ActionOperationAccessScope;
  controller: AbortController;
}>;

function isInScope(
  snapshot: Readonly<{ scope: ActionOperationAccessScope }>,
  scope: ActionOperationAccessScope,
): boolean {
  return snapshot.scope.accountId === scope.accountId && snapshot.scope.machineId === scope.machineId;
}

function normalizeThrownFailure(error: unknown): ActionExecuteResult {
  const record = error && typeof error === 'object' ? error as Readonly<Record<string, unknown>> : null;
  const rawCode = typeof record?.code === 'string' ? record.code.trim() : '';
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : typeof record?.message === 'string'
        ? record.message
        : '';
  return {
    ok: false,
    errorCode: (rawCode || 'action_failed').slice(0, 200),
    // A thrown value is not an ActionExecutor-owned public failure projection.
    // Keep its contents out of the process-local snapshot exposed over RPC.
    error: rawMessage || rawCode ? 'Action failed' : 'action_failed',
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isCancelledResult(
  result: ActionExecuteResult | Readonly<{ kind: 'cancelled' }>,
): result is Readonly<{ kind: 'cancelled' }> {
  return 'kind' in result && result.kind === 'cancelled';
}

export type ActionOperationRunner = ReturnType<typeof createActionOperationRunner>;

export function createActionOperationRunner(params: Readonly<{
  store: ActionOperationStore;
  createOperationId?: () => string;
  now?: () => number;
}>) {
  const createOperationId = params.createOperationId ?? randomUUID;
  const now = params.now ?? Date.now;
  const tasks = new Map<string, Task>();
  const operationIdsByCorrelation = new Map<string, string>();

  const correlationKey = (request: ActionOperationExecutionRequest, scope: ActionOperationAccessScope): string | null => (
    request.requestId
      ? JSON.stringify([scope.accountId, scope.machineId, request.actionId, request.requestId])
      : null
  );

  const cleanPrunedTasks = () => {
    for (const [operationId, task] of tasks) {
      if (!params.store.get(operationId, task.scope)) {
        tasks.delete(operationId);
        for (const [key, correlatedOperationId] of operationIdsByCorrelation) {
          if (correlatedOperationId === operationId) operationIdsByCorrelation.delete(key);
        }
      }
    }
  };

  const settle = (
    operationId: string,
    result: ActionExecuteResult | Readonly<{ kind: 'cancelled' }>,
    resolveDomainRef?: (result: ActionExecuteResult) => ActionOperationDomainRefV1 | undefined,
  ) => {
    const settledAt = now();
    const projectedDomainRef = !isCancelledResult(result) && resolveDomainRef
      ? ActionOperationDomainRefV1Schema.safeParse(resolveDomainRef(result))
      : null;
    const domainRef = projectedDomainRef?.success ? projectedDomainRef.data : undefined;
    if (isCancelledResult(result)) {
      params.store.update(operationId, (snapshot) => ({
        ...snapshot,
        state: 'cancelled',
        settledAt,
      }));
      return;
    }
    if (result.ok === true) {
      params.store.update(operationId, (snapshot) => ({
        ...snapshot,
        state: 'succeeded',
        settledAt,
        result: result.result,
        ...(domainRef ? { domainRef } : {}),
      }));
      return;
    }
    params.store.update(operationId, (snapshot) => ({
      ...snapshot,
      state: 'failed',
      settledAt,
      error: {
        errorCode: result.errorCode.slice(0, 200) || 'action_failed',
        error: result.error.slice(0, 10_000) || 'action_failed',
      },
      ...(domainRef ? { domainRef } : {}),
    }));
  };

  const cancel = (operationId: string, scope: ActionOperationAccessScope): ActionOperationCancelResult => {
    const snapshot = params.store.get(operationId, scope);
    if (!snapshot) return { kind: 'not_found' };
    if (snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
      return { kind: 'already_settled' };
    }
    if (snapshot.cancellation === 'unsupported') return { kind: 'unsupported' };
    const task = tasks.get(operationId);
    if (!task || !isInScope(snapshot, task.scope)) return { kind: 'not_found' };
    task.controller.abort();
    return { kind: 'requested' };
  };

  const executeHistorical = async <T>(input: Readonly<{
    request: ActionOperationExecutionRequest;
    scope: ActionOperationAccessScope;
    title: string;
    cancellation: 'unsupported' | 'supported';
    scopeSessionId?: string | null;
    domainRef?: ActionOperationDomainRefV1;
    execute: (context: Readonly<{
      signal: AbortSignal;
      update: (update: Readonly<{
        progress?: ActionOperationProgressV1;
        domainRef?: ActionOperationDomainRefV1;
      }>) => void;
    }>) => Promise<T>;
    projectResult: (value: T) => ActionExecuteResult | Readonly<{ kind: 'cancelled' }>;
  }>): Promise<T> => {
    cleanPrunedTasks();
    const key = correlationKey(input.request, input.scope);
    const correlatedOperationId = key ? operationIdsByCorrelation.get(key) : undefined;
    const correlatedTask = correlatedOperationId ? tasks.get(correlatedOperationId) : undefined;
    if (correlatedTask && params.store.get(correlatedOperationId!, correlatedTask.scope)) {
      return await input.execute({ signal: correlatedTask.controller.signal, update: () => {} });
    }
    const operationId = createOperationId();
    const resolvedScope = {
      accountId: input.scope.accountId,
      machineId: input.scope.machineId,
      ...(input.scopeSessionId ? { sessionId: input.scopeSessionId } : {}),
    };
    params.store.create({
      version: 1,
      operationId,
      ...(input.request.requestId ? { requestId: input.request.requestId } : {}),
      revision: 1,
      actionId: input.request.actionId,
      state: 'accepted',
      scope: resolvedScope,
      title: input.title,
      createdAt: now(),
      cancellation: input.cancellation,
      ...(input.domainRef ? { domainRef: input.domainRef } : {}),
    });
    const controller = new AbortController();
    tasks.set(operationId, { scope: resolvedScope, controller });
    if (key) operationIdsByCorrelation.set(key, operationId);
    params.store.update(operationId, (snapshot) => ({ ...snapshot, state: 'running', startedAt: now() }));
    const update = (candidate: Readonly<{
      progress?: ActionOperationProgressV1;
      domainRef?: ActionOperationDomainRefV1;
    }>) => {
      const progress = candidate.progress === undefined ? undefined : parseActionOperationProgress(candidate.progress);
      const domainRef = candidate.domainRef === undefined
        ? undefined
        : ActionOperationDomainRefV1Schema.safeParse(candidate.domainRef);
      if (candidate.progress !== undefined && !progress) return;
      if (candidate.domainRef !== undefined && !domainRef?.success) return;
      params.store.update(operationId, (snapshot) => ({
        ...snapshot,
        ...(progress ? { progress } : {}),
        ...(domainRef?.success ? { domainRef: domainRef.data } : {}),
      }));
    };
    try {
      const value = await input.execute({ signal: controller.signal, update });
      settle(operationId, input.projectResult(value));
      return value;
    } catch (error) {
      const acknowledgedCancellation = controller.signal.aborted && isAbortError(error);
      settle(
        operationId,
        acknowledgedCancellation ? { kind: 'cancelled' } : normalizeThrownFailure(error),
      );
      throw error;
    }
  };

  return { executeHistorical, cancel };
}
