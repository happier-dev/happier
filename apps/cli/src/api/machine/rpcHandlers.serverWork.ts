import { DaemonServerWorkStatusV1Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { DaemonServerWorkScheduler } from '@/daemon/serverWork';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

export function registerMachineServerWorkRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  daemonServerWorkScheduler: Pick<DaemonServerWorkScheduler, 'getSnapshot'>;
}>): void {
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SERVER_WORK_STATUS, async () =>
    DaemonServerWorkStatusV1Schema.parse({
      v: 1,
      ...params.daemonServerWorkScheduler.getSnapshot(),
    }));
}
