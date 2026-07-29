import { createUserScopedSocket } from '@/api/session/sockets';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { SessionEncryptionContext, SessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';
import { waitForSocketConnect } from '@/session/transport/socket/waitForSocketConnect';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';

export async function callSessionRpc(params: Readonly<{
  token: string;
  sessionId: string;
  mode?: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  method: string;
  request: unknown;
  timeoutMs?: number;
}>): Promise<unknown> {
  const socket = createUserScopedSocket({ token: params.token });
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 20_000;
  const connectTimeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? timeoutMs : resolveSessionControlSocketConnectTimeoutMs();

  try {
    const connectPromise = waitForSocketConnect(socket as unknown as import('socket.io-client').Socket, connectTimeoutMs);
    socket.connect();
    await connectPromise;

    const mode: SessionStoredContentEncryptionMode = params.mode ?? 'e2ee';
    const rpcParams = mode === 'plain'
      ? params.request
      : encodeBase64(encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.request), 'base64');

    const response = await new Promise<{ ok: boolean; result?: unknown; error?: string; errorCode?: string }>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new Error('RPC call timeout')));
      }, timeoutMs);
      try {
        socket.emit(
          SOCKET_RPC_EVENTS.CALL,
          { method: params.method, params: rpcParams, timeoutMs },
          (payload: { ok: boolean; result?: unknown; error?: string; errorCode?: string }) => {
            settle(() => resolve(payload));
          },
        );
      } catch (error) {
        settle(() => reject(error));
      }
    });

    if (!response.ok) {
      throw createRpcCallError({
        error: response.error || 'RPC call failed',
        errorCode: response.errorCode,
      });
    }

    if (mode === 'plain') {
      return response.result ?? null;
    }

    const encryptedResult = typeof response.result === 'string' ? response.result.trim() : '';
    if (!encryptedResult) return null;
    return decrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, decodeBase64(encryptedResult, 'base64'));
  } finally {
    try {
      socket.disconnect();
      socket.close();
    } catch {
      // ignore
    }
  }
}
