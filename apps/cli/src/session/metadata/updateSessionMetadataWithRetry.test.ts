import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpStatusError, isAuthenticationError } from '@/api/client/httpStatusError';
import { updateSessionMetadataWithRetry } from './updateSessionMetadataWithRetry';

type MetadataAckCallback = (answer: unknown) => void;

class FakeMetadataSocket {
  readonly emitted: Array<Readonly<{ event: string; payload: unknown }>> = [];

  constructor(private readonly ack: unknown) {}

  connect(): void {}

  emit(event: string, payload: unknown, callback?: MetadataAckCallback): void {
    this.emitted.push({ event, payload });
    callback?.(this.ack);
  }

  disconnect(): void {}

  close(): void {}
}

const { socketRef } = vi.hoisted(() => ({
  socketRef: { current: null as FakeMetadataSocket | null },
}));

const { waitForSocketConnectMock } = vi.hoisted(() => ({
  waitForSocketConnectMock: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock('@/api/session/sockets', () => ({
  createSessionScopedSocket: () => {
    if (!socketRef.current) throw new Error('Missing fake metadata socket');
    // Socket.io is a platform boundary; this fake implements only the methods used by the unit under test.
    return socketRef.current as unknown;
  },
}));

vi.mock('@/session/transport/socket/waitForSocketConnect', () => ({
  waitForSocketConnect: waitForSocketConnectMock,
}));

vi.mock('@/session/transport/shared/sessionTimeouts', () => ({
  resolveSessionControlSocketConnectTimeoutMs: () => 10,
}));

describe('updateSessionMetadataWithRetry', () => {
  beforeEach(() => {
    socketRef.current = null;
    waitForSocketConnectMock.mockReset();
    waitForSocketConnectMock.mockResolvedValue(undefined);
  });

  it('classifies forbidden metadata acks as canonical authentication errors', async () => {
    const socket = new FakeMetadataSocket({ result: 'forbidden' });
    socketRef.current = socket;

    let caught: unknown;
    try {
      await updateSessionMetadataWithRetry({
        token: 'token-1',
        credentials: {
          token: 'token-1',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        sessionId: 'sess_forbidden',
        rawSession: {
          metadata: '{}',
          metadataVersion: 1,
          encryptionMode: 'plain',
          dataEncryptionKey: null,
        },
        updater: (metadata) => ({ ...metadata, title: 'updated' }),
        maxAttempts: 1,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpStatusError);
    expect(caught).toMatchObject({
      response: { status: 403 },
      code: 'not_authenticated',
    });
    expect(isAuthenticationError(caught)).toBe(true);
    expect(socket.emitted).toHaveLength(1);
  });

  it('classifies socket connect authentication failures before metadata acks', async () => {
    const socket = new FakeMetadataSocket({ result: 'success', version: 2, metadata: '{}' });
    socketRef.current = socket;
    const socketAuthError = Object.assign(new Error('invalid token'), {
      data: {
        statusCode: 401,
        error: 'invalid-token',
      },
    });
    waitForSocketConnectMock.mockRejectedValue(socketAuthError);

    let caught: unknown;
    try {
      await updateSessionMetadataWithRetry({
        token: 'token-1',
        credentials: {
          token: 'token-1',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        sessionId: 'sess_connect_auth',
        rawSession: {
          metadata: '{}',
          metadataVersion: 1,
          encryptionMode: 'plain',
          dataEncryptionKey: null,
        },
        updater: (metadata) => ({ ...metadata, title: 'updated' }),
        maxAttempts: 1,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(socketAuthError);
    expect(isAuthenticationError(caught)).toBe(true);
    expect(socket.emitted).toHaveLength(0);
  });
});
