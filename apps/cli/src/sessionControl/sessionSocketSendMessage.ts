import type { Socket } from 'socket.io-client';

import { MessageAckResponseSchema } from '@happier-dev/protocol/updates';

import { createSessionScopedSocket } from '@/api/session/sockets';
import type { SessionStoredMessageContent } from '@happier-dev/protocol';
import { resolveSessionControlSocketAckTimeoutMs, resolveSessionControlSocketConnectTimeoutMs } from './sessionControlTimeouts';
import { waitForSocketConnect } from './waitForSocketConnect';

export async function sendSessionMessageViaSocketCommitted(params: Readonly<{
  token: string;
  sessionId: string;
  content: SessionStoredMessageContent;
  localId: string;
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
  sentFrom?: string;
  permissionMode?: string;
}>): Promise<void> {
  const connectTimeoutMs =
    typeof params.connectTimeoutMs === 'number' && Number.isFinite(params.connectTimeoutMs) && params.connectTimeoutMs > 0
      ? Math.min(60_000, Math.trunc(params.connectTimeoutMs))
      : resolveSessionControlSocketConnectTimeoutMs();
  const ackTimeoutMs =
    typeof params.ackTimeoutMs === 'number' && Number.isFinite(params.ackTimeoutMs) && params.ackTimeoutMs > 0
      ? Math.min(60_000, Math.trunc(params.ackTimeoutMs))
      : resolveSessionControlSocketAckTimeoutMs();

  const socket = createSessionScopedSocket({ token: params.token, sessionId: params.sessionId }) as unknown as Socket;
  const connectPromise = waitForSocketConnect(socket, connectTimeoutMs);
  socket.connect();
  await connectPromise;

  try {
    const rawAck = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket message ACK timeout')), ackTimeoutMs);
      (socket as any).emit(
        'message',
        {
          sid: params.sessionId,
          message: params.content,
          localId: params.localId,
          ...(params.sentFrom ? { sentFrom: params.sentFrom } : {}),
          ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
        },
        (answer: unknown) => {
          clearTimeout(timer);
          resolve(answer);
        },
      );
    });

    const parsed = MessageAckResponseSchema.safeParse(rawAck);
    if (!parsed.success) {
      const err = new Error('Invalid message ACK payload');
      (err as any).code = 'unknown_error';
      throw err;
    }
    if (parsed.data.ok !== true) {
      const err = new Error(parsed.data.error ?? 'Send failed');
      (err as any).code = 'unknown_error';
      throw err;
    }
  } finally {
    try {
      socket.disconnect();
      socket.close();
    } catch {
      // ignore
    }
  }
}
