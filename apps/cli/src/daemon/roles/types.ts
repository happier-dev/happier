import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

/** Registers one role's RPC families as that role's owned handler set (replaced as a whole). */
/** Why a role stops: turned off in the Machine's role set, or the daemon/connection is ending. */
export type MachineRoleStopReason = 'inactive' | 'shutdown';

export type MachineRoleRpcRegistrar = <T>(register: (rpcHandlerManager: RpcHandlerManager) => T) => T;
