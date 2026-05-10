import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
  createSessionLifecycleRpcActionExecutor,
} from '@/rpc/handlers/sessionLifecycle';
import { dispatchActionFromRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  CheckpointCodeRollbackActionRequestSchema,
  type CheckpointCodeRollbackRequest,
  type CheckpointCodeRollbackResult,
  SessionRollbackRpcParamsSchema,
  type SessionRollbackRpcParams,
  type SessionRollbackRpcResult,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

export type SessionRollbackRuntimeFacet = Readonly<{
  rollbackConversation: (request: SessionRollbackRpcParams) => Promise<SessionRollbackRpcResult>;
  checkpointCodeRollback?: (request: CheckpointCodeRollbackRequest) => Promise<CheckpointCodeRollbackResult>;
}>;

export function resolveSessionRollbackRuntimeFacet(runtime: unknown): SessionRollbackRuntimeFacet | null {
  if (!runtime || typeof runtime !== 'object') {
    return null;
  }
  const candidate = runtime as Partial<SessionRollbackRuntimeFacet>;
  return typeof candidate.rollbackConversation === 'function'
    ? {
        rollbackConversation: candidate.rollbackConversation.bind(runtime),
        ...(typeof candidate.checkpointCodeRollback === 'function'
          ? { checkpointCodeRollback: candidate.checkpointCodeRollback.bind(runtime) }
          : {}),
      }
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

  rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK, async (raw: unknown) => {
    const parsed = CheckpointCodeRollbackActionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: 'unavailable',
        changedPaths: [],
        skippedPaths: [],
        receipts: ['checkpoint.rollback_aborted'],
        diagnostics: ['invalid_request'],
      } satisfies CheckpointCodeRollbackResult;
    }
    const dispatched = await dispatchActionFromRpc({
      actionId: 'session.checkpoint_code_rollback',
      input: parsed.data,
      executor: createSessionLifecycleRpcActionExecutor({
        'session.checkpoint_code_rollback': async (request: unknown) => {
          const runtimeFacet = resolveRuntimeFacet();
          if (!runtimeFacet?.checkpointCodeRollback) {
            return {
              status: 'unavailable',
              changedPaths: [],
              skippedPaths: [],
              receipts: ['checkpoint.rollback_aborted'],
              diagnostics: [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE],
            } satisfies CheckpointCodeRollbackResult;
          }
          return await runtimeFacet.checkpointCodeRollback(request as CheckpointCodeRollbackRequest);
        },
      }),
    });
    if (!dispatched.ok) {
      return {
        status: 'unavailable',
        changedPaths: [],
        skippedPaths: [],
        receipts: ['checkpoint.rollback_aborted'],
        diagnostics: [dispatched.errorCode, dispatched.error],
      } satisfies CheckpointCodeRollbackResult;
    }
    return dispatched.result as CheckpointCodeRollbackResult;
  });
}
