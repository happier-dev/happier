import { logger } from '@/ui/logger';
import { SESSION_RPC_METHODS, StructuredQuestionResponseV1Schema, SessionPermissionResponseToOccurrenceV1Schema } from '@happier-dev/protocol';
import { PUBLIC_RPC_HANDLER_ERROR_CODES, PublicRpcHandlerError, isPublicRpcHandlerError } from '@happier-dev/protocol/rpcErrors';

import type { SessionPermissionRpcPayload } from './sessionPermissionRpc';

type RpcHandlerManagerLike = {
  registerHandler: (method: string, handler: (payload: unknown) => unknown | Promise<unknown>) => void;
};

export type SessionPermissionRpcConsumerOutcome =
  | boolean
  | Readonly<{ status: 'handled' | 'unhandled' | 'expired' }>;

export type SessionPermissionRpcConsumer = {
  name: string;
  tryHandlePermissionRpc: (
    payload: SessionPermissionRpcPayload,
  ) => SessionPermissionRpcConsumerOutcome | Promise<SessionPermissionRpcConsumerOutcome>;
};

export type SessionPermissionRpcRouterResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      errorCode: 'permission_request_not_found' | 'permission_response_failed' | 'permission_request_expired';
      errorMessage: string;
      requestId: string;
    }>;

function normalizeConsumerOutcome(outcome: SessionPermissionRpcConsumerOutcome): 'handled' | 'unhandled' | 'expired' {
  if (outcome === true) return 'handled';
  if (outcome === false) return 'unhandled';
  return outcome.status;
}

export class SessionPermissionRpcRouter {
  private readonly consumers = new Map<string, SessionPermissionRpcConsumer>();

  constructor(private readonly rpcHandlerManager: RpcHandlerManagerLike) {
    this.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_LEGACY, async (payload) => {
      return this.dispatch(payload as SessionPermissionRpcPayload);
    });
    this.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_TO_OCCURRENCE_V1, async (payload) => {
      const parsed = SessionPermissionResponseToOccurrenceV1Schema.safeParse(payload);
      if (!parsed.success) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', requestId: '' } satisfies SessionPermissionRpcRouterResult;
      }
      return this.dispatch(parsed.data);
    });
    this.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1, async (payload) => {
      const parsed = StructuredQuestionResponseV1Schema.safeParse(payload);
      if (!parsed.success) {
        throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID);
      }
      const result = await this.dispatch({
        id: parsed.data.id,
        occurrenceId: parsed.data.occurrenceId,
        approved: true,
        structuredAnswersV1: parsed.data.structuredAnswersV1,
      });
      if (!result.ok) {
        throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER);
      }
      return result;
    });
  }

  registerConsumer(consumer: SessionPermissionRpcConsumer): () => void {
    this.consumers.set(consumer.name, consumer);
    return () => {
      if (this.consumers.get(consumer.name) === consumer) {
        this.consumers.delete(consumer.name);
      }
    };
  }

  private async dispatch(payload: SessionPermissionRpcPayload): Promise<SessionPermissionRpcRouterResult> {
    const requestId = typeof payload?.id === 'string' ? payload.id : '';
    if (!requestId) {
      return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', requestId };
    }

    let failedConsumer: string | null = null;
    for (const consumer of this.consumers.values()) {
      try {
        const outcome = normalizeConsumerOutcome(await consumer.tryHandlePermissionRpc(payload));
        if (outcome === 'handled') return { ok: true };
        if (outcome === 'expired') {
          return { ok: false, errorCode: 'permission_request_expired', errorMessage: 'permission_request_expired', requestId };
        }
      } catch (error) {
        if (isPublicRpcHandlerError(error)) throw error;
        failedConsumer = consumer.name;
        logger.debug('[permissions] Permission RPC consumer failed', { name: consumer.name, error });
      }
    }

    if (failedConsumer) {
      return { ok: false, errorCode: 'permission_response_failed', errorMessage: 'permission_response_failed', requestId };
    }
    if (payload.answers !== undefined || payload.structuredAnswersV1 !== undefined) {
      throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER);
    }
    return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', requestId };
  }
}

const routersByRpcHandlerManager = new WeakMap<RpcHandlerManagerLike, SessionPermissionRpcRouter>();

/**
 * A router owns the permission-response methods of one RPC handler manager, so each manager has
 * exactly one: the live session client, the offline stub a provider starts on, and test sessions
 * all reach the same router through the manager they expose.
 */
export function getOrCreateSessionPermissionRpcRouter(rpcHandlerManager: RpcHandlerManagerLike): SessionPermissionRpcRouter {
  let router = routersByRpcHandlerManager.get(rpcHandlerManager);
  if (!router) {
    router = new SessionPermissionRpcRouter(rpcHandlerManager);
    routersByRpcHandlerManager.set(rpcHandlerManager, router);
  }
  return router;
}
