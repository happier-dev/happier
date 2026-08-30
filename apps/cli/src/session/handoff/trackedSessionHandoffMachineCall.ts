import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const SESSION_HANDOFF_TARGET_RESUME_RPC_TIMEOUT_MS = 5 * 60_000;

export function buildTrackedSessionHandoffMachineCall<T extends Readonly<{ method: string }>>(
  input: T,
): T & Readonly<{ timeoutMs?: number }> {
  return input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2
    ? { ...input, timeoutMs: SESSION_HANDOFF_TARGET_RESUME_RPC_TIMEOUT_MS }
    : input;
}
