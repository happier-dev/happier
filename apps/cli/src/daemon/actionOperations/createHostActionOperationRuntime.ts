import {
  ActionIdSchema,
  getActionSpec,
  type ActionExecuteResult,
  type ActionOperationDomainRefV1,
  type ActionOperationSnapshotV1,
  type ActionOperationDeclarationV1,
} from '@happier-dev/protocol/actions';

import { createActionOperationRpcHandlers } from './actionOperationRpcHandlers';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';
import type { ActionOperationProgressUpdate } from './actionOperationTypes';

function readRequestId(actionId: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Readonly<Record<string, unknown>>;
  const candidate = actionId === 'session.spawn_new' ? record.creationKey : record.requestId;
  if (typeof candidate !== 'string') return undefined;
  const normalized = candidate.trim();
  return normalized.length > 0 && normalized.length <= 2_000 ? normalized : undefined;
}

function readInitialDomainRef(
  actionId: string,
  input: unknown,
  requestId: string | undefined,
): ActionOperationDomainRefV1 | undefined {
  if (!requestId) return undefined;
  if (actionId === 'session.spawn_new') return { kind: 'spawnAttempt' as const, id: requestId };
  if (actionId !== 'session.fork') return undefined;
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Readonly<Record<string, unknown>>
    : null;
  const strategy = record?.strategy;
  return {
    kind: 'forkRequest' as const,
    id: requestId,
    ...(strategy === 'native' || strategy === 'replay' ? { strategy } : {}),
  };
}

export function createHostActionOperationRuntime(deps: Readonly<{
  machineId: string;
  resolveAccountId: () => Promise<string | null>;
  generateOperationId?: () => string;
  publishSnapshot?: (snapshot: ActionOperationSnapshotV1) => void;
  supportsCoreCancellation?: (
    actionId: 'session.fork' | 'session.spawn_new' | 'session.handoff',
    input: unknown,
  ) => boolean;
}>) {
  const store = createActionOperationStore({
    ...(deps.publishSnapshot ? { onSnapshot: deps.publishSnapshot } : {}),
  });
  const runner = createActionOperationRunner({
    store,
    resolveAction: (rawActionId) => {
      const parsed = ActionIdSchema.safeParse(rawActionId);
      const spec = parsed.success ? getActionSpec(parsed.data) : null;
      return spec?.operation
        ? { actionId: spec.id, title: spec.title, operation: spec.operation }
        : null;
    },
    ...(deps.generateOperationId ? { generateOperationId: deps.generateOperationId } : {}),
  });
  const handlers = createActionOperationRpcHandlers({
    store,
    runner,
    machineId: deps.machineId,
    resolveAccountId: deps.resolveAccountId,
  });

  const observeExecution = async (request: Readonly<{
    actionId: string;
    input: unknown;
    sessionId?: string;
    execute: (context: Readonly<{
      signal: AbortSignal;
      operationProgress: Readonly<{ update: (update: ActionOperationProgressUpdate) => void }>;
      operationOwnerUpdate: Readonly<{ update: (update: import('./actionOperationTypes').ActionOperationOwnerUpdate) => void }>;
    }>) => Promise<ActionExecuteResult>;
  }>): Promise<ActionExecuteResult> => {
    const accountId = await deps.resolveAccountId();
    const actionId = ActionIdSchema.safeParse(request.actionId);
    const spec = actionId.success ? getActionSpec(actionId.data) : null;
    if (!accountId || !spec?.operation) {
      return await request.execute({
        signal: new AbortController().signal,
        operationProgress: { update: () => undefined },
        operationOwnerUpdate: { update: () => undefined },
      });
    }
    const cancellableActionId = request.actionId === 'session.fork'
      || request.actionId === 'session.spawn_new'
      || request.actionId === 'session.handoff'
      ? request.actionId
      : null;
    const requestId = readRequestId(request.actionId, request.input);
    const domainRef = readInitialDomainRef(request.actionId, request.input, requestId);
    return await runner.observe({
      actionId: request.actionId,
      scope: {
        accountId,
        machineId: deps.machineId,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      },
      ...(requestId ? { requestId } : {}),
      ...(domainRef ? { domainRef } : {}),
      cancellation: cancellableActionId
        && deps.supportsCoreCancellation?.(cancellableActionId, request.input) === true
        ? 'supported'
        : 'unsupported',
      execute: async ({ signal, updateProgress, publishOwnerUpdate }) => await request.execute({
        signal,
        operationProgress: { update: updateProgress },
        operationOwnerUpdate: { update: publishOwnerUpdate },
      }),
    });
  };

  const observePluginExecution = async (request: Readonly<{
    actionId: string;
    title: string;
    operation: ActionOperationDeclarationV1;
    input: unknown;
    requestId?: string;
    sessionId?: string;
    execute: (context: Readonly<{
      signal: AbortSignal;
      operationProgress: Readonly<{ update: (update: ActionOperationProgressUpdate) => void }>;
    }>) => Promise<ActionExecuteResult>;
  }>): Promise<ActionExecuteResult> => {
    const accountId = await deps.resolveAccountId();
    if (!accountId) {
      return await request.execute({
        signal: new AbortController().signal,
        operationProgress: { update: () => undefined },
      });
    }
    return await runner.observe({
      actionId: request.actionId,
      action: {
        actionId: request.actionId,
        title: request.title,
        operation: request.operation,
      },
      scope: {
        accountId,
        machineId: deps.machineId,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      },
      ...(request.requestId ? { requestId: request.requestId } : {}),
      execute: async ({ signal, updateProgress }) => await request.execute({
        signal,
        operationProgress: { update: updateProgress },
      }),
    });
  };

  return Object.freeze({ store, runner, handlers, observeExecution, observePluginExecution });
}

export type HostActionOperationRuntime = ReturnType<typeof createHostActionOperationRuntime>;
