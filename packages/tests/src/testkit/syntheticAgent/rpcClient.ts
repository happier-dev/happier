import type { SocketCollector } from '../socketClient';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../rpcCrypto';

export type DataKeyRpcResult =
  | { ok: true; result: unknown | null }
  | { ok: false; error?: string; errorCode?: string };

type RpcResponseEnvelope = {
  ok?: unknown;
  result?: unknown;
  error?: unknown;
  errorCode?: unknown;
};

export function createDataKeyRpcClient(socket: SocketCollector, dataKey: Uint8Array): {
  call: (method: string, payload: unknown) => Promise<DataKeyRpcResult>;
} {
  return {
    call: async (method: string, payload: unknown) => {
      const params = encryptDataKeyBase64(payload, dataKey);
      const res = await socket.rpcCall<RpcResponseEnvelope>(method, params);
      if (!res || typeof res !== 'object') {
        return { ok: false, error: 'invalid-rpc-response' };
      }
      if (res.ok === true) {
        if (typeof res.result !== 'string') {
          return { ok: false, error: 'invalid-rpc-result', errorCode: undefined };
        }
        const encrypted = res.result;
        return { ok: true, result: decryptDataKeyBase64(encrypted, dataKey) };
      }
      return {
        ok: false,
        error: typeof res.error === 'string' ? res.error : 'rpc-failed',
        errorCode: typeof res.errorCode === 'string' ? res.errorCode : undefined,
      };
    },
  };
}
