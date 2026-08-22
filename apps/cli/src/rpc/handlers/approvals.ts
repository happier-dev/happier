import { readStoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { APPROVAL_RPC_SCOPES } from './actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';

type RpcRegistrar = Readonly<{
  registerHandler(method: string, handler: (input: unknown) => Promise<unknown>): void;
}>;

async function resolveProductionActionExecutor(): Promise<RpcActionExecutor> {
  const credentials = await readStoredCredentials().catch(() => null);
  if (!credentials) {
    return {
      execute: async () => ({
        ok: false,
        errorCode: 'not_authenticated',
        error: 'not_authenticated',
      }),
    };
  }
  return createCliActionExecutorFromCredentials({ credentials });
}

export function registerApprovalRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcRegistrar;
  actionExecutor?: RpcActionExecutor;
}>): void {
  registerActionSpecRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    actionExecutor: params.actionExecutor,
    resolveActionExecutor: resolveProductionActionExecutor,
    scopes: APPROVAL_RPC_SCOPES,
  });
}
