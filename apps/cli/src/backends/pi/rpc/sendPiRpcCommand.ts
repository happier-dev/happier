import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { PiRpcCommandResponseTimeoutError, type PendingRpcRequest } from './rpcSupport';
import type { PiRpcCommand, PiRpcCommandWithoutId, PiRpcResponse } from './types';

export async function sendPiRpcCommand(params: Readonly<{
  ensureProcess: () => Promise<void>;
  getProcess: () => ChildProcessWithoutNullStreams | null;
  pendingRequests: Map<string, PendingRpcRequest>;
  openPromptRequestIds: Set<string>;
  command: PiRpcCommandWithoutId;
  timeoutMs?: number;
}>): Promise<PiRpcResponse> {
  await params.ensureProcess();
  const child = params.getProcess();
  if (!child?.stdin) {
    throw new Error('Pi process stdin is unavailable');
  }

  const id = randomUUID();
  const payload: PiRpcCommand = { ...params.command, id } as PiRpcCommand;
  const encoded = JSON.stringify(payload);

  return await new Promise<PiRpcResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      params.pendingRequests.delete(id);
      if (params.command.type === 'prompt') {
        params.openPromptRequestIds.add(id);
      } else {
        params.openPromptRequestIds.delete(id);
      }
      reject(new PiRpcCommandResponseTimeoutError(params.command.type));
    }, params.timeoutMs ?? 30_000);
    timeout.unref?.();

    params.pendingRequests.set(id, { resolve, reject, timeout, commandType: params.command.type });
    child.stdin.write(`${encoded}\n`, (error) => {
      if (!error) return;
      clearTimeout(timeout);
      params.pendingRequests.delete(id);
      params.openPromptRequestIds.delete(id);
      reject(new Error(`Failed to write Pi RPC command (${params.command.type}): ${error.message}`));
    });
  });
}
