import { createSessionScopedSocket } from '@/api/session/sockets';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { SessionEncryptionContext } from './sessionEncryptionContext';
import { resolveSessionControlSocketConnectTimeoutMs } from './sessionControlTimeouts';
import { waitForSocketConnect } from './waitForSocketConnect';

export async function callSessionRpc(params: Readonly<{
  token: string;
  sessionId: string;
  ctx: SessionEncryptionContext;
  method: string;
  request: unknown;
  timeoutMs?: number;
}>): Promise<unknown> {
  const socket = createSessionScopedSocket({ token: params.token, sessionId: params.sessionId });
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 20_000;
  const connectTimeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? timeoutMs : resolveSessionControlSocketConnectTimeoutMs();

  const connectPromise = waitForSocketConnect(socket as unknown as import('socket.io-client').Socket, connectTimeoutMs);
  socket.connect();
  await connectPromise;

  const encryptedParams = encodeBase64(encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.request), 'base64');
  const response = await new Promise<{ ok: boolean; result?: string; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RPC call timeout')), timeoutMs);
    socket.emit(
      SOCKET_RPC_EVENTS.CALL,
      { method: params.method, params: encryptedParams },
      (payload: { ok: boolean; result?: string; error?: string }) => {
        clearTimeout(timer);
        resolve(payload);
      },
    );
  });

  try {
    socket.disconnect();
    socket.close();
  } catch {
    // ignore
  }

  if (!response.ok) {
    throw new Error(response.error || 'RPC call failed');
  }

  const encryptedResult = String(response.result ?? '').trim();
  if (!encryptedResult) return null;
  return decrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, decodeBase64(encryptedResult, 'base64'));
}
