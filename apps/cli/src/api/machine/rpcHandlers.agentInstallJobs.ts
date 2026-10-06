import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonAgentInstallStartRequestSchema, DaemonAgentInstallReadRequestSchema, DaemonAgentInstallCancelRequestSchema, DaemonAgentInstallListRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { getDaemonAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import type { RpcHandlerRegistrar } from '../rpc/types';

export function registerMachineAgentInstallJobRpcHandlers(params: { rpcHandlerManager: RpcHandlerRegistrar }): void {
  const invalid = { ok: false as const, errorCode: 'invalid_request' as const, error: 'Invalid agent install job request' };
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_AGENTS_INSTALL_START, async (raw: unknown) => {
    const parsed = DaemonAgentInstallStartRequestSchema.safeParse(raw);
    return parsed.success ? await getDaemonAgentInstallJobOwner().start(parsed.data) : invalid;
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, async (raw: unknown) => {
    const parsed = DaemonAgentInstallReadRequestSchema.safeParse(raw);
    return parsed.success ? await getDaemonAgentInstallJobOwner().read(parsed.data) : invalid;
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL, async (raw: unknown) => {
    const parsed = DaemonAgentInstallCancelRequestSchema.safeParse(raw);
    return parsed.success ? await getDaemonAgentInstallJobOwner().cancel(parsed.data) : invalid;
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST, async (raw: unknown) => {
    const parsed = DaemonAgentInstallListRequestSchema.safeParse(raw);
    return parsed.success ? await getDaemonAgentInstallJobOwner().list() : invalid;
  });
}
