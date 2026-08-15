import { createUserScopedSocket } from '@/api/session/sockets';
import { resolveMachineEncryptionContext } from '@/api/client/encryptionKey';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { Credentials } from '@/persistence';
import { waitForSocketConnect } from '@/session/transport/socket/waitForSocketConnect';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';

/**
 * Calls exactly one account-scoped machine RPC. The caller owns retry policy;
 * this boundary deliberately has no machine substitution or timeout redrive.
 */
export async function callMachineRpc(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  method: string;
  request: unknown;
  authorization?: SocketRpcAuthorizationContext;
  timeoutMs?: number;
}>): Promise<unknown> {
  const machineId = params.machineId.trim();
  if (!machineId) throw new Error('Machine id is required');

  const socket = createUserScopedSocket({ token: params.credentials.token });
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 20_000;
  const connectTimeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
    ? timeoutMs
    : resolveSessionControlSocketConnectTimeoutMs();
  const machineEncryption = resolveMachineEncryptionContext(params.credentials);
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { socket.disconnect(); } catch { /* preserve the original outcome */ }
    try { socket.close(); } catch { /* preserve the original outcome */ }
  };

  try {
    const connectPromise = waitForSocketConnect(socket as unknown as import('socket.io-client').Socket, connectTimeoutMs);
    socket.connect();
    await connectPromise;

    const encryptedRequest = encodeBase64(encrypt(
      machineEncryption.encryptionKey,
      machineEncryption.encryptionVariant,
      params.request,
    ));
    const response = await new Promise<{ ok: boolean; result?: unknown; error?: string; errorCode?: string }>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      timer = setTimeout(() => finish(() => reject(Object.assign(new Error('Machine RPC call timeout'), {
        code: 'MACHINE_RPC_TIMEOUT',
      }))), timeoutMs);
      try {
        socket.emit(
          SOCKET_RPC_EVENTS.CALL,
          {
            method: `${machineId}:${params.method}`,
            params: encryptedRequest,
            ...(params.authorization ? { authorization: params.authorization } : {}),
          },
          (payload: { ok: boolean; result?: unknown; error?: string; errorCode?: string }) => finish(() => resolve(payload)),
        );
      } catch (error) {
        finish(() => reject(error));
      }
    });

    if (!response.ok) {
      throw createRpcCallError({
        error: response.error || 'Machine RPC call failed',
        errorCode: response.errorCode,
      });
    }
    const encryptedResult = typeof response.result === 'string' ? response.result.trim() : '';
    if (!encryptedResult) return null;
    return decrypt(
      machineEncryption.encryptionKey,
      machineEncryption.encryptionVariant,
      decodeBase64(encryptedResult, 'base64'),
    );
  } finally {
    cleanup();
  }
}
