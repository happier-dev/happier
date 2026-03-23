import type { SocketCollector } from '../socketClient';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../rpcCrypto';
import { unwrapSerializedJsonValue } from '../unwrapSerializedJsonValue';

export type DataKeyRpcResult =
  | { ok: true; result: unknown | null }
  | { ok: false; error?: string; errorCode?: string };

export function unwrapDataKeyRpcResult(result: DataKeyRpcResult, context = 'data key rpc'): unknown | null {
  if (result.ok !== true) {
    const reason = result.errorCode ?? result.error ?? 'unknown-error';
    throw new Error(`${context} failed: ${reason}`);
  }
  return result.result;
}

type RpcSocket = {
  rpcCall: <T = unknown>(method: string, params: string, timeoutMs?: number) => Promise<T>;
};

type RpcResponseEnvelope = {
  ok?: unknown;
  result?: unknown;
  error?: unknown;
  errorCode?: unknown;
};

export function createDataKeyRpcClient(socket: RpcSocket, dataKey: Uint8Array): {
  call: (method: string, payload: unknown, timeoutMs?: number) => Promise<DataKeyRpcResult>;
} {
  return {
    call: async (method: string, payload: unknown, timeoutMs?: number) => {
      const params = encryptDataKeyBase64(payload, dataKey);
      const res = await socket.rpcCall<RpcResponseEnvelope>(method, params, timeoutMs);
      if (!res || typeof res !== 'object') {
        return { ok: false, error: 'invalid-rpc-response' };
      }
      if (res.ok === true) {
        if (typeof res.result !== 'string') {
          return { ok: false, error: 'invalid-rpc-result', errorCode: undefined };
        }
        const encrypted = res.result;
        const decrypted = decryptDataKeyBase64(encrypted, dataKey);
        const result = unwrapSerializedJsonValue(decrypted);
        return { ok: true, result };
      }
      return {
        ok: false,
        error: typeof res.error === 'string' ? res.error : 'rpc-failed',
        errorCode: typeof res.errorCode === 'string' ? res.errorCode : undefined,
      };
    },
  };
}
