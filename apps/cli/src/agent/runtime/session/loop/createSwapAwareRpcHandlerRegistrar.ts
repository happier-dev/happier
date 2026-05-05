import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';

export type SwapAwareRpcHandlerRegistrar = Readonly<{
  registrar: RpcHandlerRegistrar;
  rebindTo: (nextRegistrar: RpcHandlerRegistrar) => void;
}>;

export function createSwapAwareRpcHandlerRegistrar(
  getRegistrar: () => RpcHandlerRegistrar,
): SwapAwareRpcHandlerRegistrar {
  const registeredHandlers = new Map<string, RpcHandler>();

  const registerOn = (registrar: RpcHandlerRegistrar, method: string, handler: RpcHandler): void => {
    registrar.registerHandler(method, handler);
  };

  return {
    registrar: {
      registerHandler(method, handler) {
        registeredHandlers.set(method, handler);
        registerOn(getRegistrar(), method, handler);
      },
    },
    rebindTo(nextRegistrar) {
      for (const [method, handler] of registeredHandlers) {
        registerOn(nextRegistrar, method, handler);
      }
    },
  };
}
