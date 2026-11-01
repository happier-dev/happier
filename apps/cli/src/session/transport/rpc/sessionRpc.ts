import { createSessionScopedSocket } from '@/api/session/sockets';
import { randomUUID } from 'node:crypto';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { encryptSessionPayload, decryptSessionPayload, type SessionEncryptionContext, type SessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';
import { waitForSocketConnect } from '@/session/transport/socket/waitForSocketConnect';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import {
  createSocketRpcDisconnectGuard,
  SocketRpcDisconnectBeforeAcknowledgementError,
} from './socketRpcDisconnectGuard';
import { createRpcAcknowledgementError, markRpcRequestDisposition, readRpcRequestDisposition } from './rpcRequestDisposition';

export async function callSessionRpc(params: Readonly<{
  token: string;
  sessionId: string;
  mode?: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  method: string;
  request: unknown;
  timeoutMs?: number | null;
}>): Promise<unknown> {
  const socket = createSessionScopedSocket({ token: params.token, sessionId: params.sessionId });
  const timeoutMs = params.timeoutMs === null
    ? null
    : typeof params.timeoutMs === 'number' && params.timeoutMs > 0
      ? params.timeoutMs
      : 20_000;
  const connectTimeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
    ? params.timeoutMs
    : resolveSessionControlSocketConnectTimeoutMs();
  const disconnectGuard = createSocketRpcDisconnectGuard({
    socket: socket as unknown as import('socket.io-client').Socket,
    createError: () => new SocketRpcDisconnectBeforeAcknowledgementError(),
  });
  let cleanedUp = false;
  let requestEmitted = false;
  let responseTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanupSocket = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      socket.disconnect();
    } catch {
      // ignore cleanup failures; preserve the original RPC/connect outcome
    }
    try {
      socket.close();
    } catch {
      // ignore cleanup failures; preserve the original RPC/connect outcome
    }
  };

  try {
    const connectPromise = waitForSocketConnect(socket as unknown as import('socket.io-client').Socket, connectTimeoutMs);
    const connectedOrDisconnected = Promise.race([connectPromise, disconnectGuard.disconnected]);
    socket.connect();
    await connectedOrDisconnected;
    disconnectGuard.throwIfDisconnected();

    const mode: SessionStoredContentEncryptionMode = params.mode ?? 'e2ee';
    const rpcParams = mode === 'plain'
      ? params.request
      : encryptSessionPayload({ ctx: params.ctx, payload: params.request });

    const responsePromise = new Promise<{ ok: boolean; result?: unknown; error?: string; errorCode?: string }>((resolve, reject) => {
      if (timeoutMs !== null) {
        responseTimer = setTimeout(() => reject(new Error('RPC call timeout')), timeoutMs);
      }
      try {
        requestEmitted = true;
        socket.emit(
          SOCKET_RPC_EVENTS.CALL,
          {
            method: params.method,
            params: rpcParams,
            requestId: randomUUID(),
            ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
          },
          (payload: { ok: boolean; result?: unknown; error?: string; errorCode?: string }) => {
            resolve(payload);
          },
        );
      } catch (error) {
        reject(error);
      }
    });
    const response = await Promise.race([responsePromise, disconnectGuard.disconnected]);

    if (!response.ok) {
      throw createRpcAcknowledgementError({
        error: response.error || 'RPC call failed',
        errorCode: response.errorCode,
      });
    }

    if (mode === 'plain') {
      return response.result ?? null;
    }

    const encryptedResult = typeof response.result === 'string' ? response.result.trim() : '';
    if (!encryptedResult) return null;
    return decryptSessionPayload({ ctx: params.ctx, ciphertextBase64: encryptedResult });
  } catch (error) {
    throw readRpcRequestDisposition(error) === null
      ? markRpcRequestDisposition(error, requestEmitted ? 'outcomeUnknown' : 'notSent')
      : error;
  } finally {
    if (responseTimer) clearTimeout(responseTimer);
    disconnectGuard.dispose();
    cleanupSocket();
  }
}
