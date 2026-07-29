import type { ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { DataKeyRpcResult } from '../syntheticAgent/rpcClient';
import { unwrapDataKeyRpcResult } from '../syntheticAgent/rpcClient';
import { waitFor } from '../timing';

type DataKeyRpcClientLike = Readonly<{
  call: (method: string, payload: unknown, timeoutMs?: number) => Promise<DataKeyRpcResult>;
}>;

function isRunnerActiveStatus(value: unknown): value is Readonly<{ ok: true; runnerActive: true }> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (value as { ok?: unknown }).ok === true
    && (value as { runnerActive?: unknown }).runnerActive === true;
}

export async function activateLinkedDirectSession(params: Readonly<{
  machineRpc: DataKeyRpcClientLike;
  machineId: string;
  sessionId: string;
  providerId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  timeoutMs?: number;
  intervalMs?: number;
  context?: string;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const intervalMs = params.intervalMs ?? 100;
  const context = params.context ?? `activate linked direct session ${params.sessionId}`;

  unwrapDataKeyRpcResult(
    await params.machineRpc.call(`${params.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER}`, {
      machineId: params.machineId,
      linkedSessionId: params.sessionId,
      targetRuntimeMode: 'terminal',
      storageMode: 'external-linked',
    }, timeoutMs),
    `${context} takeover`,
  );

  await waitFor(async () => {
    const status = unwrapDataKeyRpcResult(
      await params.machineRpc.call(`${params.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET}`, {
        machineId: params.machineId,
        sessionId: params.sessionId,
        providerId: params.providerId,
        remoteSessionId: params.remoteSessionId,
        source: params.source,
      }, timeoutMs),
      `${context} status`,
    );
    return isRunnerActiveStatus(status);
  }, {
    timeoutMs,
    intervalMs,
    context: `${context} runner becomes active`,
  });
}
