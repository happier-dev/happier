import { randomUUID } from 'node:crypto';

import {
  createJsonlRequestCorrelator,
  type ExecClientHandleV1,
  type JsonStreamClientV1,
} from '@happier-dev/plugin-sdk';

import type { PiRpcCommand, PiRpcCommandWithoutId, PiRpcResponse } from './types.js';

type PiJsonStreamRpcClientParams = Readonly<{
  handle: ExecClientHandleV1<JsonStreamClientV1>;
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
  dispose(): Promise<void>;
}>;

export function createPiJsonStreamRpcClient(params: PiJsonStreamRpcClientParams): PiJsonStreamRpcClient {
  const correlator = createJsonlRequestCorrelator<string, PiRpcResponse>();
  const unsubscribe = params.handle.client.subscribe((record) => {
    if (!isRecord(record)) return;
    const response = readResponse(record);
    if (!response) {
      params.onEvent?.(record);
      return;
    }
    const id = typeof response.id === 'string' ? response.id : null;
    if (!id) return;
    if (response.success) {
      correlator.resolve(id, response);
    } else {
      correlator.reject(id, new Error(response.error ?? 'Pi RPC command failed'));
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
        const dispose = correlator.add(id, {
          resolve: (value) => {
            clearPendingTimeout();
            resolve(value);
          },
          reject: (error) => {
            clearPendingTimeout();
            reject(error);
          },
        });
        timeout = setTimeout(() => {
          if (dispose()) reject(new Error(`Pi ${command.type} command timed out`));
        }, timeoutMs);
        timeout.unref?.();
      });
      try {
        await params.handle.client.writeRecord(payload);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        correlator.reject(id, failure);
        return await response;
      }
      return await response;
    },
    async dispose() {
      unsubscribe();
      const error = new Error('Pi RPC client disposed');
      correlator.close(error);
      await params.handle.dispose({ code: 'PI_RPC_CLIENT_DISPOSED', message: error.message });
    },
  };
}
