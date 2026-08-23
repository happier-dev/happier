import {
  ActionOperationCancelV1RequestSchema,
  ActionOperationCancelV1ResponseSchema,
  ActionOperationGetV1RequestSchema,
  ActionOperationGetV1ResponseSchema,
  ActionOperationListV1RequestSchema,
  ActionOperationListV1ResponseSchema,
  ACTION_OPERATION_RPC_METHODS_V1,
  type ActionOperationCancelV1Response,
  type ActionOperationGetV1Response,
  type ActionOperationListV1Response,
} from '@happier-dev/protocol/actions';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ActionOperationRunner } from './actionOperationRunner';
import type { ActionOperationStore } from './actionOperationStore';

export function createActionOperationRpcHandlers(deps: Readonly<{
  store: ActionOperationStore;
  runner: Pick<ActionOperationRunner, 'cancel'>;
  machineId: string;
  resolveAccountId: () => Promise<string | null>;
}>) {
  const resolveScope = async (sessionId?: string) => {
    const accountId = await deps.resolveAccountId();
    if (!accountId) throw new Error('not_authenticated');
    return {
      accountId,
      machineId: deps.machineId,
      ...(sessionId ? { sessionId } : {}),
    };
  };

  return Object.freeze({
    async list(raw: unknown): Promise<ActionOperationListV1Response> {
      const request = ActionOperationListV1RequestSchema.parse(raw);
      const scope = await resolveScope(request.sessionId);
      return ActionOperationListV1ResponseSchema.parse(deps.store.list({
        ...scope,
        ...(request.states ? { states: request.states } : {}),
        ...(request.cursor ? { cursor: request.cursor } : {}),
      }));
    },

    async get(raw: unknown): Promise<ActionOperationGetV1Response> {
      const request = ActionOperationGetV1RequestSchema.parse(raw);
      const scope = await resolveScope();
      const operation = deps.store.get(scope, request.operationId);
      return ActionOperationGetV1ResponseSchema.parse(
        operation ? { kind: 'found', operation } : { kind: 'not_found' },
      );
    },

    async cancel(raw: unknown): Promise<ActionOperationCancelV1Response> {
      const request = ActionOperationCancelV1RequestSchema.parse(raw);
      const scope = await resolveScope();
      return ActionOperationCancelV1ResponseSchema.parse(
        deps.runner.cancel(scope, request.operationId),
      );
    },
  });
}

export type ActionOperationRpcHandlers = ReturnType<typeof createActionOperationRpcHandlers>;

export function registerActionOperationRpcHandlers(
  registrar: RpcHandlerRegistrar,
  handlers: ActionOperationRpcHandlers,
): void {
  registrar.registerHandler(ACTION_OPERATION_RPC_METHODS_V1.list, handlers.list);
  registrar.registerHandler(ACTION_OPERATION_RPC_METHODS_V1.get, handlers.get);
  registrar.registerHandler(ACTION_OPERATION_RPC_METHODS_V1.cancel, handlers.cancel);
}
