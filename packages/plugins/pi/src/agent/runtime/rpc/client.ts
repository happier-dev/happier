import { randomUUID } from 'node:crypto';

import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/runtime';

import type { PiRpcCommand, PiRpcCommandWithoutId, PiRpcResponse } from './types.js';

type PiJsonStreamRpcClientParams = Readonly<{
  handle: PluginProtocolClientHandle<'jsonStream'>;
  onEvent?: (record: Readonly<Record<string, unknown>>) => void;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readResponse(record: Readonly<Record<string, unknown>>): PiRpcResponse | null {
  return record.type === 'response' ? record as PiRpcResponse : null;
}

export type PiJsonStreamRpcClient = Readonly<{
  send(command: PiRpcCommandWithoutId, timeoutMs?: number): Promise<PiRpcResponse>;
  onExit(listener: (result: Readonly<{ exitCode: number | null; signal: string | null }>) => void): () => void;
  dispose(): Promise<void>;
}>;

export class PiRpcNegativeAcknowledgementError extends Error {
  readonly kind = 'negative_acknowledgement';

  constructor(message: string) {
    super(message);
    this.name = 'PiRpcNegativeAcknowledgementError';
  }
}

export function createPiJsonStreamRpcClient(params: PiJsonStreamRpcClientParams): PiJsonStreamRpcClient {
  const pending = new Map<string, Readonly<{
    resolve(response: PiRpcResponse): void;
    reject(error: Error): void;
  }>>();
  const removePending = (id: string) => {
    const entry = pending.get(id);
    if (entry) pending.delete(id);
    return entry;
  };
  const subscription = params.handle.client.subscribe((record) => {
    if (!isRecord(record)) return;
    const response = readResponse(record);
    if (!response) {
      params.onEvent?.(record);
      return;
    }
    const id = typeof response.id === 'string' ? response.id : null;
    if (!id) return;
    if (response.success) {
      removePending(id)?.resolve(response);
    } else {
      removePending(id)?.reject(new PiRpcNegativeAcknowledgementError(response.error ?? 'Pi RPC command failed'));
    }
  });

  return {
    async send(command, timeoutMs = 30_000) {
      const id = randomUUID();
      const payload: PiRpcCommand = { ...command, id } as PiRpcCommand;
      const response = new Promise<PiRpcResponse>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const clearPendingTimeout = () => {
          if (timeout) clearTimeout(timeout);
          timeout = undefined;
        };
        if (pending.has(id)) {
          reject(new Error(`Pi RPC request id is already pending: ${id}`));
          return;
        }
        pending.set(id, {
          resolve: (value) => {
            clearPendingTimeout();
            resolve(value);
          },
          reject: (error) => {
            clearPendingTimeout();
            reject(error);
          },
        });
        const dispose = () => pending.delete(id);
        timeout = setTimeout(() => {
          if (dispose()) reject(new Error(`Pi ${command.type} command timed out`));
        }, timeoutMs);
        timeout.unref?.();
      });
      try {
        await params.handle.client.write(payload);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        removePending(id)?.reject(failure);
        return await response;
      }
      return await response;
    },
    onExit(listener) {
      let active = true;
      void params.handle.wait().then((result) => {
        if (!active) return;
        const observed = result.termination.observed;
        listener({
          exitCode: observed.kind === 'exit' ? observed.exitCode : null,
          signal: observed.kind === 'signal' ? observed.signal : null,
        });
      });
      return () => { active = false; };
    },
    async dispose() {
      subscription.dispose();
      const error = new Error('Pi RPC client disposed');
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) entry.reject(error);
      await params.handle.dispose();
    },
  };
}
