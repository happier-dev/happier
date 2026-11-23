import { readDaemonMachineIds } from '../../uiE2e/daemonMachineId';

import { createLegacyRpcClient, type RpcSocket } from '../../syntheticAgent/rpcClient';
import { sleep } from '../../timing';
import { withTimeoutMs } from '../../timing/withTimeout';

export async function waitForDaemonMachineIds(params: {
  settingsPath: string;
  timeoutMs: number;
}): Promise<string[]> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const ids = await readDaemonMachineIds(params.settingsPath).catch(() => []);
    if (ids.length > 0) return ids;
    await sleep(100);
  }
  return [];
}

export async function invokeRpcAcrossMachineIds(params: {
  ui: RpcSocket;
  machineIds: string[];
  method: string;
  payload: unknown;
  secret: Uint8Array;
  timeoutMs: number;
}): Promise<unknown> {
  const rpc = createLegacyRpcClient(params.ui, params.secret);
  const deadline = Date.now() + params.timeoutMs;
  let lastMethodUnavailable: unknown = null;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const rpcAckTimeoutMs = Math.max(1, Math.min(remainingMs, 300_000));

    for (const machineId of params.machineIds) {
      const rpcMethod = `${machineId}:${params.method}`;
      try {
        const candidate = await withTimeoutMs({
          promise: rpc.call(rpcMethod, params.payload, rpcAckTimeoutMs),
          timeoutMs: rpcAckTimeoutMs,
          label: `rpcCall ${rpcMethod}`,
        });
        if (candidate && typeof candidate === 'object' && candidate.ok === true) {
          return candidate.result;
        }

        const errorCode = candidate.ok === false ? candidate.errorCode : undefined;
        if (errorCode === 'RPC_METHOD_NOT_AVAILABLE') {
          lastMethodUnavailable = { machineId, candidate };
          continue;
        }

        throw new Error(
          `rpc ${params.method} failed: ${JSON.stringify(
            candidate && typeof candidate === 'object' ? candidate : { candidate },
            null,
            2,
          )}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const normalized = message.toLowerCase();
        if (normalized.includes('timed out') || normalized.includes('timeout')) {
          lastMethodUnavailable = { machineId, error: message };
          continue;
        }
        if (message.includes('RPC_METHOD_NOT_AVAILABLE')) {
          lastMethodUnavailable = { machineId, error: message };
          continue;
        }
        throw error;
      }
    }

    const pauseMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (pauseMs > 0) await sleep(pauseMs);
  }

  throw new Error(
    `rpc ${params.method} unavailable after wait (${JSON.stringify(
      lastMethodUnavailable ?? { errorCode: 'RPC_METHOD_NOT_AVAILABLE' },
      null,
      2,
    )})`,
  );
}
