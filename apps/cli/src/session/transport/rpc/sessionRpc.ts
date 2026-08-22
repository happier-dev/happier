import { createUserScopedSocket } from '@/api/session/sockets';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { SessionEncryptionContext, SessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';
import { waitForSocketConnect } from '@/session/transport/socket/waitForSocketConnect';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import {
  markRpcRequestDisposition,
  readRpcRequestDisposition,
  type RpcRequestDisposition,
} from './rpcRequestDisposition';

export type SessionRpcRequestDisposition = RpcRequestDisposition;
export const readSessionRpcRequestDisposition = readRpcRequestDisposition;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

async function waitForConnectWithSignal(
  connectPromise: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await connectPromise;
    return;
  }
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([connectPromise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

type CallSessionRpcParams = Readonly<{
  token: string;
  sessionId: string;
  method: string;
  request: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}> & (
  | Readonly<{ mode: 'plain'; ctx?: null }>
  | Readonly<{ mode?: 'e2ee'; ctx: SessionEncryptionContext }>
);

export async function callSessionRpc(params: CallSessionRpcParams): Promise<unknown> {
  let socket: ReturnType<typeof createUserScopedSocket> | null = null;
  let requestEmitted = false;
  try {
    params.signal?.throwIfAborted();
    const activeSocket = createUserScopedSocket({ token: params.token });
    socket = activeSocket;
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 20_000;
    const connectTimeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? timeoutMs : resolveSessionControlSocketConnectTimeoutMs();
    const connectPromise = waitForSocketConnect(activeSocket as unknown as import('socket.io-client').Socket, connectTimeoutMs);
    activeSocket.connect();
    await waitForConnectWithSignal(connectPromise, params.signal);
    params.signal?.throwIfAborted();

    const rpcParams = params.mode === 'plain'
      ? params.request
      : encodeBase64(encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.request), 'base64');

    const response = await new Promise<{ ok: boolean; result?: unknown; error?: string; errorCode?: string }>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        params.signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => settle(() => reject(abortReason(params.signal!)));
      params.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        settle(() => reject(new Error('RPC call timeout')));
      }, timeoutMs);
      try {
        requestEmitted = true;
        activeSocket.emit(
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

    if (params.mode === 'plain') {
      return response.result ?? null;
    }

    const encryptedResult = typeof response.result === 'string' ? response.result.trim() : '';
    if (!encryptedResult) return null;
    return decrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, decodeBase64(encryptedResult, 'base64'));
  } catch (error) {
    throw markRpcRequestDisposition(error, requestEmitted ? 'outcomeUnknown' : 'notSent');
  } finally {
    if (socket) {
      try {
        socket.disconnect();
        socket.close();
      } catch {
        // Preserve the original result.
      }
    }
  }
}
