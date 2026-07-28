import { logger } from '@/ui/logger';

import type { PermissionRpcPayload } from './permissionRpc';
import { SESSION_RPC_METHODS, StructuredQuestionResponseV1Schema } from '@happier-dev/protocol';
import { PUBLIC_RPC_HANDLER_ERROR_CODES, PublicRpcHandlerError, isPublicRpcHandlerError } from '@happier-dev/protocol/rpcErrors';

type RpcHandlerManagerLike = {
  registerHandler: (method: string, handler: (payload: any) => any | Promise<any>) => void;
};

/**
 * Outcome a consumer can report for a permission RPC payload.
 *
 * - `boolean`: legacy contract (`true` = handled, `false` = not this consumer's request).
 * - `{ status: 'handled' }` / `{ status: 'unhandled' }`: explicit forms of the boolean contract.
 * - `{ status: 'expired' }`: the request WAS this consumer's, but the provider hook timeout already
 *   elapsed (the hook forwarder is dead), so the answer cannot reach the provider. The router surfaces
 *   this as a typed `permission_request_expired` failure instead of pretending the answer was delivered.
 */
export type PermissionRpcConsumerOutcome =
  | boolean
  | Readonly<{ status: 'handled' | 'unhandled' | 'expired' }>;

export type PermissionRpcConsumer = {
  name: string;
  tryHandlePermissionRpc: (payload: PermissionRpcPayload) => PermissionRpcConsumerOutcome;
};

export type PermissionRpcRouterResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      errorCode: 'permission_request_not_found' | 'permission_response_failed' | 'permission_request_expired';
      errorMessage: string;
      requestId: string;
    }>;

type NormalizedConsumerOutcome = 'handled' | 'unhandled' | 'expired';

function normalizeConsumerOutcome(outcome: PermissionRpcConsumerOutcome): NormalizedConsumerOutcome {
  if (outcome === true) return 'handled';
  if (outcome === false) return 'unhandled';
  return outcome.status;
}

export class ClaudePermissionRpcRouter {
  private readonly consumers = new Map<string, PermissionRpcConsumer>();

  constructor(private readonly rpcHandlerManager: RpcHandlerManagerLike) {
    this.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_LEGACY, async (payload: PermissionRpcPayload) => {
      return this.dispatch(payload);
    });
    this.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1, async (payload: unknown) => {
      const parsed = StructuredQuestionResponseV1Schema.safeParse(payload);
      if (!parsed.success) {
        throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID);
      }
      const result = this.dispatch({ id: parsed.data.id, approved: true, structuredAnswersV1: parsed.data.structuredAnswersV1 });
      if (!result.ok) {
        throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER);
      }
      return result;
    });
  }

  registerConsumer(consumer: PermissionRpcConsumer): void {
    this.consumers.set(consumer.name, consumer);
  }

  private dispatch(payload: PermissionRpcPayload): PermissionRpcRouterResult {
    const requestId = typeof payload?.id === 'string' ? payload.id : '';
    if (!requestId) {
      return {
        ok: false,
        errorCode: 'permission_request_not_found',
        errorMessage: 'permission_request_not_found',
        requestId,
      };
    }

    let failedConsumer: string | null = null;
    for (const consumer of this.consumers.values()) {
      try {
        const outcome = normalizeConsumerOutcome(consumer.tryHandlePermissionRpc(payload));
        if (outcome === 'handled') {
          return { ok: true };
        }
        if (outcome === 'expired') {
          return {
            ok: false,
            errorCode: 'permission_request_expired',
            errorMessage: 'permission_request_expired',
            requestId,
          };
        }
      } catch (error) {
        if (isPublicRpcHandlerError(error)) throw error;
        failedConsumer = consumer.name;
        logger.debug('[claude-permissions] Permission RPC consumer failed', { name: consumer.name, error });
      }
    }

    if (failedConsumer) {
      return {
        ok: false,
        errorCode: 'permission_response_failed',
        errorMessage: 'permission_response_failed',
        requestId,
      };
    }

    if (payload.answers !== undefined || payload.structuredAnswersV1 !== undefined) {
      throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER);
    }

    logger.debug('[claude-permissions] Permission RPC not handled', { requestId });
    return {
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      requestId,
    };
  }
}
