import type { Socket } from 'socket.io-client';

import { createAuthenticationHttpStatusError } from '@/api/client/httpStatusError';
import { createSessionScopedSocket } from '@/api/session/sockets';
import type { Credentials } from '@/persistence';
import {
  decryptStoredSessionPayload,
  encryptStoredSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { waitForSocketConnect } from '@/session/transport/socket/waitForSocketConnect';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';

type UpdateMetadataAck =
  | { result: 'success'; version: number; metadata: string }
  | { result: 'version-mismatch'; version: number; metadata: string }
  | { result: 'forbidden' }
  | { result: 'error' };

type MetadataUpdateErrorCode = 'unsupported' | 'unknown_error' | 'conflict';

function createMetadataUpdateError(message: string, code: MetadataUpdateErrorCode): Error & { code: MetadataUpdateErrorCode } {
  return Object.assign(new Error(message), { code });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function emitUpdateMetadataWithAck(socket: Socket, payload: { sid: string; expectedVersion: number; metadata: string }): Promise<UpdateMetadataAck> {
  const res = await new Promise<UpdateMetadataAck>((resolve) => {
    socket.emit('update-metadata', payload, (answer: unknown) => resolve(answer as UpdateMetadataAck));
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
  let currentWireValue = String(params.rawSession.metadata ?? '').trim();

  const initialDecrypted = asRecord(decryptStoredSessionPayload({ mode, ctx, value: currentWireValue }));
  if (!initialDecrypted) {
    throw createMetadataUpdateError('Unsupported session metadata payload', 'unsupported');
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
        throw createAuthenticationHttpStatusError(403, 'Forbidden');
      }

      throw createMetadataUpdateError('Metadata update failed', 'unknown_error');
    }

    throw createMetadataUpdateError('Metadata update conflict', 'conflict');
  } finally {
    try {
      socket.disconnect();
      socket.close();
    } catch {
      // ignore
    }
  }
}
