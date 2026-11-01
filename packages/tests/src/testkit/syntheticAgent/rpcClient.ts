import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';

import type { SocketCollector } from '../socketClient';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../rpcCrypto';
import { unwrapSerializedJsonValue } from '../unwrapSerializedJsonValue';

export type RpcResult =
  | { ok: true; result: unknown | null }
  | { ok: false; error?: string; errorCode?: string };

export type DataKeyRpcResult = RpcResult;

export function unwrapRpcResult(result: RpcResult, context = 'rpc'): unknown | null {
  if (result.ok !== true) {
    const reason = result.errorCode ?? result.error ?? 'unknown-error';
    throw new Error(`${context} failed: ${reason}`);
  }
  return result.result;
}

export function unwrapDataKeyRpcResult(result: DataKeyRpcResult, context = 'data key rpc'): unknown | null {
  return unwrapRpcResult(result, context);
}

type RpcSocket = Pick<SocketCollector, 'rpcCall'>;

type RpcEncryption = Readonly<{ type: 'plain' }> | Readonly<{ type: 'dataKey'; dataKey: Uint8Array }>;

type RpcResponseEnvelope = {
  ok?: unknown;
  result?: unknown;
  error?: unknown;
  errorCode?: unknown;
};

export function createRpcClient(socket: RpcSocket, encryption: RpcEncryption): {
  /**
   * `authorization` is required by the server for a session-write method
   * (`resolveSocketRpcSessionWriteAuthorizationMethod`); without it the call is
   * refused with `RPC_FORBIDDEN` before it reaches the machine.
   */
  call: (
    method: string,
    payload: unknown,
    timeoutMs?: number,
    authorization?: SocketRpcAuthorizationContext,
  ) => Promise<RpcResult>;
} {
  return {
    call: async (
      method: string,
      payload: unknown,
      timeoutMs?: number,
      authorization?: SocketRpcAuthorizationContext,
    ) => {
      const params = encryption.type === 'plain' ? payload : encryptDataKeyBase64(payload, encryption.dataKey);
      const res = await socket.rpcCall<RpcResponseEnvelope>(method, params, timeoutMs, authorization);
      if (!res || typeof res !== 'object') {
        return { ok: false, error: 'invalid-rpc-response' };
      }
      if (res.ok === true) {
        if (encryption.type === 'plain') return { ok: true, result: res.result };
        if (typeof res.result !== 'string') {
          return { ok: false, error: 'invalid-rpc-result', errorCode: undefined };
        }
        const encrypted = res.result;
        const decrypted = decryptDataKeyBase64(encrypted, encryption.dataKey);
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

export function createDataKeyRpcClient(socket: RpcSocket, dataKey: Uint8Array): ReturnType<typeof createRpcClient> {
  return createRpcClient(socket, { type: 'dataKey', dataKey });
}
