import type { Socket } from 'socket.io-client';

import { createSessionScopedSocket } from '@/api/session/sockets';
import type { Credentials } from '@/persistence';
import {
  decryptStoredSessionPayload,
  encryptStoredSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from './sessionEncryptionContext';
import { resolveSessionControlSocketConnectTimeoutMs } from './sessionControlTimeouts';
import { waitForSocketConnect } from './waitForSocketConnect';

type UpdateMetadataAck =
  | { result: 'success'; version: number; metadata: string }
  | { result: 'version-mismatch'; version: number; metadata: string }
  | { result: 'forbidden' }
  | { result: 'error' };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function emitUpdateMetadataWithAck(socket: Socket, payload: { sid: string; expectedVersion: number; metadata: string }): Promise<UpdateMetadataAck> {
  const res = await new Promise<UpdateMetadataAck>((resolve) => {
    (socket as any).emit('update-metadata', payload, (answer: any) => resolve(answer as UpdateMetadataAck));
  });
  return res;
}

export async function updateSessionMetadataWithRetry(params: Readonly<{
  token: string;
  credentials: Credentials;
  sessionId: string;
  rawSession: Readonly<{ metadata: string; metadataVersion: number; encryptionMode?: unknown; dataEncryptionKey?: unknown }>;
  updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
  maxAttempts?: number;
}>): Promise<{ version: number; metadata: Record<string, unknown> }> {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession);

  let expectedVersion = params.rawSession.metadataVersion;
  let currentWireValue = String((params.rawSession as any).metadata ?? '').trim();

  const initialDecrypted = asRecord(decryptStoredSessionPayload({ mode, ctx, value: currentWireValue }));
  if (!initialDecrypted) {
    const err = new Error('Unsupported session metadata payload');
    (err as any).code = 'unsupported';
    throw err;
  }
  let currentDecrypted: Record<string, unknown> = initialDecrypted;

  const socket = createSessionScopedSocket({ token: params.token, sessionId: params.sessionId }) as unknown as Socket;
  const connectPromise = waitForSocketConnect(socket, resolveSessionControlSocketConnectTimeoutMs());
  socket.connect();
  await connectPromise;

  const maxAttempts = typeof params.maxAttempts === 'number' && Number.isFinite(params.maxAttempts) && params.maxAttempts > 0 ? Math.min(10, params.maxAttempts) : 6;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const updated = params.updater(currentDecrypted);
      const updatedWireValue = encryptStoredSessionPayload({ mode, ctx, payload: updated });

      const ack = await emitUpdateMetadataWithAck(socket, {
        sid: params.sessionId,
        expectedVersion,
        metadata: updatedWireValue,
      });

      if (ack && ack.result === 'success') {
        const next = asRecord(decryptStoredSessionPayload({ mode, ctx, value: String(ack.metadata ?? '') }));
        return { version: ack.version, metadata: next ?? updated };
      }

      if (ack && ack.result === 'version-mismatch') {
        expectedVersion = ack.version;
        currentWireValue = String(ack.metadata ?? '').trim();
        const next = asRecord(decryptStoredSessionPayload({ mode, ctx, value: currentWireValue }));
        if (next) currentDecrypted = next;
        // small backoff to reduce tight contention
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, Math.min(50 * (attempt + 1), 250)));
        }
        continue;
      }

      if (ack && ack.result === 'forbidden') {
        const err = new Error('Forbidden');
        (err as any).code = 'not_authenticated';
        throw err;
      }

      const err = new Error('Metadata update failed');
      (err as any).code = 'unknown_error';
      throw err;
    }

    const err = new Error('Metadata update conflict');
    (err as any).code = 'conflict';
    throw err;
  } finally {
    try {
      socket.disconnect();
      socket.close();
    } catch {
      // ignore
    }
  }
}
