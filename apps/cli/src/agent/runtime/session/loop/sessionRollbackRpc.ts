import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
  createSessionLifecycleRpcActionExecutor,
} from '@/rpc/handlers/sessionLifecycle';
import { dispatchActionFromRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  CheckpointCodeRollbackActionRequestSchema,
  SessionCheckpointRequestV1Schema,
  SessionRestoreRequestV1Schema,
  type CheckpointCodeRollbackRequest,
  type CheckpointCodeRollbackResult,
  type SessionCheckpointRequestV1,
  type SessionCheckpointResultV1,
  SessionRollbackRpcParamsSchema,
  type SessionRollbackRpcParams,
  type SessionRollbackRpcResult,
  type SessionRestoreRequestV1,
  type SessionRestoreResultV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

export type SessionRollbackRuntimeFacet = Readonly<{
  rollbackConversation?: (request: SessionRollbackRpcParams) => Promise<SessionRollbackRpcResult>;
  checkpointCodeRollback?: (request: CheckpointCodeRollbackRequest) => Promise<CheckpointCodeRollbackResult>;
  sessionCheckpoint?: (request: SessionCheckpointRequestV1) => Promise<SessionCheckpointResultV1>;
  sessionRestore?: (request: SessionRestoreRequestV1) => Promise<SessionRestoreResultV1>;
}>;

export function resolveSessionRollbackRuntimeFacet(runtime: unknown): SessionRollbackRuntimeFacet | null {
  if (!runtime || typeof runtime !== 'object') {
    return null;
  }
  const candidate = runtime as Partial<SessionRollbackRuntimeFacet>;
  const resolved: SessionRollbackRuntimeFacet = {
    ...(typeof candidate.rollbackConversation === 'function'
      ? { rollbackConversation: candidate.rollbackConversation.bind(runtime) }
      : {}),
    ...(typeof candidate.checkpointCodeRollback === 'function'
      ? { checkpointCodeRollback: candidate.checkpointCodeRollback.bind(runtime) }
      : {}),
    ...(typeof candidate.sessionCheckpoint === 'function'
      ? { sessionCheckpoint: candidate.sessionCheckpoint.bind(runtime) }
      : {}),
    ...(typeof candidate.sessionRestore === 'function'
      ? { sessionRestore: candidate.sessionRestore.bind(runtime) }
      : {}),
  };
  return Object.keys(resolved).length > 0 ? resolved : null;
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
      localActionContext: { authority: 'present_user' },
      executor: createSessionLifecycleRpcActionExecutor({
        'session.rollback': async (request: unknown) => {
          const runtimeFacet = resolveRuntimeFacet();
          if (!runtimeFacet?.rollbackConversation) {
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

  rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_CHECKPOINT, async (raw: unknown) => {
    const parsed = SessionCheckpointRequestV1Schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        errorCode: 'invalid_request',
        error: 'invalid_request',
      } satisfies SessionCheckpointResultV1;
    }
    const dispatched = await dispatchActionFromRpc({
      actionId: 'session.checkpoint',
      input: parsed.data,
      localActionContext: { authority: 'present_user' },
      executor: createSessionLifecycleRpcActionExecutor({
        'session.checkpoint': async (request: unknown) => {
          const runtimeFacet = resolveRuntimeFacet();
          if (!runtimeFacet?.sessionCheckpoint) {
            return {
              ok: false,
              errorCode: 'checkpoint_source_unavailable',
              error: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            } satisfies SessionCheckpointResultV1;
          }
          return await runtimeFacet.sessionCheckpoint(request as SessionCheckpointRequestV1);
        },
      }),
    });
    if (!dispatched.ok) {
      return {
        ok: false,
        errorCode: 'checkpoint_failed',
        error: dispatched.errorCode,
      } satisfies SessionCheckpointResultV1;
    }
    return dispatched.result as SessionCheckpointResultV1;
  });

  rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_RESTORE, async (raw: unknown) => {
    const parsed = SessionRestoreRequestV1Schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        errorCode: 'invalid_request',
        error: 'invalid_request',
      } satisfies SessionRestoreResultV1;
    }
    const dispatched = await dispatchActionFromRpc({
      actionId: 'session.restore',
      input: parsed.data,
      localActionContext: { authority: 'present_user' },
      executor: createSessionLifecycleRpcActionExecutor({
        'session.restore': async (request: unknown) => {
          const runtimeFacet = resolveRuntimeFacet();
          if (!runtimeFacet?.sessionRestore) {
            return {
              ok: false,
              errorCode: 'restore_target_missing',
              error: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            } satisfies SessionRestoreResultV1;
          }
          return await runtimeFacet.sessionRestore(request as SessionRestoreRequestV1);
        },
      }),
    });
    if (!dispatched.ok) {
      return {
        ok: false,
        errorCode: 'restore_target_missing',
        error: dispatched.errorCode,
      } satisfies SessionRestoreResultV1;
    }
    return dispatched.result as SessionRestoreResultV1;
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
      localActionContext: { authority: 'present_user' },
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
