import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

// Owner ruling 2026-10-30: a 0.3 computer does not execute moves driven by
// cli-v0.2.11 or the moving predecessor V2 peer. Refuse before any import,
// job mutation or native process effect; current V3 keeps its existing owner.
export const UNSUPPORTED_SESSION_HANDOFF_RPC_METHODS: ReadonlySet<string> = new Set([
  RPC_METHODS.DAEMON_SESSION_HANDOFF_START,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V2,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2,
]);

export function registerUnsupportedSessionHandoffRpcHandlers(manager: RpcHandlerRegistrar): void {
  for (const method of UNSUPPORTED_SESSION_HANDOFF_RPC_METHODS) {
    manager.registerHandler(method, async () => ({
      ok: false,
      errorCode: 'handoff_update_required',
      error: 'Update both computers to move this Session',
    } as const));
  }
}
