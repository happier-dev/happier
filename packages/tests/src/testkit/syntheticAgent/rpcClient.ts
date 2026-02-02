import type { SocketCollector } from '../socketClient';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../rpcCrypto';

export type DataKeyRpcResult =
  | { ok: true; result: any | null }
  | { ok: false; error?: string; errorCode?: string };

export function createDataKeyRpcClient(socket: SocketCollector, dataKey: Uint8Array): {
  call: (method: string, payload: any) => Promise<DataKeyRpcResult>;
} {
  return {
    call: async (method: string, payload: any) => {
      const params = encryptDataKeyBase64(payload, dataKey);
      const res = await socket.rpcCall<any>(method, params);
      if (!res || typeof res !== 'object') {
        return { ok: false, error: 'invalid-rpc-response' };
      }
      if (res.ok === true) {
        const encrypted = typeof res.result === 'string' ? res.result : '';
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

