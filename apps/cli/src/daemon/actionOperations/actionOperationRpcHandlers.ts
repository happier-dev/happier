import {
  ActionOperationCancelV1RequestSchema,
  ActionOperationGetV1RequestSchema,
  ActionOperationListV1RequestSchema,
  ACTION_OPERATION_RPC_METHODS_V1,
} from '@happier-dev/protocol';

import type { ActionOperationRunner } from './actionOperationRunner';
import type { ActionOperationStore } from './actionOperationStore';
import type { ActionOperationAccessScope } from './actionOperationTypes';

type RpcHandlerRegistrar = Readonly<{
  registerHandler: (
    method: string,
    handler: (request: unknown) => Promise<unknown>,
  ) => void;
}>;

function parseOrThrow<T>(schema: Readonly<{ safeParse: (value: unknown) => Readonly<{
  success: boolean;
  data?: T;
}> }>, raw: unknown, method: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${method} request`);
  return parsed.data as T;
}

export function registerActionOperationRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  runner: ActionOperationRunner;
  store: ActionOperationStore;
  getScope: () => Promise<ActionOperationAccessScope>;
}>): void {
  params.rpcHandlerManager.registerHandler(ACTION_OPERATION_RPC_METHODS_V1.list, async (raw) => {
    const request = parseOrThrow(ActionOperationListV1RequestSchema, raw, ACTION_OPERATION_RPC_METHODS_V1.list);
    return params.store.list(request, await params.getScope());
  });

  params.rpcHandlerManager.registerHandler(ACTION_OPERATION_RPC_METHODS_V1.get, async (raw) => {
    const request = parseOrThrow(ActionOperationGetV1RequestSchema, raw, ACTION_OPERATION_RPC_METHODS_V1.get);
    const operation = params.store.get(request.operationId, await params.getScope());
    return operation ? { kind: 'found', operation } : { kind: 'not_found' };
  });

  params.rpcHandlerManager.registerHandler(ACTION_OPERATION_RPC_METHODS_V1.cancel, async (raw) => {
    const request = parseOrThrow(ActionOperationCancelV1RequestSchema, raw, ACTION_OPERATION_RPC_METHODS_V1.cancel);
    return params.runner.cancel(request.operationId, await params.getScope());
  });
}
