import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
  createSessionLifecycleRpcActionExecutor,
} from '@/rpc/handlers/sessionLifecycle';
import { dispatchActionFromRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  SessionRollbackRpcParamsSchema,
  type SessionRollbackRpcParams,
  type SessionRollbackRpcResult,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

export type SessionRollbackRuntimeFacet = Readonly<{
  rollbackConversation: (request: SessionRollbackRpcParams) => Promise<SessionRollbackRpcResult>;
}>;

export function resolveSessionRollbackRuntimeFacet(runtime: unknown): SessionRollbackRuntimeFacet | null {
  if (!runtime || typeof runtime !== 'object') {
    return null;
  }
  const candidate = runtime as Partial<SessionRollbackRuntimeFacet>;
  return typeof candidate.rollbackConversation === 'function'
    ? { rollbackConversation: candidate.rollbackConversation.bind(runtime) }
    : null;
}

export function registerSessionRollbackRpcHandler(
  rpcHandlerManager: RpcHandlerRegistrar,
  resolveRuntimeFacet: () => SessionRollbackRuntimeFacet | null,
): void {
  rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_ROLLBACK, async (raw: unknown) => {
    const parsed = SessionRollbackRpcParamsSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, errorCode: 'invalid_request', errorMessage: 'Invalid params' } satisfies SessionRollbackRpcResult;
    }
    const dispatched = await dispatchActionFromRpc({
      actionId: 'session.rollback',
      input: parsed.data,
      executor: createSessionLifecycleRpcActionExecutor({
        'session.rollback': async (request: unknown) => {
          const runtimeFacet = resolveRuntimeFacet();
          if (!runtimeFacet) {
            return {
              ok: false,
              errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
              errorMessage: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
            } satisfies SessionRollbackRpcResult;
          }
          return await runtimeFacet.rollbackConversation(request as SessionRollbackRpcParams);
        },
      }),
    });
    if (!dispatched.ok) {
      return {
        ok: false,
        errorCode: dispatched.errorCode,
        errorMessage: dispatched.error,
      } satisfies SessionRollbackRpcResult;
    }
    return dispatched.result as SessionRollbackRpcResult;
  });
}
