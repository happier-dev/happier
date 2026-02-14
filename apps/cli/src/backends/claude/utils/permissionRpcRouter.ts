import { logger } from '@/ui/logger';

import type { PermissionRpcPayload } from './permissionRpc';

type RpcHandlerManagerLike = {
  registerHandler: (method: string, handler: (payload: any) => any | Promise<any>) => void;
};

export type PermissionRpcConsumer = {
  name: string;
  tryHandlePermissionRpc: (payload: PermissionRpcPayload) => boolean;
};

export class ClaudePermissionRpcRouter {
  private readonly consumers = new Map<string, PermissionRpcConsumer>();

  constructor(private readonly rpcHandlerManager: RpcHandlerManagerLike) {
    this.rpcHandlerManager.registerHandler('permission', async (payload: PermissionRpcPayload) => {
      this.dispatch(payload);
      return { ok: true } as const;
    });
  }

  registerConsumer(consumer: PermissionRpcConsumer): void {
    this.consumers.set(consumer.name, consumer);
  }

  private dispatch(payload: PermissionRpcPayload): void {
    const requestId = typeof payload?.id === 'string' ? payload.id : '';
    if (!requestId) {
      return;
    }

    for (const consumer of this.consumers.values()) {
      try {
        if (consumer.tryHandlePermissionRpc(payload)) {
          return;
        }
      } catch (error) {
        logger.debug('[claude-permissions] Permission RPC consumer failed', { name: consumer.name, error });
      }
    }

    logger.debug('[claude-permissions] Permission RPC not handled', { requestId });
  }
}
